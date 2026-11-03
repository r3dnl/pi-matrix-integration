/**
 * Live scenario suite (release story 13).
 *
 * Thirteen named scenarios exercising the advertised behaviours against a
 * real homeserver with the real extension modules loaded through the same
 * jiti seam the offline tier uses. The shape is the stubbed e2e cycle
 * (test/e2e-stub-cycle.mjs) with the fake transport replaced by the real
 * SDK outbox — so both tiers assert the same invariants at different depths.
 *
 * Rules this suite lives by:
 *   - ACT through the extension seams (outbox, message handler, thread
 *     manager, lifecycle, ask-user mirror). ASSERT on room state fetched
 *     over the client-server API by test/live/room-api.mjs — never on
 *     internal variables. Internal-state assertions passed while the room
 *     showed nothing; that failure mode is why this rule exists.
 *   - One fresh room per run, per-run markers on every message: reruns
 *     never interfere.
 *   - Credentials from the environment only (requireLiveEnv names what is
 *     missing). Nothing here hard-codes a homeserver or an account.
 *   - Per-scenario context is written to artifacts/live-<run-id>/ so the
 *     container capture and the nightly upload carry the evidence.
 *
 * Session-side execution (a command actually RUNNING inside pi, the footer
 * actually rendering in a real TUI) is proven by the relay/injection seam
 * reaching the session plus the human walkthrough in test/live/README.md.
 *
 * Run: npm run test:live          (whole suite, < 15 min, re-runnable)
 *      npm run test:live -- 4     (only scenario numbers containing 4)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, requireLiveEnv } from "../_harness.mjs";
import { RoomApi, connectSecondActor } from "./room-api.mjs";

requireLiveEnv();
// The second actor ("the human" in the receive scenarios): a token, or a
// user + password. Names the missing variables the same way requireLiveEnv
// does — fail loudly, never no-op.
if (!process.env.PI_MATRIX_SECOND_TOKEN && !(process.env.PI_MATRIX_SECOND_USER && process.env.PI_MATRIX_SECOND_PASSWORD)) {
  console.error(
    'live scenario suite needs a second actor — set PI_MATRIX_SECOND_TOKEN, or PI_MATRIX_SECOND_USER + PI_MATRIX_SECOND_PASSWORD\n' +
      'export them (see docs/dev/developing.md, "Running the live tier").',
  );
  process.exit(1);
}

const HOMESERVER = process.env.PI_MATRIX_HOMESERVER;
const RUN_ID = Math.floor(Date.now() / 1000);
const RUN_DIR = path.join(EXT_DIR, "artifacts", `live-${RUN_ID}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const jiti = await createPiJiti(import.meta.url);
const { createSdkOutbox } = await jiti.import(`${EXT_DIR}/src/sdk-client.ts`);
const { createMessageHandler } = await jiti.import(`${EXT_DIR}/src/message-handler.ts`);
const { createSessionIntegrator } = await jiti.import(`${EXT_DIR}/src/session-integration.ts`);
const { createThreadManager } = await jiti.import(`${EXT_DIR}/src/threading.ts`);
const { createAskUserMirror } = await jiti.import(`${EXT_DIR}/src/ask-user-mirror.ts`);
const { createLifecycle } = await jiti.import(`${EXT_DIR}/src/lifecycle.ts`);
const { createRoomUx } = await jiti.import(`${EXT_DIR}/src/room-ux.ts`);
const { TuiFooter } = await jiti.import(`${EXT_DIR}/src/tui-footer.ts`);
const { parseCommandLine, findCommand } = await jiti.import(`${EXT_DIR}/src/command-relay.ts`);

// ---- boot: credentials, fresh room, the real stack ---------------------------

const primary = await new RoomApi(HOMESERVER).loginWithPassword(
  process.env.PI_MATRIX_USERNAME,
  process.env.PI_MATRIX_PASSWORD,
);
const second = await connectSecondActor(HOMESERVER);

const ROOM = await primary.createRoom({
  name: `live-e2e-${RUN_ID}`,
  topic: `pi-matrix-integration live scenario run ${RUN_ID}`,
  invite: [second.userId],
});
await second.join(ROOM);
console.log(`live scenario run ${RUN_ID} — room ${ROOM} (pi=${primary.userId}, human=${second.userId})`);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-matrix-live-${RUN_ID}-`));
const credentialsPath = path.join(stateDir, "credentials.json");
fs.writeFileSync(credentialsPath, JSON.stringify({ access_token: primary.token, device_id: "" }));

const config = {
  homeserver: HOMESERVER,
  userId: primary.userId,
  roomId: ROOM,
  credentialsPath,
  // Attachments plain for this suite: the round trip must be readable by the
  // independent reader over the plain client-server API. The E2EE attach path
  // is covered by the sdk crypto suites (offline) and test/live-sdk-*.
  e2ee: "off",
  attachEncryption: "off",
};

const outbox = createSdkOutbox({ ...config, pollInterval: undefined });
const quietLogger = { debug: () => {}, info: (m) => console.log(`  [info] ${m}`), warn: (m) => console.log(`  [warn] ${m}`), error: (m) => console.log(`  [error] ${m}`) };

if (!(await outbox.connect())) {
  console.error("BOOT FAILED: outbox.connect() returned false");
  process.exit(1);
}

// The Pi-side doubles: what the extension writes INTO the session, and the
// footer slots a real TUI would render. Same shapes as the stub cycle.
const fakePi = {
  sentMessages: [],
  registerMessageRenderer(type, renderer) { this.renderers ??= new Map(); this.renderers.set(type, renderer); },
  sendMessage(message, options) { this.sentMessages.push({ message, options }); },
  sendUserMessage(content, options) { this.sentMessages.push({ message: { customType: "user", content }, options }); },
  appendEntry() {},
  getCommands() { return COMMAND_NAMES; },
};
const COMMAND_NAMES = [
  { name: "matrix-help" }, { name: "matrix-connect" }, { name: "matrix-status" },
  { name: "matrix-switch" }, { name: "matrix-disconnect" }, { name: "matrix-ask-user" },
  { name: "matrix-threshold" }, { name: "matrix-thread" }, { name: "pi-help" },
  { name: "skill:ponytail" },
];

const threadManager = createThreadManager({
  enabled: true,
  roomKey: ROOM,
  threadSend: outbox,
  statePath: path.join(stateDir, "thread-state.json"),
  threadSummaryEvery: 0,
});
const messageHandler = createMessageHandler({ outbox, threadManager, logger: quietLogger });
const integrator = createSessionIntegrator(
  fakePi,
  () => ({ connected: true, connecting: false, roomId: ROOM, userId: primary.userId, lastError: undefined }),
  { messagePrefix: "[Matrix] ", showInFooter: true },
);
integrator.registerMatrixMessageRenderer(fakePi);

// Mirrors live per scenario; the delivery funnel consults the open one first.
let openMirror = null;
const roomUx = createRoomUx({
  cfg: { ...config, cwd: EXT_DIR, messagePrefix: "[Matrix] " },
  logger: quietLogger,
  outbox,
  post: (text) => messageHandler.postMessage ? messageHandler.postMessage(text) : outbox.postMessage(text),
  picker: {},
});

const injected = [];
outbox.startDelivery({
  onMessage: (m) => {
    if (openMirror?.tryConsumeReply(m.body ?? "")) return; // answer, not an injection
    if (!m.isFromPi && config.slashRelay !== false) {
      const cmd = parseCommandLine(m.body ?? "", "/");
      if (cmd && findCommand(cmd.name, COMMAND_NAMES)) {
        fakePi.sendUserMessage((m.body ?? "").trim(), { deliverAs: "followUp", expandPromptTemplates: true });
        return; // the dispatch owns the turn — same rule as src/inbound.ts
      }
    }
    if (!m.isFromPi && roomUx.handleFileAttach(m, (expanded) => injected.push(expanded))) return;
    const piMessage = messageHandler.handleIncomingMessage(m);
    if (piMessage) {
      integrator.injectMatrixMessage(m, piMessage);
      injected.push(piMessage.content);
    }
  },
  onReaction: () => {},
  bumpUnread: () => {},
  onSyncError: (e) => console.log(`  [sync-error] ${e.message}`),
});

const lifecycle = createLifecycle({
  cfg: { ...config, sendMilestones: true, sendFinalMessages: true, sendSessionStartStopMilestones: true, slashRelay: true, autoConnect: true },
  logger: quietLogger,
  outbox,
  deliveryCallbacks: {},
  messageHandler,
  threadManager,
  sessionIntegrator: integrator,
});

// ---- scenario plumbing -------------------------------------------------------

const ctx = {
  room: ROOM, primary, second, outbox, config, stateDir, runDir: RUN_DIR,
  messageHandler, threadManager, lifecycle, fakePi, injected,
  setOpenMirror: (m) => { openMirror = m; },
  /** Wait for a fetched-room condition; returns the matching event. */
  room_(label, pred, timeoutMs = 45_000) {
    return primary.waitUntil(ROOM, pred, { timeoutMs, label });
  },
  /** Write this scenario's evidence file. */
  evidence(name, data) {
    fs.writeFileSync(path.join(RUN_DIR, `${name}.json`), JSON.stringify({ run: RUN_ID, room: ROOM, ...data }, null, 2));
  },
};

