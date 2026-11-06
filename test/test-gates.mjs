/**
 * Gate tests: item 1 (`sendMilestones` toggle) + item 3 (`autoConnect`)
 * driven through the full extension factory the way Pi loads it, with a
 * fake `mtx` binary recording every send. Each phase gets its own fake
 * state dir, so send counts are independent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";
import { getActiveOutbox } from "./fake-outbox.mjs";

const jiti = await createPiJiti(import.meta.url);

// ---- fake outbox setup (TO-BE Slice 6: the seam replaced the shell-spawn recording) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-gates-"));
function freshState(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  process.env.FAKE_MTX_STATE = d;
  return d;
}
// The single transport (TO-BE Slice 6): the PI_MATRIX_TEST_OUTBOX seam —
// the fake outbox stands in for the SdkOutbox; its state-file call logs
// are the send/read recording (state-file call logs). The shell-spawn
// binary + its read-transport pin are gone.
process.env.PI_MATRIX_TEST_OUTBOX = path.join(EXT_DIR, "test", "fake-outbox.mjs");
// Suite-wide flat default: thread writes are only meaningful in the
// explicit threads phase (which sets PI_MATRIX_THREADS=true +
// FAKE_OUTBOX_FAIL_THREADS=1 for the degraded path). With the fake
// outbox ALWAYS succeeding (unlike the hermetic matrix-http outbox of
// the pre-cutover suite, which was unavailable → §2.11 flat degrade),
// leaving threads on would soft-attach the pending-session milestones to
// the shared thread-map's latest root and the fake would log thread-reply
// tokens where the assertions expect the flat send body.
process.env.PI_MATRIX_THREADS = "false";
// Hermetic credentials + log (no real homeserver connection in any phase).
// The config derives userId/homeserver from the credentials file
// (DESIGN-TRANSPORT-AND-IDENTITY §2.1), so a missing file fails validation
// and the factory early-returns (no registrations) — write a fake file.
const fakeCreds = path.join(tmp, "credentials.json");
fs.writeFileSync(
  fakeCreds,
  JSON.stringify({ user_id: "@pi_agent:test.example.org", homeserver: "test.example.org" }, null, 2),
);
process.env.PI_MATRIX_CREDENTIALS_PATH = fakeCreds;
process.env.PI_MATRIX_LOG_PATH = path.join(tmp, "gates-matrix.log");

/** The fake outbox's JSON-line call log (one line per call; send bodies
 * are multi-line, so the entries are JSON objects: `{ b: body, h: html }`). */
const logCount = (d, name) =>
  fs.existsSync(path.join(d, `${name}.log`))
    ? fs.readFileSync(path.join(d, `${name}.log`), "utf8").split("\n").filter(Boolean).length
    : 0;
const sendLog = (d) => {
  const p = path.join(d, "send.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const o = JSON.parse(l);
        return { body: o.b, html: o.h ?? null };
      } catch {
        const [b, h] = l.split("\t"); // pre-JSON-line plain format
        return { body: b, html: h ?? null };
      }
    });
};
const sendCount = (d) => sendLog(d).length;
/** Settle signal: the fake's connect() call log (the mtx read-count /
 * dry-mode settle analog, §11) — a line appears once connectAndStart ran. */
const readCount = (d) => logCount(d, "connect");
/** The last recorded send body (the JSON entry's `b` field; the multi-line
 * candidate-list bodies come back whole). */
const lastSend = (d) => {
  const a = sendLog(d);
  return a.length ? a[a.length - 1].body : null;
};

// ---- mock ExtensionAPI / ctx (subset of repro.mjs, with notify capture) ------
function createMockApi() {
  const extension = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    messageRenderers: new Map(),
  };
  const api = {
    on(event, handler) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },
    registerTool(tool) {
      extension.tools.set(tool.name, tool);
    },
    registerCommand(name, options) {
      extension.commands.set(name, options);
    },
    registerMessageRenderer(type, renderer) {
      extension.messageRenderers.set(type, renderer);
    },
    // pi event bus: the factory subscribes rpiv:ask-user:* on pi.events
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
  };
  // item 9 (slash relay): the relay dispatches via these two APIs
  const userMessageCalls = [];
  const customMessageCalls = [];
  api.getCommands = () => [
    { name: "matrix-status" },
    { name: "matrix-connect" },
    { name: "matrix-toggle" },
    { name: "matrix-disconnect" },
    { name: "matrix-help" },
    { name: "pi-help" },
    { name: "skill:discover" },
  ];
  api.sendUserMessage = (content, options) => {
    userMessageCalls.push({ content: String(content), options });
  };
  api.sendMessage = (message, options) => {
    customMessageCalls.push({ message, options });
  };
  return { api, extension, userMessageCalls, customMessageCalls };
}

// Room event (sender vincent, the room's alias like the test-logic baseline):
// pushed through the fake outbox's delivery callbacks (the funnel).
let evtSeq = 0;
function addRoomEvent(stateDir, body) {
  getActiveOutbox().pushRoomEvent({
    eventId: `$evt-X${++evtSeq}-${Date.now()}`,
    sender: "@vincent:test.example.org",
    timestamp: Date.now(),
    body,
    isFromPi: false,
  });
}

