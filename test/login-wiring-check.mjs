/**
 * Story 2 (R3 wiring) tests — first-run trigger + /matrix-login + adapters.
 *
 * Design: docs/designs/DESIGN-LOGIN-ONBOARDING.md §2 (entry points), §7
 * (one writer, saveConfig points credentialsPath at the new account dir).
 *
 * Hermetic: a local HTTP server stands in for the homeserver (it serves
 * both the /v3/login capability probe GET and the m.login.password POST),
 * and the PI_MATRIX_TEST_OUTBOX seam fake records the connect() calls.
 * The project config lives in a temp cwd (<cwd>/.pi/matrix/matrix-config.jsonc)
 * so the config write under test is a temp file, never the live one.
 *
 * Contracts under test:
 *   hasLoadableCredentials(path)  — the first-run gate (pure)
 *   buildLoginUi(ctx.ui)          — the LoginUi adapter (custom → MaskedInput)
 *   session_start first-run       — no loadable credentials → dialogue →
 *                                   credentials + config + connect (or cancel → nothing)
 *   /matrix-login                 — registered + same flow on demand
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck } from "./_harness.mjs";

const { check, finish } = makeCheck("LOGIN-WIRING");
const jiti = await createPiJiti(import.meta.url);

// ---------------------------------------------------------------------------
// Part A: hasLoadableCredentials (pure)
// ---------------------------------------------------------------------------

const { hasLoadableCredentials } = await jiti.import(path.join(EXT_DIR, "src/login.ts"));

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-wiring-a-"));
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, JSON.stringify({ access_token: "tok", user_id: "@u:h" }));
  const noToken = path.join(dir, "no-token.json");
  fs.writeFileSync(noToken, JSON.stringify({ user_id: "@u:h" }));
  const emptyToken = path.join(dir, "empty-token.json");
  fs.writeFileSync(emptyToken, JSON.stringify({ access_token: "" }));
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  const missing = path.join(dir, "missing.json");

  check("hasLoadableCredentials: valid file", hasLoadableCredentials(good) === true);
  check("hasLoadableCredentials: missing file", hasLoadableCredentials(missing) === false);
  check("hasLoadableCredentials: corrupt file", hasLoadableCredentials(corrupt) === false);
  check("hasLoadableCredentials: no access_token", hasLoadableCredentials(noToken) === false);
  check("hasLoadableCredentials: empty token", hasLoadableCredentials(emptyToken) === false);
  check("hasLoadableCredentials: undefined path", hasLoadableCredentials(undefined) === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Part B: buildLoginUi adapter
// ---------------------------------------------------------------------------

const { buildLoginUi, MaskedInput, TOUR_YES } = await jiti.import(path.join(EXT_DIR, "src/login.ts"));

{
  const calls = { notify: [], select: [], input: [], confirm: [], custom: [] };
  const ctxUi = {
    select: async (title, options) => {
      calls.select.push({ title, options });
      return options[0]; // pick the first; one case returns undefined
    },
    input: async (title, placeholder) => {
      calls.input.push({ title, placeholder });
      return calls.input.length === 1 ? "a-value" : undefined;
    },
    confirm: async (title) => (calls.confirm.push(title), true),
    notify: (message, kind) => calls.notify.push({ message, kind }),
    custom: async (factory) => {
      let done;
      const p = new Promise((r) => (done = r));
      const comp = factory(null, null, null, done);
      calls.custom.push(comp);
      // the real ui.custom resolves when done() is called — return the
      // promise itself (the test reaches the component via calls.custom)
      return p;
    },
  };
  const ui = buildLoginUi(ctxUi);

  check("adapter: select passes through", (await ui.select("pick", ["x", "y"])) === "x");
  const input1 = await ui.input("give", "ph");
  check("adapter: input passes through", input1 === "a-value");
  check("adapter: input undefined → null", (await ui.input("again")) === null);
  check("adapter: confirm passes through", (await ui.confirm("sure?")) === true);
  ui.notify("hello", "warning");
  check("adapter: notify passes through", calls.notify[0]?.message === "hello" && calls.notify[0]?.kind === "warning");

  // password: the custom factory yields a MaskedInput; submit → value, escape → null
  const pw1 = ui.password("Password");
  const c1 = calls.custom[0];
  c1.setValue("s3cret");
  c1.onSubmit("s3cret");
  check("adapter: password resolves the entered value", (await pw1) === "s3cret");
  check("adapter: password component is a MaskedInput", c1 instanceof MaskedInput);
  check("adapter: password component renders bullets",
    c1.render(40).join("").includes("•") && !c1.render(40).join("").includes("s3cret"));

  const pw2 = ui.password("Password");
  const c2 = calls.custom[1];
  c2.setValue("x");
  c2.onEscape();
  check("adapter: escape → null", (await pw2) === null);
}

// ---------------------------------------------------------------------------
// Parts C/D: factory-level first-run trigger + /matrix-login
// ---------------------------------------------------------------------------

// Hermetic homeserver: serves the /login probe + login, and the room-step
// endpoints (alias resolve -> 404 not-found, createRoom, setRoomAlias PUT).
// The js-sdk may hit the r0 or v3 prefix; match on the path suffix.
const USER_ID = "@vincent:test.example.org";
const createRoomBodies = [];
const server = http.createServer((req, res) => {
  const url = req.url || "";
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "POST" && url.endsWith("/createRoom")) {
    // Capture the body so the test can assert what the js-sdk actually sent
    // (design §8 ponytail: no preset/visibility/topic; e2ee -> initial_state).
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        createRoomBodies.push(JSON.parse(body || "{}"));
      } catch {
        createRoomBodies.push(null);
      }
      json(200, { room_id: "!wiring-room:wiring-test" });
    });
    return;
  }
  if (req.method === "POST" && url.includes("/login"))
    return json(200, { access_token: "syt_wiring_test", user_id: USER_ID, device_id: "PIAGENT01" });
  if (req.method === "GET" && url.includes("/login"))
    return json(200, { flows: [{ type: "m.login.password" }] });
  if (req.method === "POST" && url.endsWith("/createRoom"))
    return json(200, { room_id: "!wiring-room:wiring-test" });
  if (req.method === "PUT" && url.includes("/directory/room/"))
    return json(200, {});
  // GET /directory/room/ (alias resolve) and everything else: not found.
  return json(404, { errcode: "M_NOT_FOUND", error: "Unknown room alias" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HS = `http://127.0.0.1:${server.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login-wiring-"));
const projectDir = path.join(tmp, "project");
const projectCfgDir = path.join(projectDir, ".pi", "matrix");
const stateDir = path.join(tmp, "outbox-state");
const accountsDir = path.join(tmp, "accounts");
const newAccountDir = path.join(accountsDir, "vincent--test.example.org");
const newCredsFile = path.join(newAccountDir, "credentials.json");
// A login now creates a per-account profile (matrix-config.<localpart>--<domain>.jsonc)
// named after the credentials account dir + points last-active-profile at it.
const PROFILE_NAME = "vincent--test.example.org";
// Login writes the profile in the v2 shape, so it lands as `.jsonc`.
const profileConfigPath = path.join(projectCfgDir, `matrix-config.${PROFILE_NAME}.jsonc`);
const lastActiveProfilePath = path.join(projectCfgDir, "last-active-profile");
// The profile is a v2 document (login writes the nested shape). Project it back
// onto the runtime key names so the assertions below read the same way they did
// when the file was flat.
const profileCfg = () => {
  if (!fs.existsSync(profileConfigPath)) return {};
  const v2 = JSON.parse(fs.readFileSync(profileConfigPath, "utf8"));
  const identity = v2.piMatrixIdentity ?? {};
  const cfg = {
    credentialsPath: identity.credentialsPath,
    roomId: v2.piMatrixConnection?.roomId,
    autoConnect: v2.piMatrixConnection?.autoConnect,
    threads: v2.piMatrixThreading?.enabled,
    e2ee: v2.piMatrixRoom?.endToEndEncryption === false ? "off" : "on",
  };
  // Identity keys stay ABSENT (not undefined) so the `in` checks still answer
  // the R3.1 assertion that a re-login must not bake a stale identity in.
  if ("userId" in identity) cfg.userId = identity.userId;
  if ("homeserver" in identity) cfg.homeserver = identity.homeserver;
  return cfg;
};
fs.mkdirSync(projectCfgDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(accountsDir, { recursive: true });

const projectConfigPath = path.join(projectCfgDir, "matrix-config.jsonc");
const writeProjectConfig = (patch) =>
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify(
      {
        environment: "wiring-test",
        roomId: "!room:wiring-test",
        // R4: explicit identity + missing credentials file → warn, allow.
        // homeserver also feeds the dialogue probe prefill.
        userId: "@pi:wiring-test",
        homeserver: HS,
        sendMilestones: false,
        sendFinalMessages: false,
        sendSessionMilestones: false,
        sendCompactMilestones: false,
        sendModelSelectMilestones: false,
        threads: false,
        autoConnect: true,
        // Leaf name WITHOUT the `localpart--domain` pattern: the
        // readCredentialsIdentity filename fallback must NOT derive an
        // owner from it (explicit userId + missing file → warn, allow).
        credentialsPath: path.join(accountsDir, "pi-legacy", "credentials.json"),
        logPath: path.join(tmp, "matrix.log"),
        ...patch,
      },
      null,
      2,
    ),
  );
writeProjectConfig({});

process.env.PI_MATRIX_TEST_OUTBOX = path.join(EXT_DIR, "test", "fake-outbox.mjs");
process.env.FAKE_MTX_STATE = stateDir;
process.env.PI_MATRIX_THREADS = "false";
process.env.PI_MATRIX_LOG_PATH = path.join(tmp, "matrix.log");

const origCwd = process.cwd();
process.chdir(projectDir);

// Scripted ctx: the dialogue drives input() three times (homeserver,
// username, room name), select() four times (3 toggles + tour offer), and
// custom() once (the masked password) on the success path.
function makeUiScript(script) {
  const calls = { notify: [], select: [], input: [], custom: [] };
  let iInput = 0;
  let iSelect = 0;
  return {
    calls,
    ui: {
      setStatus() {},
      setWidget() {},
      notify: (msg, kind) => calls.notify.push({ msg: String(msg), kind }),
      select: async () => {
        // Scripted values when provided; the unreachable-prefill paths
        // "retry" into the input, the toggle/tour selects accept defaults.
        const v = script.select ? script.select[iSelect++] : "retry";
        calls.select.push(v);
        return v;
      },
      input: async (title, placeholder) => {
        const v = iInput < script.input.length ? script.input[iInput++] : undefined;
        calls.input.push({ title, placeholder, v });
        return v;
      },
      confirm: async () => false,
      custom: async (factory) => {
        let done;
        const p = new Promise((r) => (done = r));
        const comp = factory(null, null, null, done);
        calls.custom.push(comp);
        if (script.password === "escape") {
          comp.onEscape();
        } else {
          comp.setValue(script.password ?? "");
          comp.onSubmit(script.password ?? "");
        }
        return p;
      },
    },
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      buildContextEntries: () => [],
      getLeafId: () => undefined,
      getHeader: () => ({}),
      getSessionId: () => "wiring-test-session",
    },
    signal: undefined,
  };
}

function createMockApi() {
  const extension = { handlers: new Map(), tools: new Map(), commands: new Map(), messageRenderers: new Map() };
  const sentMessages = [];
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
    events: { on() { return () => {}; }, emit() {} },
    getCommands: () => [],
    sendUserMessage: () => {},
    sendMessage: (message, opts) => { sentMessages.push({ message, opts }); },
  };
  return { api, extension, sentMessages };
}

const factory = await jiti.import(path.join(EXT_DIR, "index.ts"), { default: true });

const connectCount = () =>
  fs.existsSync(path.join(stateDir, "connect.log"))
    ? fs.readFileSync(path.join(stateDir, "connect.log"), "utf8").split("\n").filter(Boolean).length
    : 0;
const configCredsPath = () => JSON.parse(fs.readFileSync(projectConfigPath, "utf8")).credentialsPath;

async function runFactory(label, uiScript, run) {
  console.log(`== ${label} ==`);
  const { api, extension, sentMessages } = createMockApi();
  await factory(api);
  const ctxBase = makeUiScript(uiScript);
  const h = {
    sessionStart: (extension.handlers.get("session_start") ?? []).at(-1),
    shutdown: (extension.handlers.get("session_shutdown") ?? []).at(-1),
    commands: extension.commands,
  };
  try {
    await run(h, ctxBase);
  } finally {
    await Promise.resolve(h?.shutdown?.({ type: "session_shutdown" }, ctxBase));
  }
  return { h, ctxBase, extension, sentMessages };
}

// C1: first run — no credentials → dialogue → success → credentials + config + connect
{
  const before = connectCount();
  const { ctxBase } = await runFactory("C1 first-run success", { input: [HS, "vincent", "myroom", ""], password: "pw123" }, async (h, ctx) => {
    await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
  });
  check("C1: credentials file written at the accounts layout", fs.existsSync(newCredsFile), newCredsFile);
  if (fs.existsSync(newCredsFile)) {
    const mode = fs.statSync(newCredsFile).mode & 0o777;
    check("C1: credentials file is 0600", mode === 0o600, `mode ${mode.toString(8)}`);
    const creds = JSON.parse(fs.readFileSync(newCredsFile, "utf8"));
    check("C1: credentials carry the token + identity", creds.access_token === "syt_wiring_test" && creds.user_id === USER_ID);
    check("C1: password never persisted", !JSON.stringify(creds).includes("pw123"));
  }
  check("C1: a new per-account profile is created", fs.existsSync(profileConfigPath), profileConfigPath);
  check("C1: last-active-profile points at the new profile",
    fs.existsSync(lastActiveProfilePath) && fs.readFileSync(lastActiveProfilePath, "utf8").trim() === PROFILE_NAME,
    fs.existsSync(lastActiveProfilePath) ? fs.readFileSync(lastActiveProfilePath, "utf8") : "(missing)");
  check("C1: profile credentialsPath points at the new file", profileCfg().credentialsPath === newCredsFile, profileCfg().credentialsPath);
  check("C1: bare config is NOT re-pointed by login (per-account isolation)",
    configCredsPath() === path.join(accountsDir, "pi-legacy", "credentials.json"),
    configCredsPath());
  check("C1: room alias persisted to the profile roomId",
    profileCfg().roomId === `#myroom:${HS.replace(/^http:\/\//, "")}`,
    profileCfg().roomId);
  // design §8 ponytail: the /createRoom body carries ONLY name + invite (+ the
  // e2ee initial_state) — no preset/visibility/topic. A regression re-adding
  // them fails here because the real js-sdk body is captured end-to-end.
  const body0 = createRoomBodies[0] ?? {};
  check("C1: createRoom body has no preset/visibility/topic",
    !("preset" in body0) && !("visibility" in body0) && !("topic" in body0) && !("room_topic" in body0) && !("room_alias_name" in body0),
    JSON.stringify(body0));
  check("C1: createRoom body is encrypted by default (e2ee on) + empty invite + name",
    body0.name === "myroom" && Array.isArray(body0.invite) && body0.invite.length === 0 &&
    JSON.stringify(body0.initial_state ?? []).includes("m.room.encryption"),
    JSON.stringify(body0));
  check("C1: success line shown", ctxBase.calls.notify.some((n) => /unverified/i.test(n.msg)), JSON.stringify(ctxBase.calls.notify));
  check("C1: connect attempted after login", connectCount() > before, `before=${before} after=${connectCount()}`);
  // Story 4: the three toggles land in the live config with their defaults
  // (the scripted select answers "retry" — the dialogue maps any non-alt
  // label to the default row).
  const cfgAfter = profileCfg();
  check("C1: toggles persisted to the profile (defaults)",
    cfgAfter.autoConnect === true && cfgAfter.threads === true && cfgAfter.e2ee === "on",
    JSON.stringify({ autoConnect: cfgAfter.autoConnect, threads: cfgAfter.threads, e2ee: cfgAfter.e2ee }));
  // R3.1 (#0): the base config carried an EXPLICIT stale identity for a
  // different account (userId @pi:wiring-test, its own homeserver) — the
  // two-sender bug. Re-login must NOT bake it into the saved file: both keys
  // are dropped so the next loadConfig re-derives them from the NEW
  // credentials file (vincent).
  check("C1: re-login drops the stale userId + homeserver from the profile",
    !("userId" in cfgAfter) && !("homeserver" in cfgAfter),
    JSON.stringify({ userId: cfgAfter.userId, homeserver: cfgAfter.homeserver }));
  // R3.1 (#4): the connect announcement carries a matrix.to deep-link
  // (https://matrix.to/#/<room>) — the standard link that opens the
  // installed Matrix app (Universal/App Links), falling back to the web
  // client. The lifecycle builds it from the persisted room alias, which
  // still carries the homeserver domain.
  const hsDomain = HS.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const roomUri = `https://matrix.to/#/#myroom:${hsDomain}`;
  check("C1: connect announcement carries the matrix.to app link",
    ctxBase.calls.notify.some((n) => n.msg.includes("Connected to Matrix!") && n.msg.includes(roomUri)),
    JSON.stringify(ctxBase.calls.notify.filter((n) => /Connected/i.test(n.msg))));
}

// C1's success leaves a logged-in state (config re-pointed + credentials
// file) — each later phase starts from the fresh-machine state again.
const resetFreshState = () => {
  writeProjectConfig({});
  fs.rmSync(path.join(accountsDir, "vincent--test.example.org"), { recursive: true, force: true });
  fs.rmSync(profileConfigPath, { force: true });
  fs.rmSync(lastActiveProfilePath, { force: true });
};

// C2: first run — cancel at the password step → nothing written, config
// untouched, no success announcement (one captured context covers all three)
{
  resetFreshState();
  const cfgBefore = fs.readFileSync(projectConfigPath, "utf8");
  const { ctxBase } = await runFactory("C2 first-run cancel", { input: [HS, "vincent"], password: "escape" }, async (h, ctx) => {
    await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
  });
  check("C2: no credentials file on cancel", !fs.existsSync(path.join(accountsDir, "vincent--test.example.org", "credentials.json")));
  check("C2: config untouched on cancel", fs.readFileSync(projectConfigPath, "utf8") === cfgBefore);
  check(
    "C2: no success announcement on cancel",
    !ctxBase.calls.notify.some((n) => /unverified/i.test(n.msg)),
    JSON.stringify(ctxBase.calls.notify),
  );
}

// D0: /matrix-login is registered
{
  const { h } = await runFactory("D0 command registered", { input: [HS, "vincent"], password: "pw123" }, async () => {});
  check("D0: /matrix-login registered", h.commands.has("matrix-login"));
}

// D1: /matrix-login success (re-login) — credentials (re)written + config + connect
{
  resetFreshState();
  const before = connectCount();
  const { h, ctxBase } = await runFactory("D1 /matrix-login success", { input: [HS, "vincent", "myroom", ""], password: "pw456" }, async (h2, ctx) => {
    const cmd = h2.commands.get("matrix-login");
    await cmd.handler("", ctx);
  });
  check("D1: credentials file (re)written", fs.existsSync(newCredsFile));
  const creds = fs.existsSync(newCredsFile) ? JSON.parse(fs.readFileSync(newCredsFile, "utf8")) : {};
  check("D1: re-login overwrote the token", creds.access_token === "syt_wiring_test");
  check("D1: profile credentialsPath updated", profileCfg().credentialsPath === newCredsFile, profileCfg().credentialsPath);
  check("D1: last-active-profile points at the new profile",
    fs.existsSync(lastActiveProfilePath) && fs.readFileSync(lastActiveProfilePath, "utf8").trim() === PROFILE_NAME,
    fs.existsSync(lastActiveProfilePath) ? fs.readFileSync(lastActiveProfilePath, "utf8") : "(missing)");
  check("D1: success line shown", ctxBase.calls.notify.some((n) => /unverified/i.test(n.msg)));
  check("D1: connect attempted", connectCount() > before);
}

// D2: /matrix-login cancel → nothing written, a cancel notice
{
  resetFreshState();
  const cfgBefore = fs.readFileSync(projectConfigPath, "utf8");
  const { h, ctxBase } = await runFactory("D2 /matrix-login cancel", { input: [HS, "vincent"], password: "escape" }, async (h2, ctx) => {
    const cmd = h2.commands.get("matrix-login");
    await cmd.handler("", ctx);
  });
  check("D2: config untouched on cancel", fs.readFileSync(projectConfigPath, "utf8") === cfgBefore);
  check(
    "D2: cancel notice shown",
    ctxBase.calls.notify.some((n) => /cancel/i.test(n.msg)),
    JSON.stringify(ctxBase.calls.notify),
  );
}

// D3: /matrix-introduction-tour is registered + injects the canned prompt
// through the [Matrix] directive path (design §10)
{
  resetFreshState();
  const { h, sentMessages } = await runFactory("D3 tour command", { input: [HS, "vincent", "myroom", ""], password: "pw123" }, async (h2, ctx) => {
    const cmd = h2.commands.get("matrix-introduction-tour");
    if (!cmd) throw new Error("matrix-introduction-tour not registered");
    await cmd.handler("", ctx);
  });
  check("D3: /matrix-introduction-tour registered", h.commands.has("matrix-introduction-tour"));
  const directive = sentMessages.find((m) => m.message?.customType === "matrix-directive");
  check("D3: tour injected once via the [Matrix] directive path",
    directive !== undefined && /tour/i.test(String(directive.message.content)),
    JSON.stringify(sentMessages.map((m) => m.message?.customType)));
  check("D3: tour prompt sources the matrix-help content",
    directive !== undefined && /Matrix–Pi Integration/i.test(String(directive.message.content)),
    String(directive?.message?.content ?? "").slice(0, 120));
}

// C3: first run, tour accepted → the tour directive is injected after
// connect (design §3: "yes → /matrix-introduction-tour runs after connect")
{
  resetFreshState();
  const before = connectCount();
  const { ctxBase, sentMessages } = await runFactory("C3 first-run tour accepted", {
    input: [HS, "vincent", "myroom", ""],
    // Order: first-run connect prompt (backlog 3) -> 3 toggles -> tour ->
    // .gitignore prompt. A missing leading answer shifts every later one, and an
    // exhausted script answers undefined, which the tour step reads as a cancel:
    // the dialogue then writes nothing and never announces success.
    select: ["yes", "accept", "accept", "accept", TOUR_YES, "No"],
    password: "pw123",
  }, async (h, ctx) => {
    await h.sessionStart({ type: "session_start", reason: "startup" }, ctx);
  });
  check("C3: connect attempted after login", connectCount() > before, `before=${before} after=${connectCount()}`);
  const directive = sentMessages.find((m) => m.message?.customType === "matrix-directive");
  check("C3: tour directive injected after connect",
    directive !== undefined && /tour/i.test(String(directive.message.content)),
    JSON.stringify(sentMessages.map((m) => m.message?.customType)));
  check("C3: success line still shown", ctxBase.calls.notify.some((n) => /unverified/i.test(n.msg)));
}

server.close();
process.chdir(origCwd);
finish();