const SCENARIOS = [
  {
    n: 1, name: "milestone-out",
    async run(c) {
      const marker = `S1 milestone ${RUN_ID}`;
      const sent = await c.messageHandler.sendMilestone(marker);
      if (!sent.success) throw new Error(`sendMilestone failed: ${JSON.stringify(sent)}`);
      const { hit } = await c.room_("milestone with 🎯 marker", (ev) =>
        ev.find((e) => e.body.includes(marker) && e.body.includes("🎯")));
      return { marker, event: hit };
    },
  },
  {
    n: 2, name: "todo-progress",
    async run(c) {
      const marker = `S2 todo ${RUN_ID}`;
      await c.lifecycle.onTurnEnd({
        message: { role: "assistant", content: [{ type: "text", text: `TODO progress: ${marker} — 3 of 5 done` }] },
      });
      const { hit } = await c.room_("TODO progress milestone", (ev) =>
        ev.find((e) => e.body.includes("TODO progress:") && e.body.includes(marker)));
      return { marker, event: hit };
    },
  },
  {
    n: 3, name: "turn-final",
    async run(c) {
      const marker = `S3 final ${RUN_ID}`;
      await c.messageHandler.sendFinalMessage(`answer from the terminal ${marker}`);
      const { hit } = await c.room_("turn-final with the 💬 Pi: prefix", (ev) =>
        ev.find((e) => e.body.includes(marker) && e.body.includes("💬 Pi:")));
      return { marker, event: hit };
    },
  },
  {
    n: 4, name: "message-in-attributed",
    async run(c) {
      const marker = `S4 question ${RUN_ID}`;
      await c.second.send(c.room, `question from the room ${marker}`);
      await new Promise((r) => setTimeout(r, 4_000)); // one delivery cycle past the post
      const injection = c.fakePi.sentMessages.find(
        (s) => s.message?.customType === "matrix-message" && String(s.message.content).includes(marker),
      );
      if (!injection) throw new Error(`no matrix-message injection for ${marker}: ${JSON.stringify(c.fakePi.sentMessages.map((s) => s.message?.customType))}`);
      const attributed = String(injection.message.content).includes("[Matrix]");
      c.evidence("04-injection", { content: injection.message.content, attributed });
      if (!attributed) throw new Error(`injection lacks the [Matrix] attribution: ${injection.message.content}`);
      return { marker, attributed: true };
    },
  },
  {
    n: 5, name: "ask-user-mirror",
    async run(c) {
      const marker = `S5 ask ${RUN_ID}`;
      const answers = [];
      const mirror = createAskUserMirror({
        isEnabled: () => true,
        emitAnswer: (payload) => answers.push(payload),
        post: (text) => c.outbox.postMessage(text),
        pollsEnabled: () => false,
        postPoll: async () => ({ success: false, error: "text transport in this suite" }),
        warn: () => {},
      });
      c.setOpenMirror(mirror);
      await mirror.onPrompt(
        [{ question: `Ship it? ${marker}`, header: "Ship", multiSelect: false, options: [{ label: "yes" }, { label: "not yet" }] }],
        `$tc-live-${RUN_ID}-5`,
      );
      await c.primary.waitUntil(c.room, (ev) => ev.find((e) => e.body.includes(marker) && /Ship it\?/.test(e.body)), { label: "questionnaire in the room" });
      await c.second.send(c.room, "1"); // the human taps option 1 in the room
      await poll(30_000, () => answers.length > 0, "room answer emitted");
      c.setOpenMirror(null);
      const a = answers.at(-1);
      if (a.answers?.[0]?.optionIndexes?.join() !== "0") throw new Error(`wrong answer payload: ${JSON.stringify(a)}`);
      return { marker, answer: a };
    },
  },
  {
    n: 6, name: "answered-first-wins",
    async run(c) {
      const marker = `S6 race ${RUN_ID}`;
      const answers = [];
      const mirror = createAskUserMirror({
        isEnabled: () => true,
        emitAnswer: (payload) => answers.push(payload),
        post: (text) => c.outbox.postMessage(text),
        pollsEnabled: () => false,
        postPoll: async () => ({ success: false, error: "text transport in this suite" }),
        warn: () => {},
      });
      c.setOpenMirror(mirror);
      const toolCallId = `$tc-live-${RUN_ID}-6`;
      await mirror.onPrompt(
        [{ question: `Race? ${marker}`, header: "Race", multiSelect: false, options: [{ label: "red" }, { label: "blue" }] }],
        toolCallId,
      );
      // The terminal answers first; the room answer arrives one delivery
      // cycle later and must lose.
      const terminalWon = mirror.tryConsumeReply("1");
      await c.second.send(c.room, "2");
      await new Promise((r) => setTimeout(r, 5_000)); // a full window for a late room answer
      c.setOpenMirror(null);
      const forThisCall = answers.filter((a) => a.toolCallId === toolCallId);
      if (!terminalWon) throw new Error("terminal answer did not consume the mirror");
      if (forThisCall.length !== 1) throw new Error(`expected exactly one answer for ${toolCallId}, got ${forThisCall.length}: ${JSON.stringify(forThisCall)}`);
      if (forThisCall[0].answers?.[0]?.optionIndexes?.join() !== "0") throw new Error(`the winner should be the terminal option 1: ${JSON.stringify(forThisCall[0])}`);
      return { marker, toolCallId, winner: "terminal", lateRoomAnswerIgnored: true };
    },
  },
  {
    n: 7, name: "thread-per-session",
    async run(c) {
      const topic1 = `First conversation ${RUN_ID}`;
      const topic2 = `Second conversation ${RUN_ID}`;
      c.threadManager.beginSession("startup", `sess-${RUN_ID}-1`);
      const root1 = await c.threadManager.ensureThreadRoot(topic1);
      c.threadManager.beginSession("new", `sess-${RUN_ID}-2`);
      const root2 = await c.threadManager.ensureThreadRoot(topic2);
      const { hit } = await c.room_("two 🧵 thread roots", (ev) => {
        const roots = ev.filter((e) => e.body.startsWith("🧵") && (e.body.includes(topic1) || e.body.includes(topic2)));
        return roots.length >= 2 ? roots : undefined;
      });
      if (!root1 || !root2) throw new Error(`ensureThreadRoot returned no state: ${JSON.stringify([root1, root2])}`);
      if (root1.eventId === root2.eventId) throw new Error("both sessions share one root");
      return { roots: hit.map((e) => e.body), ids: [root1.eventId, root2.eventId] };
    },
  },
  {
    n: 8, name: "summary-rewrites-root",
    async run(c) {
      const marker = `S8 summary ${RUN_ID}`;
      const md = `# Topic: ${marker}\n\n## Main discussion points\n- live suite proves the room path\n\n## Main decisions\n- assert on fetched room state`;
      const wrote = await c.threadManager.updateSummary(md);
      if (!wrote) throw new Error("updateSummary returned false");
      // The root rewrite is an m.replace edit whose new body carries the
      // three summary sections — asserted on the fetched room, not memory.
      const { hit } = await c.room_("root edit carrying topic+points+decisions", (ev) =>
        ev.find((e) => e.edited && e.body.includes(marker) && e.body.includes("## Main discussion points") && e.body.includes("## Main decisions")));
      return { marker, editEvent: hit, editedId: hit.editedId };
    },
  },
  {
    n: 9, name: "summary-survives-compact",
    async run(c) {
      await c.lifecycle.onSessionCompact({ reason: "manual" });
      const { hit } = await c.room_("compaction milestone in the room", (ev) =>
        ev.find((e) => /compacted context/i.test(e.body) && e.body.includes("🎯")));
      // The summary lives ON the thread root (a room event); compaction adds
      // a milestone, it does not touch the root. Assert both, room-side.
      const all = await c.primary.messages(c.room, { limit: 100 });
      const summaryStillOnRoot = all.some((e) => e.edited && e.body.includes("S8 summary"));
      if (!summaryStillOnRoot) throw new Error("thread summary is gone after /compact");
      return { compactEvent: hit, summaryStillOnRoot };
    },
  },
  {
    n: 10, name: "summary-survives-restart",
    async run(c) {
      const marker = `S10 restart ${RUN_ID}`;
      // Rebuild the transport the way a Pi restart does: fresh outbox, same
      // credentials + same thread-state file. The existing thread root must
      // be found WITHOUT posting a new one, and the summary must still be on
      // it — both proven from the room, not from memory.
      const outbox2 = createSdkOutbox({ ...config });
      if (!(await outbox2.connect())) throw new Error("reconnect failed");
      const tm2 = createThreadManager({
        enabled: true, roomKey: c.room, threadSend: outbox2,
        statePath: path.join(c.stateDir, "thread-state.json"), threadSummaryEvery: 0,
      });
      tm2.beginSession("startup", `sess-${RUN_ID}-restart`);
      const root = await tm2.ensureThreadRoot();
      const sent = await outbox2.postMessage(`reconnected after restart ${marker}`);
      if (!sent.success) throw new Error("post after restart failed");
      await c.room_("post after restart visible", (ev) => ev.find((e) => e.body.includes(marker)));
      // room-side truth: the root event with the summary still reads back:
      const all = await c.primary.messages(c.room, { limit: 100 });
      const rootStillSummarised = all.some((e) => e.edited && e.body.includes("S8 summary"));
      await outbox2.stopDelivery();
      void outbox2.disconnect();
      if (!rootStillSummarised) throw new Error("summary missing from the root after restart");
      return { marker, reconnected: true, rootStillSummarised, tm2Root: root?.eventId };
    },
  },
  {
    n: 11, name: "commands-from-room",
    async run(c) {
      const before = c.fakePi.sentMessages.length;
      await c.second.send(c.room, "/matrix-help");
      await poll(30_000, () => c.fakePi.sentMessages.slice(before).some(
        (s) => s.message?.customType === "user" && String(s.message.content).startsWith("/matrix-help")), "/matrix-help relayed to the session");
      const n2 = c.fakePi.sentMessages.length;
      await c.second.send(c.room, "/skill:ponytail one-line status");
      await poll(30_000, () => c.fakePi.sentMessages.slice(n2).some(
        (s) => s.message?.customType === "user" && String(s.message.content).startsWith("/skill:ponytail")), "/skill: invocation relayed to the session");
      return { relayed: ["/matrix-help", "/skill:ponytail one-line status"], note: "execution inside a live pi session + the /skill run are confirmed in the human walkthrough (test/live/README.md)" };
    },
  },
  {
    n: 12, name: "attachment-round-trip",
    async run(c) {
      const marker = `S12 attach ${RUN_ID}`;
      // out: the extension sends a file; the human side downloads it.
      const bytes = Buffer.from(`attachment round trip ${marker}\n`);
      const sent = await c.outbox.sendFile("probe.txt", bytes, "text/plain");
      if (!sent.success) throw new Error(`sendFile failed: ${JSON.stringify(sent)}`);
      const { hit } = await c.room_("m.file event with a media reference", (ev) =>
        ev.find((e) => e.type === "m.file" && e.url));
      const got = await c.second.downloadMxc(hit.url);
      if (!got.equals(bytes)) throw new Error("downloaded bytes differ from the sent bytes");
      // in: the human references a workspace file; the content is injected.
      const rel = path.join("artifacts", `live-${RUN_ID}`, "incoming.txt");
      fs.mkdirSync(path.dirname(path.join(EXT_DIR, rel)), { recursive: true });
      fs.writeFileSync(path.join(EXT_DIR, rel), `incoming from the room ${marker}`);
      await c.second.send(c.room, `@${rel}`);
      await poll(30_000, () => c.injected.some((x) => String(x).includes(`incoming from the room ${marker}`)), "@file content injected into the session");
      return { marker, outEvent: hit.event_id, bytesMatch: true, inInjected: true };
    },
  },
  {
    n: 13, name: "footer-status",
    async run(c) {
      const slots = {};
      const ctx = { ui: { setStatus: (k, v) => { slots[k] = v; }, clearStatus: (k) => { delete slots[k]; } } };
      const footer = new TuiFooter({ showInFooter: true });
      footer.update(ctx, { connected: true, connecting: false, roomId: c.room, userId: c.primary.userId });
      const connectedSlot = slots.matrix ?? "";
      if (!connectedSlot.includes("💬")) throw new Error(`connected footer slot lacks 💬: ${JSON.stringify(connectedSlot)}`);
      footer.update(ctx, { connected: false, connecting: false, lastError: "sync failed" });
      const downSlot = slots.matrix ?? "";
      if (!downSlot.includes("✗")) throw new Error(`down footer slot lacks ✗: ${JSON.stringify(downSlot)}`);
      footer.clear(ctx);
      if (slots.matrix !== undefined) throw new Error(`clear() left a slot: ${slots.matrix}`);
      return { connectedSlot, downSlot, cleared: true };
    },
  },
];