function makeCtx(notifications) {
  return {
    ui: {
      setStatus() {},
      setWidget() {},
      notify(msg, kind) {
        notifications.push({ msg: String(msg), kind });
      },
      select: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve(undefined),
    },
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      buildContextEntries: () => [],
      getLeafId: () => undefined,
    },
    signal: undefined,
  };
}

const CONNECT_NOTIFY = /Connected to Matrix|Failed to connect/;

// ---- load the factory -----------------------------------------------------------
const { check, finish } = makeCheck("GATES");
const factory = await jiti.import(path.join(EXT_DIR, "index.ts"), { default: true });

async function runPhase(label, env, stateName, run) {
  console.log(`== ${label} ==`);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const state = freshState(stateName);
  const { api, extension, userMessageCalls, customMessageCalls } = createMockApi();
  await factory(api);
  const h = {
    sessionStart: (extension.handlers.get("session_start") ?? []).at(-1),
    sessionCompact: (extension.handlers.get("session_compact") ?? []).at(-1),
    sessionCompactFailed: (extension.handlers.get("session_compact_failed") ?? []).at(-1),
    modelSelect: (extension.handlers.get("model_select") ?? []).at(-1),
    thinkingLevelSelect: (extension.handlers.get("thinking_level_select") ?? []).at(-1),
    messageEnd: (extension.handlers.get("message_end") ?? []).at(-1),
    turnEnd: (extension.handlers.get("turn_end") ?? []).at(-1),
    input: (extension.handlers.get("input") ?? []).at(-1),
    shutdown: (extension.handlers.get("session_shutdown") ?? []).at(-1),
    commands: extension.commands,
  };
  const notes = [];
  const ctx = makeCtx(notes);
  await run(h, ctx, notes, state, { userMessageCalls, customMessageCalls });
  await h.shutdown({ type: "session_shutdown" }, ctx);
  return { state, notes };
}

