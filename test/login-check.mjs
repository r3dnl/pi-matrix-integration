/**
 * Login dialogue + credentials store tests (R3 stories 1, part 1).
 *
 * Design: docs/designs/DESIGN-LOGIN-ONBOARDING.md §3/§4/§7/§11.
 * Contracts under test (all in src/login.ts):
 *   saveCredentials(credsDir, creds)          — §7: 0700/0600, atomic, schema
 *   probeLoginCapability(baseUrl, fetchImpl)  — §4/§11: /v3/login capability
 *   MaskedInput                               — §4 step 3: bullets, no plaintext
 *   runLoginDialogue(deps)                    — §3/§4: probe → hs → user → pw → login → save
 *
 * No network: fetch and the login client are injected. No live config: the
 * config write goes through deps.updateConfig (recorder in tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck } from "./_harness.mjs";
// Story 5 regression tier: the js-sdk surface the DAG chain uses, imported
// directly (js-sdk ships ESM).
import { isValidAuthMetadata } from "matrix-js-sdk/lib/oauth/discover.js";
import { generateScope } from "matrix-js-sdk/lib/oauth/index.js";

const { check, finish } = makeCheck("login-check");
const jiti = await createPiJiti(import.meta.url);
const {
  runLoginDialogue,
  saveCredentials,
  probeLoginCapability,
  MaskedInput,
  homeserverDomain,
  normalizeHomeserver,
  proposeRoomAlias,
  normalizeRoomAlias,
  runRoomStep,
  runToggleSteps,
  buildTourPrompt,
  TOGGLE_AUTOCONNECT_OPTIONS,
  TOGGLE_AUTOCONNECT_NO,
  TOGGLE_THREADS_OPTIONS,
  TOGGLE_THREADS_FLAT,
  TOGGLE_E2EE_OPTIONS,
  TOGGLE_E2EE_OFF,
  TOUR_OPTIONS,
  TOUR_YES,
} = await jiti.import(path.join(EXT_DIR, "src/login.ts"));

// Story 4: the five selects every successful CREATE-path dialogue reaches
// (room encryption + 2 toggles + tour + .gitignore), defaults accepted, tour
// declined. Order follows the flow: the room step asks encryption first
// (FINDING-012), then the toggles, then .gitignore last (after the manifest).
const DEFAULT_SELECTS = [
  TOGGLE_E2EE_OPTIONS[0],
  TOGGLE_AUTOCONNECT_OPTIONS[0],
  TOGGLE_THREADS_OPTIONS[0],
  TOUR_OPTIONS[1],
  "No",
];

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeUi(script = {}) {
  const calls = { select: [], input: [], confirm: [], notify: [], password: [] };
  const answers = {
    select: script.select ?? [], // values or {value} or null (Esc)
    input: script.input ?? [],
    confirm: script.confirm ?? [],
    password: script.password ?? [],
  };
  let iSelect = 0;
  let iInput = 0;
  let iConfirm = 0;
  let iPassword = 0;
  const ui = {
    calls,
    async select(title, options, initialIndex) {
      calls.select.push({ title, options, initialIndex });
      const a = answers.select[iSelect++];
      return a === undefined ? null : a;
    },
    async input(title, placeholder) {
      calls.input.push({ title, placeholder });
      const a = answers.input[iInput++];
      return a === undefined ? null : a;
    },
    async confirm(title) {
      calls.confirm.push({ title });
      const a = answers.confirm[iConfirm++];
      return a === undefined ? true : a;
    },
    notify(message, kind) {
      calls.notify.push({ message, kind });
    },
    async password(title) {
      calls.password.push({ title });
      const a = answers.password[iPassword++];
      return a === undefined ? null : a;
    },
  };
  return ui;
}

function fetchStub(payloads) {
  // payloads: array of {status, body} consumed in order; or a function(url)
  let i = 0;
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const p = typeof payloads === "function" ? payloads(String(url)) : payloads[i++];
    if (!p) throw new Error(`fetchStub: no canned response for ${url}`);
    if (p.throw) throw p.throw;
    return {
      ok: (p.status ?? 200) < 400,
      status: p.status ?? 200,
      json: async () => p.body,
      text: async () => JSON.stringify(p.body ?? {}),
    };
  };
  return { fn, calls };
}

function loginClientStub(plan) {
  // plan: array of {response} or {error} consumed in order
  const calls = [];
  let i = 0;
  // Room-step surface (Story 3): defaults say "no such alias" — the
  // dialogue's room step then attempts creation (createCalls recorded).
  const roomCalls = { resolve: [], create: [], alias: [] };
  const roomPlan = {
    resolve: async (alias) => {
      roomCalls.resolve.push(alias);
      throw Object.assign(new Error("M_NOT_FOUND: Unknown alias"), { httpStatus: 404, errcode: "M_NOT_FOUND" });
    },
    create: async (opts) => {
      roomCalls.create.push(opts);
      return { room_id: "!room-created:hs" };
    },
    setAlias: async (roomId, alias) => {
      roomCalls.alias.push({ roomId, alias });
    },
  };
  return {
    calls,
    roomCalls,
    setRoomPlan(p) {
      if (p.resolve) roomPlan.resolve = p.resolve;
      if (p.create) roomPlan.create = p.create;
      if (p.setAlias) roomPlan.setAlias = p.setAlias;
    },
    client: {
      async loginWithPassword(user, password) {
        calls.push({ user, password });
        const p = plan[i++];
        if (!p) throw new Error("loginClientStub: no canned response");
        if (p.error) throw new Error(p.error);
        return p.response;
      },
      resolveRoomAlias: (alias) => roomPlan.resolve(alias),
      createRoom: (opts) => roomPlan.create(opts),
      setRoomAlias: (roomId, alias) => roomPlan.setAlias(roomId, alias),
    },
  };
}

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `login-check-${name}-`));
  return dir;
}

const HS = "https://tst2-matrix.r3d.nl";
const USER_ID = "@vincent:tst2-matrix.r3d.nl";
const ACCOUNT = "vincent--tst2-matrix.r3d.nl";
const LOGIN_RESPONSE = {
  access_token: "syt_tok_123",
  device_id: "PIAGENT01",
  user_id: USER_ID,
  well_known: null,
};

// ---------------------------------------------------------------------------
// saveCredentials (design §7)
// ---------------------------------------------------------------------------

{
  const dir = tempDir("save");
  const file = saveCredentials(dir, {
    user_id: USER_ID,
    homeserver: HS,
    device_id: "PIAGENT01",
    access_token: "syt_tok_123",
  });
  check("saveCredentials returns a path under credsDir", file.startsWith(dir + path.sep), file);
  check("saveCredentials uses the accounts/<localpart>--<domain> layout",
    file === path.join(dir, ACCOUNT, "credentials.json"), file);
  const raw = fs.readFileSync(file, "utf-8");
  const parsed = JSON.parse(raw);
  check("credentials schema: access_token", parsed.access_token === "syt_tok_123");
  check("credentials schema: device_id", parsed.device_id === "PIAGENT01");
  check("credentials schema: user_id", parsed.user_id === USER_ID);
  check("credentials schema: homeserver", parsed.homeserver === HS);
  check("no other keys in the credentials file",
    JSON.stringify(Object.keys(parsed).sort()) ===
    JSON.stringify(["access_token", "device_id", "homeserver", "user_id"]),
    JSON.stringify(Object.keys(parsed)));
  const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
  const fileMode = fs.statSync(file).mode & 0o777;
  check("account dir is 0700", dirMode === 0o700, `mode ${dirMode.toString(8)}`);
  check("credentials file is 0600", fileMode === 0o600, `mode ${fileMode.toString(8)}`);

  // re-login overwrites (design §7: re-login to an existing account)
  const file2 = saveCredentials(dir, {
    user_id: USER_ID,
    homeserver: HS,
    device_id: "PIAGENT02",
    access_token: "syt_tok_456",
  });
  const reparsed = JSON.parse(fs.readFileSync(file2, "utf-8"));
  check("re-login overwrites the existing credentials",
    reparsed.device_id === "PIAGENT02" && reparsed.access_token === "syt_tok_456");

  // different account → different file
  const file3 = saveCredentials(dir, {
    user_id: "@other:tst2-matrix.r3d.nl",
    homeserver: HS,
    device_id: "PIAGENT03",
    access_token: "tok3",
  });
  check("different localpart → different account dir",
    file3 === path.join(dir, "other--tst2-matrix.r3d.nl", "credentials.json"), file3);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// probeLoginCapability (design §4/§11)
// ---------------------------------------------------------------------------

{
  const goodLogin = { flows: [{ type: "m.login.password" }, { type: "m.login.token" }] };
  const { fn, calls } = fetchStub([{ status: 200, body: goodLogin }]);
  const cap = await probeLoginCapability(HS, fn);
  check("probe: hits /_matrix/client/v3/login",
    calls[0] === `${HS}/_matrix/client/v3/login`, calls[0]);
  check("probe: reachable + password flow present", cap.reachable === true && cap.password === true);

  const noPw = await probeLoginCapability(
    HS,
    fetchStub([{ status: 200, body: { flows: [{ type: "m.login.token" }] } }]).fn,
  );
  check("probe: no m.login.password flow", noPw.reachable === true && noPw.password === false);

  const unreachable = await probeLoginCapability(HS, fetchStub([{ throw: new Error("ECONNREFUSED") }]).fn);
  check("probe: network failure → unreachable", unreachable.reachable === false && unreachable.password === false);
}

// ---------------------------------------------------------------------------
// MaskedInput (design §4 step 3)
// ---------------------------------------------------------------------------

{
  const inst = new MaskedInput("sec ret", {});
  const rendered = inst.render(60).join("\n");
  check("MaskedInput renders one bullet per character",
    (rendered.match(/•/g) ?? []).length === 7, rendered);
  check("MaskedInput never shows the plaintext", !rendered.includes("sec ret") && !rendered.includes("secret"));
  check("MaskedInput exposes the real value via getValue", inst.getValue() === "sec ret");
  inst.setValue("longer password here");
  check("MaskedInput setValue updates the value", inst.getValue() === "longer password here");
  const empty = new MaskedInput("", {});
  check("MaskedInput empty value renders no bullets",
    (String(empty.render(60)).match(/•/g) ?? []).length === 0);
}

// ---------------------------------------------------------------------------
// R3.1: normalizeHomeserver — a bare domain gets https:// (Node fetch needs
// a scheme; a bare host throws "Failed to parse URL" and reads as
// "unreachable"), an explicit scheme is kept as-is.
// ---------------------------------------------------------------------------
{
  check("normalizeHomeserver: bare domain gets https://",
    normalizeHomeserver("tst2-matrix.r3d.nl") === "https://tst2-matrix.r3d.nl");
  check("normalizeHomeserver: https:// passes through",
    normalizeHomeserver("https://tst2-matrix.r3d.nl") === "https://tst2-matrix.r3d.nl");
  check("normalizeHomeserver: explicit http:// passes through (the user was warned)",
    normalizeHomeserver("http://tst2-matrix.r3d.nl") === "http://tst2-matrix.r3d.nl");
  check("normalizeHomeserver: trims surrounding whitespace",
    normalizeHomeserver("  tst2-matrix.r3d.nl ") === "https://tst2-matrix.r3d.nl");
  check("normalizeHomeserver: empty stays empty (the dialogue asks first)",
    normalizeHomeserver("") === "");
}

// ---------------------------------------------------------------------------
// R3.1: buildMatrixToLink — the connect-announcement room link. matrix.to is
// the standard HTTPS deep-link that opens the installed Matrix app; the
// format is `https://matrix.to/#/<roomId>` (alias or room ID).
// ---------------------------------------------------------------------------
{
  const { buildMatrixToLink } = await jiti.import(path.join(EXT_DIR, "src/lifecycle.ts"));
  check("matrix.to link: room alias",
    buildMatrixToLink("#r:tst2-matrix.r3d.nl")
      === " https://matrix.to/#/#r:tst2-matrix.r3d.nl");
  check("matrix.to link: room ID",
    buildMatrixToLink("!id:tst2-matrix.r3d.nl")
      === " https://matrix.to/#/!id:tst2-matrix.r3d.nl");
  check("matrix.to link: missing roomId -> empty (no broken URL)",
    buildMatrixToLink(undefined) === "");
}

// ---------------------------------------------------------------------------
// runLoginDialogue — state machine (design §3/§4, §11)
// ---------------------------------------------------------------------------

const dialogDeps = (extra = {}) => {
  const stub = loginClientStub([{ response: LOGIN_RESPONSE }]);
  if (extra.rooms) stub.setRoomPlan(extra.rooms);
  return {
    ui: makeUi(),
    credsDir: tempDir("dialog"),
    updateConfig: (patch) => extra.updateConfig?.(patch),
    fetchImpl: fetchStub([{ status: 200, body: { flows: [{ type: "m.login.password" }] } }]).fn,
    makeLoginClient: () => stub.client,
    loginStub: stub,
    homeserverPrefill: HS,
    usernamePrefill: "vincent",
    ...extra,
  };
};

{
  // success: probe → homeserver → username → password → login → save + config
  const ui = makeUi({ input: [HS, "vincent", "myroom", ""], select: [...DEFAULT_SELECTS], password: ["correct horse"] });
  const configPatches = [];
  const deps = dialogDeps({ ui, updateConfig: (p) => configPatches.push(p) });
  const result = await runLoginDialogue(deps);
  check("dialogue: success result ok", result.ok === true);
  check("dialogue: success result carries credentialsPath",
    result.credentialsPath === path.join(deps.credsDir, ACCOUNT, "credentials.json"),
    String(result.credentialsPath));
  check("dialogue: success result carries user_id + device_id",
    result.user_id === USER_ID && result.device_id === "PIAGENT01");
  check("dialogue: wrote the credentials file",
    fs.existsSync(result.credentialsPath));
  const written = JSON.parse(fs.readFileSync(result.credentialsPath, "utf-8"));
  check("dialogue: password never persisted",
    !JSON.stringify(written).includes("correct horse"));
  check("dialogue: config update points credentialsPath at the file",
    configPatches.some((p) => p.credentialsPath === result.credentialsPath),
    JSON.stringify(configPatches));
  check("dialogue: login called with the entered username + password",
    deps.loginStub.calls.length === 1 &&
    deps.loginStub.calls[0].user === "vincent" &&
    deps.loginStub.calls[0].password === "correct horse");
  // Story 3: the room step runs after login — the typed name is resolved,
  // created (absent), alias claimed, roomId persisted
  check("dialogue: room step resolved the typed alias",
    deps.loginStub.roomCalls.resolve.length === 1 &&
    deps.loginStub.roomCalls.resolve[0] === "#myroom:tst2-matrix.r3d.nl",
    JSON.stringify(deps.loginStub.roomCalls.resolve));
  check("dialogue: room created encrypted (user picked On) + empty invite",
    deps.loginStub.roomCalls.create.length === 1 &&
    deps.loginStub.roomCalls.create[0].invite.length === 0 &&
    deps.loginStub.roomCalls.create[0].isEncrypted === true &&
    deps.loginStub.roomCalls.create[0].name === "myroom");
  check("dialogue: alias claimed after creation",
    deps.loginStub.roomCalls.alias.length === 1 &&
    deps.loginStub.roomCalls.alias[0].roomId === "!room-created:hs" &&
    deps.loginStub.roomCalls.alias[0].alias === "#myroom:tst2-matrix.r3d.nl");
  check("dialogue: result carries the room alias",
    result.roomId === "#myroom:tst2-matrix.r3d.nl", String(result.roomId));
  check("dialogue: config patch persists the room alias",
    configPatches.some((p) => p.credentialsPath === result.credentialsPath && p.roomId === "#myroom:tst2-matrix.r3d.nl"),
    JSON.stringify(configPatches));
  // Story 4: the three toggles are asked (defaults accepted) and persisted,
  // the tour is offered and declined
  check("dialogue: result carries tour=false when the tour is declined",
    result.tour === false, JSON.stringify(result));
  check("dialogue: config patch persists the three toggles (defaults)",
    configPatches.some((p) => p.autoConnect === true && p.threads === true && p.e2ee === "on"),
    JSON.stringify(configPatches));
  check("dialogue: exactly five selects on the success path (room enc + 2 toggles + tour + .gitignore)",
    ui.calls.select.length === 5, String(ui.calls.select.length));
  // the success line states the E2EE consequence (design §4): unverified device
  const successNotify = ui.calls.notify.find((n) => String(n.message).includes("unverified"));
  check("dialogue: success line notes the unverified-device E2EE consequence",
    successNotify !== undefined, JSON.stringify(ui.calls.notify));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // Story 4: the tour accepted → result.tour is true (the caller runs it after
  // connect); the toggles still persist
  const ui = makeUi({
    input: [HS, "vincent", "myroom", ""],
    select: [TOGGLE_E2EE_OPTIONS[0], TOGGLE_AUTOCONNECT_OPTIONS[0], TOGGLE_THREADS_OPTIONS[0], TOUR_YES],
    password: ["correct horse"],
  });
  const patches = [];
  const deps = dialogDeps({ ui, updateConfig: (p) => patches.push(p) });
  const result = await runLoginDialogue(deps);
  check("dialogue: tour accepted → result.tour true",
    result.ok === true && result.tour === true, JSON.stringify(result));
  check("dialogue: tour accepted still writes credentials + toggles",
    patches.some((p) => p.autoConnect === true && p.e2ee === "on") && fs.existsSync(result.credentialsPath));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // Story 4: cancel at a toggle (Esc on the threads select) → the whole
  // dialogue cancels and nothing is written (principle 2)
  const ui = makeUi({
    input: [HS, "vincent", "myroom", ""],
    select: [TOGGLE_E2EE_OPTIONS[0], TOGGLE_AUTOCONNECT_OPTIONS[0], null],
    password: ["correct horse"],
  });
  const patches = [];
  const deps = dialogDeps({ ui, updateConfig: (p) => patches.push(p) });
  const result = await runLoginDialogue(deps);
  check("dialogue: cancel at a toggle → cancelled result",
    result.ok === false && result.cancelled === true, JSON.stringify(result));
  check("dialogue: cancel at a toggle writes nothing",
    patches.length === 0 && fs.readdirSync(deps.credsDir).length === 0,
    JSON.stringify({ patches, files: fs.readdirSync(deps.credsDir) }));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // cancel at the password step: nothing written, cancel result
  const before = "pre";
  const ui = makeUi({ input: [HS, "vincent"], password: [null] });
  const deps = dialogDeps({ ui });
  const result = await runLoginDialogue(deps);
  check("dialogue: cancel result shape", result.ok === false && result.cancelled === true);
  const entries = fs.readdirSync(deps.credsDir);
  check("dialogue: cancel writes nothing", entries.length === 0, JSON.stringify(entries));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // bad password: notify the error, loop to the password step, succeed after
  const ui = makeUi({
    input: [HS, "vincent", "myroom", ""],
    select: [...DEFAULT_SELECTS],
    password: ["wrong", "correct horse"],
  });
  const plan = [
    { error: "403 M_FORBIDDEN: Invalid username or password" },
    { response: LOGIN_RESPONSE },
  ];
  const stub = loginClientStub(plan);
  const deps = dialogDeps({ ui, makeLoginClient: () => stub.client });
  const result = await runLoginDialogue(deps);
  check("dialogue: bad password then good → success", result.ok === true);
  check("dialogue: bad password notified with the login error",
    ui.calls.notify.some((n) => /M_FORBIDDEN/.test(String(n.message))),
    JSON.stringify(ui.calls.notify));
  check("dialogue: password asked twice", ui.calls.password.length === 2,
    String(ui.calls.password.length));
  check("dialogue: login attempted twice", stub.calls.length === 2);
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // homeserver unreachable: one line + retry/cancel; cancel writes nothing
  const ui = makeUi({ select: ["cancel"] });
  const deps = dialogDeps({
    ui,
    fetchImpl: fetchStub([{ throw: new Error("fetch failed") }]).fn,
  });
  const result = await runLoginDialogue(deps);
  check("dialogue: unreachable + cancel → cancel result",
    result.ok === false && result.cancelled === true);
  check("dialogue: unreachable notified one line",
    ui.calls.notify.length >= 1 && ui.calls.input.length === 0,
    JSON.stringify(ui.calls.notify));
  const entries = fs.readdirSync(deps.credsDir);
  check("dialogue: unreachable + cancel writes nothing", entries.length === 0);
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // no password login flow on the server → one line + cancel (QR is not in R3)
  const ui = makeUi();
  const deps = dialogDeps({
    ui,
    fetchImpl: fetchStub([{ status: 200, body: { flows: [{ type: "m.login.token" }] } }]).fn,
  });
  const result = await runLoginDialogue(deps);
  check("dialogue: no password flow → not a success", result.ok === false);
  check("dialogue: no password flow notified", ui.calls.notify.length >= 1,
    JSON.stringify(ui.calls.notify));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // R3.1 (#1): no prefill → ask for the homeserver FIRST — no phantom
  // "unreachable" warning from probing the empty URL (the probe can never
  // succeed against ""). One probe, against the entered server.
  const ui = makeUi({
    select: [...DEFAULT_SELECTS],
    input: [HS, "vincent", "myroom", ""],
    password: ["correct horse"],
  });
  const probed = [];
  const smartFetch = async (url) => {
    probed.push(String(url));
    if (String(url).startsWith(HS)) {
      return {
        ok: true, status: 200,
        json: async () => ({ flows: [{ type: "m.login.password" }] }),
        text: async () => "{}",
      };
    }
    throw new Error("bad url");
  };
  const deps = dialogDeps({ ui, fetchImpl: smartFetch, homeserverPrefill: undefined });
  const result = await runLoginDialogue(deps);
  check("dialogue: no prefill → ask first, then one probe on the entered server",
    result.ok === true, JSON.stringify(result));
  check("dialogue: exactly one probe, against the entered server (no empty-URL probe)",
    probed.length === 1 && probed[0] === `${HS}/_matrix/client/v3/login`,
    JSON.stringify(probed));
  check("dialogue: no phantom unreachable warning, no retry select",
    !ui.calls.notify.some((n) => /unreachable/i.test(String(n.message))) &&
    ui.calls.select.length === DEFAULT_SELECTS.length,
    JSON.stringify({ notify: ui.calls.notify, selects: ui.calls.select.length }));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // R3.1 (#1/#2): an EMPTY entry at the confirm step (Enter on the
  // prefilled homeserver) keeps the prefilled value — the address is never
  // blanked into a broken login.
  const ui = makeUi({
    input: ["", "vincent", "myroom", ""],
    select: [...DEFAULT_SELECTS],
    password: ["correct horse"],
  });
  const deps = dialogDeps({ ui }); // prefill HS, reachable fetch
  const result = await runLoginDialogue(deps);
  check("dialogue: empty confirm entry keeps the prefilled homeserver",
    result.ok === true, JSON.stringify(result));
  if (result.ok) {
    const written = JSON.parse(fs.readFileSync(result.credentialsPath, "utf-8"));
    check("dialogue: stored homeserver is the prefill (not blank)",
      written.homeserver === HS, JSON.stringify(written.homeserver));
  }
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // R3.1 (#2): a bare domain typed at the homeserver step is auto-prepended
  // with https:// before the probe — and the stored homeserver is the
  // normalized form.
  const BARE = "tst2-matrix.r3d.nl";
  const ui = makeUi({
    select: [...DEFAULT_SELECTS],
    input: [BARE, "vincent", "myroom", ""],
    password: ["correct horse"],
  });
  const probed = [];
  const smartFetch = async (url) => {
    probed.push(String(url));
    if (String(url).startsWith(`https://${BARE}`)) {
      return {
        ok: true, status: 200,
        json: async () => ({ flows: [{ type: "m.login.password" }] }),
        text: async () => "{}",
      };
    }
    throw new Error("scheme required");
  };
  const deps = dialogDeps({ ui, fetchImpl: smartFetch, homeserverPrefill: undefined });
  const result = await runLoginDialogue(deps);
  check("dialogue: bare domain input → probe hit the https:// form",
    result.ok === true && probed[0] === `https://${BARE}/_matrix/client/v3/login`,
    JSON.stringify(probed));
  const written = JSON.parse(fs.readFileSync(result.credentialsPath, "utf-8"));
  check("dialogue: bare domain input → credentials store the normalized https:// homeserver",
    written.homeserver === `https://${BARE}`, JSON.stringify(written.homeserver));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // R3.1 (#2): an explicit http:// input raises a stern warning (credentials
  // travel in the clear) but still tries — the server may legitimately be
  // http on a test network.
  const ui = makeUi({
    select: [...DEFAULT_SELECTS],
    input: ["http://hs.example", "vincent", "myroom", ""],
    password: ["correct horse"],
  });
  const probed = [];
  const smartFetch = async (url) => {
    probed.push(String(url));
    if (String(url).startsWith("http://hs.example")) {
      return {
        ok: true, status: 200,
        json: async () => ({ flows: [{ type: "m.login.password" }] }),
        text: async () => "{}",
      };
    }
    throw new Error("unexpected url");
  };
  const deps = dialogDeps({ ui, fetchImpl: smartFetch, homeserverPrefill: undefined });
  const result = await runLoginDialogue(deps);
  check("dialogue: explicit http:// → stern warning raised",
    result.ok === true && ui.calls.notify.some(
      (n) => /http:\/\//i.test(String(n.message)) && n.kind === "warning",
    ),
    JSON.stringify(ui.calls.notify));
  check("dialogue: explicit http:// → the probe still tries the http:// URL",
    probed[0] === "http://hs.example/_matrix/client/v3/login",
    JSON.stringify(probed));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

{
  // prefilled homeserver unreachable: retry must offer the (prefilled)
  // homeserver input so the user can fix the URL — retrying the same bad
  // URL forever is a dead end (design §11)
  const ui = makeUi({
    select: ["retry", ...DEFAULT_SELECTS],
    input: [HS, "vincent", "myroom", ""],
    password: ["correct horse"],
  });
  const probed = [];
  const smartFetch = async (url) => {
    probed.push(String(url));
    if (String(url).startsWith(HS)) {
      return {
        ok: true, status: 200,
        json: async () => ({ flows: [{ type: "m.login.password" }] }),
        text: async () => "{}",
      };
    }
    throw new Error("unreachable");
  };
  const deps = dialogDeps({ ui, fetchImpl: smartFetch, homeserverPrefill: "https://bad-host.example" });
  const result = await runLoginDialogue(deps);
  check("dialogue: bad prefill + unreachable → retry offers the homeserver → success",
    result.ok === true, JSON.stringify(result));
  check("dialogue: retry input was prefilled with the bad URL",
    ui.calls.input[0].title === "Matrix homeserver" && ui.calls.input[0].placeholder === "https://bad-host.example",
    JSON.stringify(ui.calls.input));
  check("dialogue: probed the bad URL once, then the corrected one",
    probed.length === 2 && probed[0].startsWith("https://bad-host.example") && probed[1].startsWith(HS),
    JSON.stringify(probed));
  fs.rmSync(deps.credsDir, { recursive: true, force: true });
}

// ===========================================================================
// Story 3: Room selection — propose + status + autocreate (design §8)
// ===========================================================================

// --- homeserverDomain ------------------------------------------------------
console.log("\n--- homeserverDomain (alias domain part) ---");
check("homeserverDomain: strips scheme + trailing slash, keeps host",
  homeserverDomain("https://tst2-matrix.r3d.nl") === "tst2-matrix.r3d.nl");
check("homeserverDomain: keeps the port (alias domains include it)",
  homeserverDomain("http://localhost:8008/") === "localhost:8008");
check("homeserverDomain: bare host passes through", homeserverDomain("tst2-matrix.r3d.nl") === "tst2-matrix.r3d.nl");

// --- proposeRoomAlias ------------------------------------------------------
console.log("\n--- proposeRoomAlias (design §8 step 1) ---");
check("propose: default = #<cwd-basename>:<domain>",
  proposeRoomAlias(undefined, "/home/vincent/pi-proj", "https://hs.example") === "#pi-proj:hs.example");
check("propose: a configured alias wins over the default",
  proposeRoomAlias("#mine:hs.example", "/home/vincent/pi-proj", "https://hs.example") === "#mine:hs.example");
check("propose: a configured !room_id is not an alias -> default",
  proposeRoomAlias("!abc:hs.example", "/home/vincent/pi-proj", "https://hs.example") === "#pi-proj:hs.example");

// --- normalizeRoomAlias ----------------------------------------------------
console.log("\n--- normalizeRoomAlias (design §8 step 2) ---");
check("normalize: bare name -> #name:domain", normalizeRoomAlias("proj", "https://hs.example") === "#proj:hs.example");
check("normalize: #name -> #name:domain", normalizeRoomAlias("#proj", "https://hs.example") === "#proj:hs.example");
check("normalize: full alias with its own domain passes through", normalizeRoomAlias("#proj:other.example", "https://hs.example") === "#proj:other.example");

// --- runRoomStep -----------------------------------------------------------
console.log("\n--- runRoomStep (design §8): exists / autocreate / fail-soft / cancel ---");

const ROOM_HS = "https://hs.example";
const notFound = () => {
  const e = new Error("M_NOT_FOUND: Unknown room alias");
  e.httpStatus = 404; e.errcode = "M_NOT_FOUND";
  return e;
};
const makeRoomDeps = (client, ui, extra = {}) => ({
  ui: ui ?? makeUi(),
  client,
  homeserver: ROOM_HS,
  cwd: "/home/vincent/pi-proj",
  ...extra,
});

// exists: resolved -> use it, no create
{
  const calls = [];
  const client = {
    resolveRoomAlias: async (a) => { calls.push("resolve"); return { room_id: "!exists:hs" }; },
    createRoom: async () => { calls.push("create"); throw new Error("no create expected"); },
    setRoomAlias: async () => { calls.push("alias"); },
  };
  const ui = makeUi({ input: ["pi-proj"] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: existing alias -> use it, no create/alias",
    r.ok === true && r.roomId === "!exists:hs" && r.created === false && r.alias === "#pi-proj:hs.example",
    JSON.stringify(r));
  check("room: existing -> only resolve called", calls.join(",") === "resolve", calls.join(","));
  check("room: existing -> status line says exists",
    ui.calls.notify.some((n) => String(n.message).includes("exists")),
    JSON.stringify(ui.calls.notify.map((n) => n.message)));
}

// existing + unencrypted -> warn with the startup plaintext language (point 4)
{
  const client = {
    resolveRoomAlias: async () => ({ room_id: "!plain:hs" }),
    createRoom: async () => { throw new Error("no create expected"); },
    setRoomAlias: async () => {},
    isRoomEncrypted: async () => false,
  };
  const ui = makeUi({ input: ["pi-proj"] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: existing UNENCRYPTED -> plaintext warning + e2ee 'off'",
    r.ok === true && r.e2ee === "off"
      && ui.calls.notify.some((n) => String(n.message).includes("plaintext")),
    JSON.stringify({ r, notify: ui.calls.notify.map((n) => n.message) }));
}

// existing + encrypted -> no warning, e2ee 'on'
{
  const client = {
    resolveRoomAlias: async () => ({ room_id: "!enc:hs" }),
    createRoom: async () => { throw new Error("no create expected"); },
    setRoomAlias: async () => {},
    isRoomEncrypted: async () => true,
  };
  const ui = makeUi({ input: ["pi-proj"] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: existing ENCRYPTED -> no plaintext warning + e2ee 'on'",
    r.ok === true && r.e2ee === "on"
      && !ui.calls.notify.some((n) => String(n.message).includes("plaintext")),
    JSON.stringify({ r }));
}

// absent: 404 -> createRoom (encrypted by default) + setRoomAlias
{
  const seq = [];
  const client = {
    resolveRoomAlias: async () => { seq.push("resolve"); throw notFound(); },
    createRoom: async (opts) => { seq.push(["create", opts]); return { room_id: "!new:hs" }; },
    setRoomAlias: async (roomId, alias) => { seq.push(["alias", roomId, alias]); },
  };
  const ui = makeUi({ input: ["pi-proj"], select: [TOGGLE_E2EE_OPTIONS[0]] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: absent -> created, roomId from createRoom",
    r.ok === true && r.roomId === "!new:hs" && r.created === true && r.alias === "#pi-proj:hs.example",
    JSON.stringify(r));
  const create = seq.find((s) => Array.isArray(s) && s[0] === "create");
  check("room: picking 'On' at the create encryption prompt -> isEncrypted true + empty invite + name",
    create && create[1].isEncrypted === true && create[1].invite.length === 0 && create[1].name === "pi-proj",
    JSON.stringify(create));
  const alias = seq.find((s) => Array.isArray(s) && s[0] === "alias");
  check("room: alias claimed on the created room",
    alias && alias[1] === "!new:hs" && alias[2] === "#pi-proj:hs.example", JSON.stringify(alias));
  check("room: absent -> status line says does not exist (will be created)",
    ui.calls.notify.some((n) => String(n.message).includes("does not exist")),
    JSON.stringify(ui.calls.notify.map((n) => n.message)));
}

// picking 'Off' at the create encryption prompt -> isEncrypted false
{
  let opts;
  const client = {
    resolveRoomAlias: async () => { throw notFound(); },
    createRoom: async (o) => { opts = o; return { room_id: "!n2:hs" }; },
    setRoomAlias: async () => {},
  };
  const ui = makeUi({ input: ["pi-proj"], select: [TOGGLE_E2EE_OFF] });
  const r = await runRoomStep(makeRoomDeps(client, ui, { e2ee: "off" }));
  check("room: 'Off' at create -> createRoom isEncrypted false + plaintext warning",
    r.ok === true && opts.isEncrypted === false && r.e2ee === "off"
      && ui.calls.notify.some((n) => String(n.message).includes("plaintext")),
    JSON.stringify({ opts, r }));
}

// 429 on create -> fail soft: notify + select; cancel respected
{
  const client = {
    resolveRoomAlias: async () => { throw notFound(); },
    createRoom: async () => { const e = new Error("Too Many Requests"); e.httpStatus = 429; throw e; },
    setRoomAlias: async () => {},
  };
  const ui = makeUi({ input: ["pi-proj"], select: [TOGGLE_E2EE_OPTIONS[0], "cancel"] });
  const notified = [];
  ui.notify = (m) => notified.push(String(m));
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: 429 on create -> fail soft, cancel respected",
    r.ok === false && r.cancelled === true && notified.some((m) => m.includes("Too Many Requests")),
    JSON.stringify({ r, notified }));
}

// 429 on create -> retry -> created on the second attempt
{
  let tries = 0;
  const client = {
    resolveRoomAlias: async () => { throw notFound(); },
    createRoom: async () => {
      tries++;
      if (tries === 1) { const e = new Error("Too Many Requests"); e.httpStatus = 429; throw e; }
      return { room_id: "!ok:hs" };
    },
    setRoomAlias: async () => {},
  };
  const ui = makeUi({ input: ["pi-proj", "pi-proj"], select: [TOGGLE_E2EE_OPTIONS[0], "retry", TOGGLE_E2EE_OPTIONS[0]] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: 429 -> retry -> created on second attempt",
    r.ok === true && r.roomId === "!ok:hs" && tries === 2, JSON.stringify({ r, tries }));
}

// 403 on create (e.g. alias already taken) -> same fail-soft path as 429
{
  const client = {
    resolveRoomAlias: async () => { throw notFound(); },
    createRoom: async () => { const e = new Error("Forbidden"); e.httpStatus = 403; throw e; },
    setRoomAlias: async () => {},
  };
  const ui = makeUi({ input: ["pi-proj"], select: [TOGGLE_E2EE_OPTIONS[0], "cancel"] });
  const notified = [];
  ui.notify = (m) => notified.push(String(m));
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: 403 on create -> fail soft, cancel respected",
    r.ok === false && r.cancelled === true && notified.some((m) => m.includes("Forbidden")),
    JSON.stringify({ r, notified }));
}

// cancel at the input -> cancelled, no client call
{
  let called = 0;
  const client = {
    resolveRoomAlias: async () => { called++; },
    createRoom: async () => { called++; },
    setRoomAlias: async () => { called++; },
  };
  const r = await runRoomStep(makeRoomDeps(client, makeUi()));
  check("room: cancel at the input -> cancelled, no client call",
    r.ok === false && r.cancelled === true && called === 0, JSON.stringify(r));
}

// resolve hard-error (non-404) -> error result, no create
{
  let created = false;
  const client = {
    resolveRoomAlias: async () => { const e = new Error("Internal"); e.httpStatus = 500; throw e; },
    createRoom: async () => { created = true; return { room_id: "!x" }; },
    setRoomAlias: async () => {},
  };
  const ui = makeUi({ input: ["pi-proj"] });
  const r = await runRoomStep(makeRoomDeps(client, ui));
  check("room: hard resolve error (500) -> error result, no create",
    r.ok === false && r.cancelled === false && r.error === "Internal" && created === false,
    JSON.stringify(r));
}

// ===========================================================================
// Story 4: Config toggles + onboarding tour (design §9/§10)
// ===========================================================================

console.log("\n--- runToggleSteps (design §9): two selects + tour, default first ---");
{
  const ui = makeUi({
    select: [TOGGLE_AUTOCONNECT_OPTIONS[0], TOGGLE_THREADS_OPTIONS[0], TOUR_OPTIONS[1]],
  });
  const r = await runToggleSteps(ui);
  check("toggles: accepting the default rows → autoConnect/threads true, tour false (no e2ee asked)",
    r.ok === true && r.autoConnect === true && r.threads === true && r.tour === false && r.e2ee === undefined,
    JSON.stringify(r));
  check("toggles: default option is first and marked (default)",
    TOGGLE_AUTOCONNECT_OPTIONS[0].includes("default") && TOGGLE_THREADS_OPTIONS[0].includes("default"),
    JSON.stringify([TOGGLE_AUTOCONNECT_OPTIONS, TOGGLE_THREADS_OPTIONS]));
  check("toggles: the threads question carries the Element X copy line (design §9)",
    ui.calls.select.some((s) => String(s.title).includes("Enable thread replies") && String(s.title).includes("Settings → Labs")),
    JSON.stringify(ui.calls.select.map((s) => s.title)));
  check("toggles: the e2ee question is NOT asked here (FINDING-012 moved it to room creation)",
    !ui.calls.select.some((s) => String(s.title).includes("encryption")),
    JSON.stringify(ui.calls.select.map((s) => s.title)));
}
{
  const ui = makeUi({ select: [TOGGLE_AUTOCONNECT_NO, TOGGLE_THREADS_FLAT, TOUR_YES] });
  const r = await runToggleSteps(ui);
  check("toggles: picking the non-default rows → autoConnect/threads false, tour true",
    r.ok === true && r.autoConnect === false && r.threads === false && r.tour === true,
    JSON.stringify(r));
}
{
  const ui = makeUi({ select: [TOGGLE_AUTOCONNECT_OPTIONS[0], TOGGLE_THREADS_OPTIONS[0], null] });
  const r = await runToggleSteps(ui);
  check("toggles: Esc at the tour select → cancelled",
    r.ok === false && r.cancelled === true, JSON.stringify(r));
}

console.log("\n--- buildTourPrompt (design §10): one canned prompt, matrix-help source ---");
{
  const p = buildTourPrompt("HELP-CONTENT-XYZ");
  check("tour prompt: embeds the matrix-help content verbatim", p.includes("HELP-CONTENT-XYZ"));
  check("tour prompt: instructs the agent to walk the room through a tour", /tour/i.test(p) && /room/i.test(p));
}

// ===========================================================================
// Story 5: verified-probe regression tier (design §15) + device-id default fix
// ===========================================================================
// Fixtures only — the live probes stay manual (network). These lock the
// server-side login chain + MAS device-scope policy as proven on tst2
// (Synapse 1.151.0 / MAS 1.15.0) without a phone.

// The MAS device-scope policy regex, verbatim from MAS 1.15.0
// policies/authorization_grant/authorization_grant.rego (2026-10):
//   regex.match(`^urn:matrix:client:device:[A-Za-z0-9._~!$&'()*+,;=:@/-]{10,}$`, scope)
const MAS_DEVICE_SCOPE_RE = /^urn:matrix:client:device:[A-Za-z0-9._~!$&'()*+,;=:@/-]{10,}$/;

// Fixture: GET /_matrix/client/versions (tst2, Synapse 1.151.0). Only the
// unstable_features map is load-bearing — it distinguishes the 2024 vs 2025
// MSC4108 feature shapes.
const VERSIONS_FIXTURE = {
  versions: ["r0.0.1", "r0.1.0", "r0.2.0", "r0.3.0", "r0.4.0"],
  unstable_features: {
    "org.matrix.msc4108": true, // 2024 MSC4108 variant present
    "org.matrix.msc4380.stable": true,
    "fi.mau.msc2815": false,
    // NOTE: no MSC4388 key — the 2025 variant is absent on Synapse 1.151.
  },
};

// Fixture: GET /_matrix/client/v1/auth_metadata (tst2-mas, MAS 1.15.0).
const AUTH_METADATA_FIXTURE = {
  issuer: "https://tst2-mas.r3d.nl/",
  account_management_uri: "https://tst2-mas.r3d.nl/account/",
  authorization_endpoint: "https://tst2-mas.r3d.nl/authorize",
  token_endpoint: "https://tst2-mas.r3d.nl/oauth2/token",
  jwks_uri: "https://tst2-mas.r3d.nl/oauth2/keys.json",
  registration_endpoint: "https://tst2-mas.r3d.nl/oauth2/registration",
  scopes_supported: ["openid", "email"],
  response_types_supported: ["code", "id_token", "code id_token"],
  response_modes_supported: ["form_post", "query", "fragment"],
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "client_credentials",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
  token_endpoint_auth_methods_supported: [
    "client_secret_basic", "client_secret_post", "client_secret_jwt",
    "private_key_jwt", "none",
  ],
  revocation_endpoint: "https://tst2-mas.r3d.nl/oauth2/revoke",
  introspection_endpoint: "https://tst2-mas.r3d.nl/oauth2/introspect",
  code_challenge_methods_supported: ["plain", "S256"],
  userinfo_endpoint: "https://tst2-mas.r3d.nl/oauth2/userinfo",
  device_authorization_endpoint: "https://tst2-mas.r3d.nl/oauth2/device",
  "org.matrix.matrix-authentication-service.graphql_endpoint": "https://tst2-mas.r3d.nl/graphql",
};

// Mirror of the js-sdk OAuth2.registerClient payload (RFC 7591 dynamic
// client registration). grant_types MUST include the device_code grant.
const REGISTRATION_PAYLOAD = {
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_name: "pi-matrix-integration",
  client_uri: "https://pi-matrix-integration.example.local/",
  redirect_uris: ["https://pi-matrix-integration.example.local/callback"],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
};

// Fixture: the MAS token-endpoint response for a device grant (2026-10
// finding). It carries ONLY the tokens — no user_id / device_id — so the
// identity source is the whoami call, not the token response.
const TOKEN_RESPONSE_FIXTURE = {
  access_token: "syt_fixture_access_token",
  refresh_token: "syt_fixture_refresh_token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "urn:matrix:client:api:* urn:matrix:client:device:PI_AGENT_1",
};

console.log("\n--- regression tier: capability probe (2024 vs 2025 feature shape) ---");
check("probe: 2024 MSC4108 variant present (unstable_features.org.matrix.msc4108 === true)",
  VERSIONS_FIXTURE.unstable_features["org.matrix.msc4108"] === true,
  JSON.stringify(VERSIONS_FIXTURE.unstable_features));
check("probe: 2025 MSC4388 variant absent on Synapse 1.151 (gated path)",
  !("org.matrix.msc4388" in VERSIONS_FIXTURE.unstable_features),
  JSON.stringify(Object.keys(VERSIONS_FIXTURE.unstable_features)));

console.log("\n--- regression tier: auth metadata (js-sdk isValidAuthMetadata) ---");
check("metadata: the verified fixture passes js-sdk isValidAuthMetadata",
  isValidAuthMetadata(AUTH_METADATA_FIXTURE) === true);
check("metadata: carries the device-authorization + registration endpoints",
  typeof AUTH_METADATA_FIXTURE.device_authorization_endpoint === "string" &&
  typeof AUTH_METADATA_FIXTURE.registration_endpoint === "string" &&
  AUTH_METADATA_FIXTURE.grant_types_supported.includes("urn:ietf:params:oauth:grant-type:device_code"));

console.log("\n--- regression tier: dynamic registration payload (OAuth2.registerClient mirror) ---");
check("registration: grant_types includes the device_code grant",
  REGISTRATION_PAYLOAD.grant_types.includes("urn:ietf:params:oauth:grant-type:device_code"),
  JSON.stringify(REGISTRATION_PAYLOAD.grant_types));
check("registration: public-client shape (auth method none, code response)",
  REGISTRATION_PAYLOAD.token_endpoint_auth_method === "none" &&
  REGISTRATION_PAYLOAD.response_types.includes("code"),
  JSON.stringify(REGISTRATION_PAYLOAD));

console.log("\n--- regression tier: DAG scope construction (js-sdk generateScope) ---");
check("scope: generateScope('PI_AGENT_1') builds the api + device scopes",
  generateScope("PI_AGENT_1") === "urn:matrix:client:api:* urn:matrix:client:device:PI_AGENT_1",
  generateScope("PI_AGENT_1"));

console.log("\n--- regression tier: MAS device-scope policy regex ---");
const deviceScopeOf = (id) => generateScope(id).split(" ").find((s) => s.startsWith("urn:matrix:client:device:"));
check("policy: PI_AGENT (8 chars) FAILS the 10-char minimum",
  !MAS_DEVICE_SCOPE_RE.test(deviceScopeOf("PI_AGENT")), deviceScopeOf("PI_AGENT"));
check("policy: PIAGENT (7 chars) FAILS the 10-char minimum",
  !MAS_DEVICE_SCOPE_RE.test(deviceScopeOf("PIAGENT")), deviceScopeOf("PIAGENT"));
check("policy: PI_AGENT_1 (10 chars) PASSES the device-scope regex",
  MAS_DEVICE_SCOPE_RE.test(deviceScopeOf("PI_AGENT_1")), deviceScopeOf("PI_AGENT_1"));

console.log("\n--- regression tier: token-response shape (no user_id/device_id) ---");
check("token: carries access_token + refresh_token",
  typeof TOKEN_RESPONSE_FIXTURE.access_token === "string" && typeof TOKEN_RESPONSE_FIXTURE.refresh_token === "string");
check("token: has NO user_id/device_id (whoami is the identity source)",
  !("user_id" in TOKEN_RESPONSE_FIXTURE) && !("device_id" in TOKEN_RESPONSE_FIXTURE),
  JSON.stringify(Object.keys(TOKEN_RESPONSE_FIXTURE)));

console.log("\n--- device-id default fix (MAS policy shape) ---");
{
  const { resolveDeviceId } = await jiti.import(path.join(EXT_DIR, "src/sdk-client.ts"));
  check("device-id: fresh login falls back to PI_AGENT_1 when none configured",
    resolveDeviceId(undefined, undefined) === "PI_AGENT_1", resolveDeviceId(undefined, undefined));
  check("device-id: a configured opts deviceId wins",
    resolveDeviceId("custom-device", undefined) === "custom-device");
  check("device-id: the credentials file's device_id beats the default",
    resolveDeviceId(undefined, "from-cred") === "from-cred");
  check("device-id: an explicit deviceId beats the credentials file's id",
    resolveDeviceId("custom-device", "from-cred") === "custom-device");
  check("device-id: a mismatched explicit deviceId reports both ids",
    (() => {
      let reported;
      resolveDeviceId("custom-device", "from-cred",
        (configured, file) => { reported = `${configured}|${file}`; });
      return reported === "custom-device|from-cred";
    })());
  check("device-id: no mismatch report when the ids agree or one is missing",
    (() => {
      let calls = 0;
      resolveDeviceId("same", "same", () => calls++);
      resolveDeviceId(undefined, "from-cred", () => calls++);
      resolveDeviceId("custom", undefined, () => calls++);
      return calls === 0;
    })());
  check("device-id: PI_AGENT_1 passes the MAS device-scope policy",
    MAS_DEVICE_SCOPE_RE.test(deviceScopeOf(resolveDeviceId(undefined, undefined))));
}

finish();