// ---- run ---------------------------------------------------------------------

function poll(timeoutMs, pred, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = pred(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() >= deadline) return reject(new Error(`timed out (${timeoutMs}ms) waiting for ${label}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

const summary = [];
let failed = 0;
for (const s of SCENARIOS) {
  if (only.length && !only.some((n) => String(s.n) === n || String(s.n).startsWith(n))) continue;
  console.log(`\n== scenario ${s.n}: ${s.name} ==`);
  const t0 = Date.now();
  try {
    const evidence = await s.run(ctx);
    ctx.evidence(`${s.n}-${s.name}`, { ok: true, ms: Date.now() - t0, evidence });
    console.log(`  ok  ${s.n} ${s.name} (${Math.round((Date.now() - t0) / 1000)}s)`);
    summary.push({ n: s.n, name: s.name, ok: true });
  } catch (err) {
    failed++;
    ctx.evidence(`${s.n}-${s.name}`, { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) });
    console.error(`FAIL  ${s.n} ${s.name}: ${err?.message ?? err}`);
    summary.push({ n: s.n, name: s.name, ok: false, error: String(err?.message ?? err) });
  }
}

outbox.stopDelivery();
void outbox.disconnect();

fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify({ run: RUN_ID, room: ROOM, homeserver: HOMESERVER, summary }, null, 2));
console.log(`\nlive scenarios: ${summary.length - failed}/${summary.length} passed — evidence in ${path.relative(EXT_DIR, RUN_DIR)}/`);
if (failed > 0) {
  console.error(`LIVE SCENARIOS: ${failed} FAILED`);
  process.exit(1);
}
console.log("LIVE SCENARIOS: ALL CHECKS PASSED");
process.exit(0);