// ---------------------------------------------------------------------------
// Phase 1: sendMilestones=false (env) — autoConnect stays default (true)
// ---------------------------------------------------------------------------
{
  await runPhase(
    "sendMilestones=false (env)",
    {
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: undefined,
      // Explicitly turn off session milestones too — this phase is about the
      // heuristic (marker) auto-broadcasts, not lifecycle events.
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
    },
    "phase1",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      check(
        "autoConnect default: session_start attempts connect",
        n.some((x) => CONNECT_NOTIFY.test(x.msg)),
        JSON.stringify(n),
      );
      await h.messageEnd(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Milestone: phase one done" }] },
        },
        ctx,
      );
      await h.turnEnd(
        {
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text: "TODO: progress on task 1" }] },
        },
        ctx,
      );
      check(
        "sendMilestones=false: no milestone/TODO send recorded",
        sendCount(state) === 0,
        String(sendCount(state)),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 2: autoConnect=false — no connect at session start; manual
// /matrix-connect enables it; the default-on sendMilestones then fires.
// ---------------------------------------------------------------------------
{
  await runPhase(
    "autoConnect=false + sendMilestones default",
    {
      PI_MATRIX_SEND_MILESTONES: undefined,
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "false",
      // This phase tests the heuristic marker path; keep lifecycle milestones
      // off so the send counts are exact.
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
    },
    "phase2",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      check(
        "autoConnect=false: no connect attempt at session start",
        !n.some((x) => CONNECT_NOTIFY.test(x.msg)),
        JSON.stringify(n),
      );

      // manual connect (the /matrix-connect path)
      await h.commands.get("matrix-connect").handler("", ctx);
      check(
        "/matrix-connect connects",
        n.some((x) => x.msg.startsWith("Connected to Matrix!")),
        JSON.stringify(n),
      );

      await h.messageEnd(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Milestone: phase two done" }] },
        },
        ctx,
      );
      check(
        "sendMilestones default: marker sent via message_end",
        sendCount(state) === 1 && lastSend(state)?.startsWith("🎯 Milestone: phase two done"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      await h.turnEnd(
        {
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text: "TODO: progress on task 2" }] },
        },
        ctx,
      );
      check(
        "TODO marker sent via turn_end",
        sendCount(state) === 2 && lastSend(state)?.includes("TODO progress: on task 2"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 3: all defaults (autoConnect=true, sendMilestones=true) — session
// start connects AND heuristics fire (the out-of-the-box behavior).
//
// The default `sendSessionMilestones: true` means a session milestone
// ("Pi session started") is sent on connect. The send counts below account
// for that: after session_start there is already 1 send (the session
// milestone), and the message_end marker scan adds another.
// ---------------------------------------------------------------------------
{
  await runPhase(
    "all defaults",
    {
      PI_MATRIX_SEND_MILESTONES: undefined,
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
      // Reset the lifecycle-milestone toggles to their code defaults (true)
      // — earlier phases set them to "false" and `runPhase` only clears
      // keys it is explicitly told to; an unlisted key keeps its value.
      PI_MATRIX_SEND_SESSION_MILESTONES: undefined,
      PI_MATRIX_SEND_COMPACT_MILESTONES: undefined,
      PI_MATRIX_SEND_MODEL_MILESTONES: undefined,
    },
    "phase3",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      check(
        "autoConnect=true: session start connects",
        n.some((x) => x.msg.startsWith("Connected to Matrix!")),
        JSON.stringify(n),
      );
      // Default: session milestone sent on connect
      check(
        "sendSessionMilestones default: session milestone sent on connect",
        sendCount(state) === 1 && lastSend(state)?.includes("Pi session started"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
      await h.messageEnd(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Milestone: phase three done" }] },
        },
        ctx,
      );
      check(
        "default behavior: marker sent after session start",
        sendCount(state) === 2 && lastSend(state)?.startsWith("🎯 Milestone: phase three done"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // MTX_ALLOW_PROD gate dropped (Slice 6, Design History): the
      // prod-mutation guard was a `mtx` shell-spawn env of the deleted
      // facade — no SdkOutbox analogue.

      // Marker quoted mid-line (table cells / backticks / prose) must NOT fire
      await h.messageEnd(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: "| Path | Trigger |\n|---|---|\n| Auto-milestone | scans for `Milestone: …` markers | gate |\n| TODO row | `turn_end` scans for `todo progress: …` markers |\nRunning prose mentioning the Milestone: format stays inert.",
            }],
          },
        },
        ctx,
      );
      check(
        "mid-line marker quotes stay inert",
        sendCount(state) === 2,
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // Line-start markers still fire
      await h.messageEnd(
        {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Milestone: line-start marker fires\nfollow-up detail" }] },
        },
        ctx,
      );
      check(
        "line-start marker still fires",
        sendCount(state) === 3 && lastSend(state)?.startsWith("🎯 Milestone: line-start marker fires"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 4: slash relay (item 9) — known commands dispatch, unknown ones get
// a plain-text fuzzy-suggestion reply, no-candidate ones inject as text.
// ---------------------------------------------------------------------------
{
  await runPhase(
    "slash relay (item 9)",
    {
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase4-slash",
    async (h, ctx, n, state, caps) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);

      // Let connect()'s baseline read settle before we seed events, or the
      // first event would be swallowed by the baseline (remembered, not emitted).
      await waitUntil(() => readCount(state) > 0, { label: "baseline read to settle" });

      // 1. known command → sendUserMessage dispatch (expandPromptTemplates)
      addRoomEvent(state, "/matrix-status");
      await waitUntil(
        () => caps.userMessageCalls.some((c) => c.content === "/matrix-status"),
        { label: "/matrix-status dispatched via sendUserMessage" },
      );
      check(
        "known /command dispatched via sendUserMessage",
        caps.userMessageCalls.some(
          (c) => c.content === "/matrix-status" && c.options?.expandPromptTemplates === true,
        ),
        JSON.stringify(caps.userMessageCalls),
      );
      check(
        "dispatched command not double-injected as text",
        caps.customMessageCalls.length === 0,
        String(caps.customMessageCalls.length),
      );

      // 2. typo → plain-text fuzzy suggestion reply in the room
      addRoomEvent(state, "/matrci-status");
      await waitUntil(
        () => (lastSend(state) || "").includes("did you mean"),
        { label: "fuzzy-suggestion reply in the room" },
      );
      check(
        "typo command gets fuzzy suggestion reply",
        (lastSend(state) || "").includes("did you mean") && (lastSend(state) || "").includes("/matrix-status"),
        String(lastSend(state)),
      );
      check(
        "typo command not dispatched, not injected",
        caps.userMessageCalls.length === 1 && caps.customMessageCalls.length === 0,
        JSON.stringify({ u: caps.userMessageCalls.length, c: caps.customMessageCalls.length }),
      );

      // 3. unknown with no candidates → normal attributed injection
      addRoomEvent(state, "/zzz nothing matches");
      await waitUntil(
        () => caps.customMessageCalls.some((c) => String(c.message?.content ?? "").includes("/zzz")),
        { label: "no-candidate command injection" },
      );
      check(
        "no-candidate command injected as plain text",
        caps.customMessageCalls.some((c) => String(c.message?.content ?? "").includes("/zzz")),
        JSON.stringify(caps.customMessageCalls.map((c) => c.message?.content)),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 5: file attach (item 10) — @token picker + 10a expansion.
//
// pickFiles (git ls-files ∩ case-sensitive substring) is exercised for real:
// chdir into a temp git repo with three src/ files; cwd is restored after.
//
// Fragment note: the picker fragment must be a case-sensitive substring of
// all three paths to produce a 3-match list — "@src/" does that. (The design
// doc's "@mar" example is NOT a substring of matrix-client / message-handler,
// only of markdown; the contract's substring rule is the binding one.)
// ---------------------------------------------------------------------------
{
  const gitDir = path.join(tmp, "git-item10");
  fs.mkdirSync(path.join(gitDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "src/matrix-client.ts"), "matrix-client-content");
  fs.writeFileSync(path.join(gitDir, "src/message-handler.ts"), "message-handler-content");
  fs.writeFileSync(path.join(gitDir, "src/markdown.ts"), "markdown-content");
  execSync("git init -q", { cwd: gitDir });
  execSync("git add .", { cwd: gitDir });

  const injectedText = (caps) => [
    ...caps.userMessageCalls.map((c) => String(c.content)),
    ...caps.customMessageCalls.map((c) => String(c.message?.content ?? "")),
  ];

  const origCwd = process.cwd();
  process.chdir(gitDir);
  try {
    await runPhase(
      "file attach picker (item 10)",
      {
        PI_MATRIX_SEND_MILESTONES: "false",
        PI_MATRIX_SEND_FINAL_MESSAGES: "false",
        PI_MATRIX_AUTO_CONNECT: "true",
        PI_MATRIX_REMOTE_FILE_PICKER: "true",
        PI_MATRIX_ATTACH_MAX_BYTES: "200000",
        PI_MATRIX_PICKER_LIMIT: "10",
      },
      "phase5-fileattach",
      async (h, ctx, n, state, caps) => {
        await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
        // Let connect()'s baseline read settle before we seed events.
        await waitUntil(() => readCount(state) > 0, { label: "baseline read to settle" });

        // 1. lone @token with 3 matches (≤ pickerLimit) → plain candidate
        //    list reply in the room; no LLM turn, no injection.
        addRoomEvent(state, "@src/");
        await waitUntil(
          () => (lastSend(state) || "").includes("src/matrix-client.ts") &&
            (lastSend(state) || "").includes("src/message-handler.ts"),
          { label: "candidate list posted to the room" },
        );
        const list = lastSend(state) || "";
        check(
          "lone @token with 3 matches → plain candidate list in the room",
          list.includes("src/matrix-client.ts") &&
            list.includes("src/message-handler.ts") &&
            list.includes("src/markdown.ts"),
          list,
        );
        check(
          "candidate list is numbered and instructs the reply protocol",
          /\n\s*1\./.test(list) && /\n\s*2\./.test(list) && /Reply with the exact path/i.test(list),
          list,
        );
        check(
          "candidate list is plain text (no html / markdown)",
          list.length > 0 && !/<[^>]*>/.test(list) && !list.includes("**"),
          list,
        );
        check(
          "no LLM turn: picker auto-reply bypasses the session",
          caps.userMessageCalls.length === 0 && caps.customMessageCalls.length === 0,
          JSON.stringify({ u: caps.userMessageCalls.length, c: caps.customMessageCalls.length }),
        );

        // 2. numbered reply "2" → 2nd match (ranked by path length:
        //    markdown 15 < matrix-client 20 < message-handler 22)
        addRoomEvent(state, "2");
        await waitUntil(
          () => injectedText(caps).some((t) => t.includes("@@ file: src/matrix-client.ts")),
          { label: "reply '2' expanded injection" },
        );
        check(
          "reply '2' injects the 2nd match expanded",
          injectedText(caps).some(
            (t) => t.includes("@@ file: src/matrix-client.ts") && t.includes("matrix-client-content"),
          ),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 160))),
        );

        // 3. known path → 10a expansion
        addRoomEvent(state, "@src/markdown.ts");
        await waitUntil(
          () => injectedText(caps).some((t) => t.includes("@@ file: src/markdown.ts")),
          { label: "known @path expanded injection" },
        );
        check(
          "known @path injects expanded content",
          injectedText(caps).some(
            (t) => t.includes("@@ file: src/markdown.ts") && t.includes("markdown-content"),
          ),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 160))),
        );

        // 4. outside-cwd token → kept verbatim + note, no crash
        addRoomEvent(state, "@/etc/hosts");
        await waitUntil(
          () => injectedText(caps).some((t) => t.includes("@/etc/hosts")),
          { label: "outside-cwd token injection" },
        );
        check(
          "outside-cwd @token kept verbatim with a note",
          injectedText(caps).some((t) => t.includes("@/etc/hosts") && /note/i.test(t)),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 160))),
        );
        // Step 4 also fired the async 0-matches nudge room send (the handler
        // fire-and-forgets it). Drain it before step 6's baseline — an
        // in-flight stale send would land in step 6's window and satisfy
        // its `sendsBefore + 1` count with the wrong message.
        await waitUntil(
          () => (lastSend(state) || "").includes("No file matches for @/etc/hosts"),
          { label: "step-4 no-matches nudge send drained" },
        );

        // 5. exact-path reply resolves against the LAST posted list
        addRoomEvent(state, "src/message-handler.ts");
        await waitUntil(
          () => injectedText(caps).some((t) => t.includes("@@ file: src/message-handler.ts")),
          { label: "exact-path reply expanded injection" },
        );
        check(
          "exact-path reply injects the matching last-list entry expanded",
          injectedText(caps).some(
            (t) => t.includes("@@ file: src/message-handler.ts") && t.includes("message-handler-content"),
          ),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 160))),
        );

        // 6. 0 matches → plain "longer fragment" nudge in the room, and the
        //    token is injected verbatim + note so the LLM sees the attempt.
        const sendsBefore0 = sendCount(state);
        addRoomEvent(state, "@zzz-none");
        await waitUntil(
          () => sendCount(state) === sendsBefore0 + 1 &&
            injectedText(caps).some((t) => t.includes("@zzz-none")),
          { label: "no-matches nudge + verbatim injection" },
        );
        check(
          "0 matches → plain no-matches nudge in the room",
          sendCount(state) === sendsBefore0 + 1 &&
            lastSend(state).includes("No file matches for @zzz-none") &&
            /longer fragment/i.test(lastSend(state)),
          JSON.stringify({ sent: sendCount(state) - sendsBefore0, last: lastSend(state).slice(0, 160) }),
        );
        check(
          "0 matches → token injected verbatim + note",
          injectedText(caps).some((t) => t.includes("@zzz-none") && /note/i.test(t)),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 160))),
        );
      },
    );

    await runPhase(
      "file attach picker over limit (item 10)",
      {
        PI_MATRIX_SEND_MILESTONES: "false",
        PI_MATRIX_SEND_FINAL_MESSAGES: "false",
        PI_MATRIX_AUTO_CONNECT: "true",
        PI_MATRIX_REMOTE_FILE_PICKER: "true",
        PI_MATRIX_ATTACH_MAX_BYTES: "200000",
        PI_MATRIX_PICKER_LIMIT: "2", // 3 matches > limit
      },
      "phase5c-filelimit",
      async (h, ctx, n, state, caps) => {
        await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
        await waitUntil(() => readCount(state) > 0, { label: "baseline read to settle" });

        const sendsBefore = sendCount(state);
        addRoomEvent(state, "@src/");
        await waitUntil(
          () => sendCount(state) === sendsBefore + 1,
          { label: "over-limit auto-reply send" },
        );
        check(
          "> pickerLimit → the top pickerLimit are listed, and the list says it is partial",
          sendCount(state) === sendsBefore + 1 &&
            lastSend(state).includes("1. src/markdown.ts") &&
            lastSend(state).includes("2. src/matrix-client.ts") &&
            /Showing the first 2 of 3/.test(lastSend(state)) &&
            !lastSend(state).includes("src/message-handler.ts") &&
            caps.userMessageCalls.length === 0 &&
            caps.customMessageCalls.length === 0,
          JSON.stringify({ sent: sendCount(state) - sendsBefore, last: lastSend(state).slice(0, 200) }),
        );

        // The cut must be real, not cosmetic: a number resolves against what the
        // room was SHOWN, so #3 (never posted) cannot attach anything.
        const injBefore = injectedText(caps).length;
        addRoomEvent(state, "2");
        await waitUntil(
          () => injectedText(caps).length > injBefore,
          { label: "numbered reply to inject the 2nd shown file" },
        );
        check(
          "reply '2' after a truncated list → the 2nd SHOWN file is attached",
          injectedText(caps).some((t) => t.includes("matrix-client-content")) &&
            !injectedText(caps).some((t) => t.includes("message-handler-content")),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 90))),
        );

        const injBefore3 = injectedText(caps).length;
        addRoomEvent(state, "3");
        await waitUntil(
          () => caps.userMessageCalls.length > 0 || injectedText(caps).length > injBefore3,
          { label: "out-of-range reply falls through as an ordinary message" },
        );
        check(
          "reply '3' (cut off the list) attaches nothing — it is an ordinary message",
          !injectedText(caps).some((t) => t.includes("message-handler-content")),
          JSON.stringify(injectedText(caps).map((t) => t.slice(0, 90))),
        );

        // Glob fragment, end to end: only an executed room message proves the
        // picker accepts `*` as a token AND hands it to the matcher. Chosen
        // deliberately: src/message-handler.ts is the match the truncated list
        // above cut off, so a glob that reaches it proves the fragment went
        // through the matcher and not through the last posted list.
        const sendsBeforeGlob = sendCount(state);
        const injBeforeGlob = injectedText(caps).length;
        addRoomEvent(state, "@*message*.ts");
        await waitUntil(
          () => sendCount(state) === sendsBeforeGlob + 1,
          { label: "single-match glob to answer with a menu" },
        );
        check(
          "'@*message*.ts' is a picker token, and ONE match still gets a menu — nothing attaches",
          lastSend(state).includes("1. src/message-handler.ts") &&
            /Reply with the exact path/i.test(lastSend(state)) &&
            injectedText(caps).length === injBeforeGlob,
          JSON.stringify({ last: lastSend(state).slice(0, 160), injected: injectedText(caps).length - injBeforeGlob }),
        );

        addRoomEvent(state, "1");
        await waitUntil(
          () => injectedText(caps).length > injBeforeGlob,
          { label: "menu reply to attach the single candidate" },
        );
        check(
          "reply '1' attaches the file the truncated list above had cut off",
          injectedText(caps).slice(injBeforeGlob).some((t) => t.includes("message-handler-content")),
          JSON.stringify(injectedText(caps).slice(injBeforeGlob).map((t) => t.slice(0, 120))),
        );
      },
    );

    await runPhase(
      "file attach off (item 10 default)",
      {
        PI_MATRIX_SEND_MILESTONES: "false",
        PI_MATRIX_SEND_FINAL_MESSAGES: "false",
        PI_MATRIX_AUTO_CONNECT: "true",
        PI_MATRIX_REMOTE_FILE_PICKER: "false", // force off regardless of the live config file (env > file)
        PI_MATRIX_ATTACH_MAX_BYTES: undefined,
        PI_MATRIX_PICKER_LIMIT: undefined,
        // This phase tests the fileAttach off path; keep lifecycle
        // milestones off so the send count stays at 0.
        PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      },
      "phase5b-fileoff",
      async (h, ctx, n, state, caps) => {
        await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
        await waitUntil(() => readCount(state) > 0, { label: "baseline read to settle" });

        addRoomEvent(state, "@src/markdown.ts");
        await waitUntil(
          () => caps.customMessageCalls.some((c) => String(c.message?.content ?? "").includes("@src/markdown.ts")),
          { label: "plain-text @path injection (attach off)" },
        );
        check(
          "fileAttach off: @path injected as plain text",
          caps.customMessageCalls.some((c) => String(c.message?.content ?? "").includes("@src/markdown.ts")),
          JSON.stringify(caps.customMessageCalls.map((c) => c.message?.content)),
        );
        check(
          "fileAttach off: no expansion, no auto-reply",
          !injectedText(caps).some((t) => t.includes("@@ file:")) &&
            caps.userMessageCalls.length === 0 &&
            sendCount(state) === 0,
          JSON.stringify({ sent: sendCount(state), n: injectedText(caps).length }),
        );
      },
    );
  } finally {
    process.chdir(origCwd);
  }
}

// matrix-help (end-user guide) — invoking the command posts the guide to the room.
// Runs at the normal cwd (no git-repo chdir needed); the send is captured by
// the fake outbox regardless of connection state.
await runPhase(
  "matrix-help (end-user guide)",
  {
    PI_MATRIX_SEND_MILESTONES: "false",
    PI_MATRIX_SEND_FINAL_MESSAGES: "false",
    PI_MATRIX_AUTO_CONNECT: "true",
    PI_MATRIX_REMOTE_FILE_PICKER: "true",
    // TO-BE Phase 2 declared delta: the /matrix-help writer rides the
    // pipeline dedupe window (messageHandler.post) — a 0 window keeps the
    // alias-post expectation (a real second send) deterministic.
    PI_MATRIX_DEDUPE_WINDOW_MS: "0",
  },
  "phase-help",
  async (h, ctx, n, state, caps) => {
    check(
      "matrix-help + pi-help commands are registered",
      h.commands.has("matrix-help") && h.commands.has("pi-help"),
      JSON.stringify([...h.commands.keys()]),
    );
    await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => readCount(state) > 0, { label: "baseline read to settle" });
    const before = sendCount(state);
    await h.commands.get("matrix-help").handler("", ctx);
    await waitUntil(
      () => sendCount(state) === before + 1,
      { label: "guide posted to the room" },
    );
    const guide = lastSend(state);
    check(
      "/matrix-help posts the guide to the room",
      sendCount(state) === before + 1 &&
        typeof guide === "string" &&
        guide.includes("Matrix–Pi Integration") &&
        guide.includes("/pi-help"),
      JSON.stringify({ sent: sendCount(state) - before, head: guide?.slice(0, 80) }),
    );
    check(
      "guide reflects the live config (fileAttach on here → picker available)",
      /Attach a file with @/.test(guide) && !/disabled in this deployment/.test(guide),
      JSON.stringify(guide?.split("\n").find((l) => l.startsWith("3.")) ?? ""),
    );

    // pi-help alias shares the same handler → also posts the guide.
    const before2 = sendCount(state);
    await h.commands.get("pi-help").handler("", ctx);
    await waitUntil(
      () => sendCount(state) === before2 + 1,
      { label: "pi-help alias posted to the room" },
    );
    check(
      "/pi-help (alias) posts the guide to the room too",
      sendCount(state) === before2 + 1 &&
        (lastSend(state) ?? "").includes("Matrix–Pi Integration"),
      JSON.stringify({ sent: sendCount(state) - before2, head: lastSend(state)?.slice(0, 60) }),
    );

    // Room relay: typing /pi-help in the room dispatches via sendUserMessage.
    addRoomEvent(state, "/pi-help");
    await waitUntil(
      () => caps.userMessageCalls.some((c) => c.content === "/pi-help"),
      { label: "room-typed /pi-help dispatch" },
    );
    check(
      "room-typed /pi-help dispatches via sendUserMessage (slash relay)",
      caps.userMessageCalls.some(
        (c) => c.content === "/pi-help" && c.options?.expandPromptTemplates === true,
      ),
      JSON.stringify(caps.userMessageCalls.map((c) => c.content)),
    );

    // Agent-directed help: '@pi_agent: help' routes to the help command under the hood.
    addRoomEvent(state, "@pi_agent: help");
    await waitUntil(
      () => caps.userMessageCalls.some((c) => c.content === "/matrix-help"),
      { label: "'@pi_agent: help' routed to /matrix-help" },
    );
    check(
      "room-typed '@pi_agent: help' routes to /matrix-help under the hood",
      caps.userMessageCalls.some(
        (c) => c.content === "/matrix-help" && c.options?.expandPromptTemplates === true,
      ),
      JSON.stringify(caps.userMessageCalls.map((c) => c.content)),
    );
  },
);

// ---------------------------------------------------------------------------
// Lifecycle milestone triggers (sendSessionMilestones /
// sendCompactMilestones / sendModelMilestones).
//
// Verifies that the new event handlers (session_start with reason, session_compact,
// session_compact_failed, model_select, thinking_level_select) each push a
// short "Pi did X" line to the room when their respective toggle is on,
// and that each toggle independently gates its milestone sends.
// ---------------------------------------------------------------------------
{
  await runPhase(
    "lifecycle milestones: all toggles on",
    {
      PI_MATRIX_SEND_SESSION_MILESTONES: "true",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "true",
      PI_MATRIX_SEND_MODEL_MILESTONES: "true",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-milestones-on",
    async (h, ctx, n, state) => {
      // 1. Session start (reason: startup)
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      check(
        "session milestone on startup: 'Pi session started' sent",
        sendCount(state) === 1 && lastSend(state)?.includes("Pi session started"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 2. Session compact (manual)
      await h.sessionCompact({
        type: "session_compact",
        compactionEntry: { entryId: "compact-1" },
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      }, ctx);
      check(
        "compact milestone on /compact: 'Pi compacted context' sent",
        sendCount(state) === 2 && lastSend(state)?.includes("Pi compacted context"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 3. Session compact (overflow with retry)
      await h.sessionCompact({
        type: "session_compact",
        compactionEntry: { entryId: "compact-2" },
        fromExtension: false,
        reason: "overflow",
        willRetry: true,
      }, ctx);
      check(
        "compact milestone on overflow+retry: 'overflow recovery' + retry note",
        sendCount(state) === 3 &&
          lastSend(state)?.includes("overflow") &&
          lastSend(state)?.includes("retrying the aborted turn"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 4. Session compact failed (aborted)
      await h.sessionCompactFailed({
        type: "session_compact_failed",
        reason: "manual",
        aborted: true,
        willRetry: false,
        fromExtension: false,
      }, ctx);
      check(
        "compact-failed milestone: 'Pi failed to compact context (aborted)'",
        sendCount(state) === 4 && lastSend(state)?.includes("failed to compact"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 5. Model select
      await h.modelSelect({
        type: "model_select",
        model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
        previousModel: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        source: "set",
      }, ctx);
      check(
        "model milestone: 'Pi model: openai/GPT-4o → openai/GPT-5'",
        sendCount(state) === 5 &&
          lastSend(state)?.includes("openai/GPT-4o") &&
          lastSend(state)?.includes("openai/GPT-5"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 6. Thinking level select
      await h.thinkingLevelSelect({
        type: "thinking_level_select",
        level: "high",
        previousLevel: "medium",
      }, ctx);
      check(
        "thinking-level milestone: 'Pi thinking level: medium → high'",
        sendCount(state) === 6 && lastSend(state)?.includes("thinking level"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // Regression (7da0d17 side effect): internal milestones carried routing
      // markers (type: "session" etc.) in the metadata bag; formatForMatrix
      // then printed them as a raw-JSON "Details:" tail. No marker belongs in
      // the room. These fixtures are lifecycle-only, so their bodies carry no
      // tail at all — the shape check next is what also covers the
      // agent-authored half: `matrix_send_milestone` hands the model's
      // `details` object over, and while the renderer lived in the metadata
      // bag every such milestone arrived as `Details: {…}` JSON. The payload
      // path itself is asserted in test/logic/00-core.mjs
      // (== milestone details ==).
      check(
        "lifecycle milestones carry no raw-JSON Details tail",
        sendLog(state).every((e) => !String(e.body).includes("Details:")),
        JSON.stringify(sendLog(state).map((e) => e.body)),
      );
      check(
        "no body in this phase carries a JSON-shaped Details tail",
        sendLog(state).every((e) => !/Details:\s*[[{]/.test(String(e.body))),
        JSON.stringify(sendLog(state).map((e) => e.body)),
      );
    },
  );
}

// sendSessionMilestones off → no session milestone on connect
{
  await runPhase(
    "sendSessionMilestones=false",
    {
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "true",
      PI_MATRIX_SEND_MODEL_MILESTONES: "true",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-session-off",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      check(
        "sendSessionMilestones=false: no session milestone on connect",
        sendCount(state) === 0,
        String(sendCount(state)),
      );
      // But compact milestones still work when enabled
      await h.sessionCompact({
        type: "session_compact",
        compactionEntry: { entryId: "c" },
        fromExtension: false,
        reason: "manual",
        willRetry: false,
      }, ctx);
      check(
        "compact milestone still fires when sendCompactMilestones=true",
        sendCount(state) === 1 && lastSend(state)?.includes("Pi compacted context"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
    },
  );
}

// sendCompactMilestones off → no compact / compact_failed milestones
{
  await runPhase(
    "sendCompactMilestones=false",
    {
      PI_MATRIX_SEND_SESSION_MILESTONES: "true",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "true",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-compact-off",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "reload" }, ctx);
      check(
        "session milestone on reload: 'Pi reloaded'",
        sendCount(state) === 1 && lastSend(state)?.includes("Pi reloaded"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
      await h.sessionCompact({
        type: "session_compact",
        compactionEntry: { entryId: "c" },
        fromExtension: false,
        reason: "threshold",
        willRetry: false,
      }, ctx);
      check(
        "sendCompactMilestones=false: compact milestone NOT sent",
        sendCount(state) === 1,
        String(sendCount(state)),
      );
      await h.sessionCompactFailed({
        type: "session_compact_failed",
        reason: "manual",
        aborted: false,
        errorMessage: "boom",
        willRetry: false,
        fromExtension: false,
      }, ctx);
      check(
        "sendCompactMilestones=false: compact-failed milestone NOT sent",
        sendCount(state) === 1,
        String(sendCount(state)),
      );
      // Model milestones still work
      await h.modelSelect({
        type: "model_select",
        model: { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4" },
        previousModel: undefined,
        source: "set",
      }, ctx);
      check(
        "model milestone still fires when sendModelMilestones=true",
        sendCount(state) === 2 && lastSend(state)?.includes("Pi model"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
    },
  );
}

// sendModelMilestones off → no model / thinking-level milestones
{
  await runPhase(
    "sendModelMilestones=false",
    {
      PI_MATRIX_SEND_SESSION_MILESTONES: "true",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "true",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-model-off",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "new" }, ctx);
      check(
        "session milestone on /new: 'Pi started a new session'",
        sendCount(state) === 1 && lastSend(state)?.includes("new session"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
      await h.modelSelect({
        type: "model_select",
        model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
        previousModel: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        source: "cycle",
      }, ctx);
      check(
        "sendModelMilestones=false: model milestone NOT sent",
        sendCount(state) === 1,
        String(sendCount(state)),
      );
      await h.thinkingLevelSelect({
        type: "thinking_level_select",
        level: "low",
        previousLevel: "medium",
      }, ctx);
      check(
        "sendModelMilestones=false: thinking-level milestone NOT sent",
        sendCount(state) === 1,
        String(sendCount(state)),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// sendUserMessages (terminal-typed user prompt broadcast).
//
// Verifies the `input` event handler:
// - terminal-typed input (source "interactive") → "🧑 User: …" send
// - Matrix-relayed input (source "extension")   → no send (no echo loop)
// - empty/whitespace input                       → no send
// - sendUserMessages=false                       → no send even when interactive
// ---------------------------------------------------------------------------
{
  await runPhase(
    "sendUserMessages default (interactive only)",
    {
      PI_MATRIX_SEND_USER_MESSAGES: "true",
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-user-msg-on",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      // 1. terminal-typed input → "🧑 User: …" send
      await h.input({
        type: "input",
        text: "fix the login bug",
        source: "interactive",
      }, ctx);
      check(
        "user message on terminal input: '🧑 User: …' sent",
        sendCount(state) === 1 && lastSend(state)?.includes("🧑 User:") && lastSend(state)?.includes("fix the login bug"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );

      // 2. Matrix-relayed input (source "extension") → NO send (no echo loop)
      await h.input({
        type: "input",
        text: "this came from the room",
        source: "extension",
      }, ctx);
      check(
        "Matrix-relayed input (source extension): NOT re-sent to the room",
        sendCount(state) === 1,
        String(sendCount(state)),
      );

      // 3. empty / whitespace input → no send
      await h.input({
        type: "input",
        text: "   ",
        source: "interactive",
      }, ctx);
      check(
        "empty terminal input: no send",
        sendCount(state) === 1,
        String(sendCount(state)),
      );

      // 4. another terminal-typed input → new send (distinct content)
      await h.input({
        type: "input",
        text: "and now deploy it",
        source: "interactive",
      }, ctx);
      check(
        "second terminal input: another '🧑 User: …' send",
        sendCount(state) === 2 && lastSend(state)?.includes("and now deploy it"),
        JSON.stringify({ c: sendCount(state), last: lastSend(state) }),
      );
    },
  );
}

{
  await runPhase(
    "sendUserMessages=false",
    {
      PI_MATRIX_SEND_USER_MESSAGES: "false",
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "phase-user-msg-off",
    async (h, ctx, n, state) => {
      await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
      await h.input({
        type: "input",
        text: "a terminal-typed prompt",
        source: "interactive",
      }, ctx);
      check(
        "sendUserMessages=false: terminal input NOT sent",
        sendCount(state) === 0,
        String(sendCount(state)),
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Phase N: threading (DESIGN-ROOM-THREADING) — threads on, thread writes
// failing (FAKE_OUTBOX_FAIL_THREADS=1, the seam analogue of the pre-cutover
// "matrix-http outbox unavailable" hermeticity): the pending session's first
// user message attempts root creation, degrades to a flat send (§2.11),
// and /matrix-status shows the thread state.
// ---------------------------------------------------------------------------
{
  await runPhase(
    "threads=true, thread writes failing (degraded flat)",
    {
      PI_MATRIX_THREADS: "true",
      FAKE_OUTBOX_FAIL_THREADS: "1",
      PI_MATRIX_SEND_SESSION_MILESTONES: "false",
      PI_MATRIX_SEND_COMPACT_MILESTONES: "false",
      PI_MATRIX_SEND_MODEL_MILESTONES: "false",
      PI_MATRIX_SEND_MILESTONES: "false",
      PI_MATRIX_SEND_FINAL_MESSAGES: "false",
      PI_MATRIX_SEND_USER_MESSAGES: "true",
      PI_MATRIX_AUTO_CONNECT: "true",
    },
    "threads-degraded",
    async (h, ctx, n, state, caps) => {
      await h.sessionStart({ type: "session_start", reason: "new" }, ctx);
      // First user message of the new session: thread root attempted, the
      // fake's thread writes fail (FAKE_OUTBOX_FAIL_THREADS) → degraded
      // flat send (no crash, message still lands).
      await h.input(
        { type: "input", text: "hello thread", source: "interactive" },
        ctx,
      );
      check(
        "threads on + thread writes failing: user message degrades to a flat send",
        lastSend(state)?.includes("🧑 User: hello thread"),
        JSON.stringify(lastSend(state)?.slice(0, 120)),
      );
      // /matrix-status carries the thread block.
      const notes2 = [];
      await h.commands.get("matrix-status").handler("", makeCtx(notes2));
      check(
        "/matrix-status shows the thread state",
        notes2.some((x) => /Thread:/.test(x.msg)),
        JSON.stringify(notes2.map((x) => x.msg.slice(0, 200))),
      );
      // A second user message still degrades cleanly (idempotent, no crash).
      await h.input(
        { type: "input", text: "still here", source: "interactive" },
        ctx,
      );
      check(
        "subsequent user message also lands flat",
        lastSend(state)?.includes("🧑 User: still here"),
        JSON.stringify(lastSend(state)?.slice(0, 120)),
      );
    },
  );
}

finish();
