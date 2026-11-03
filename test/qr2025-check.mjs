/**
 * QR login (2025 variant, MSC4108/MSC4388) tests — feature toggle `qr2025`
 * (design DESIGN-LOGIN-ONBOARDING.md §5/§6/§16).
 *
 * Hermetic: no network, no live server, no phone.
 *   - the vendored modules LOAD (the import rewrites resolve against the
 *     installed matrix-js-sdk 42.x — the compile gate of the vendoring)
 *   - renderQr2025 round-trips through an INDEPENDENT decoder (jsQR):
 *     encode → terminal half-blocks → pixels → decode == original bytes
 *   - the capability probe matrix: real-crypto gap (the known blocker),
 *     no-device-grant, 404 (flag off), 401 (authenticated mode), 200 ok
 *   - DAG plumbing: client id reuse/registration (RFC 7591), device id
 *   - QrPane: Esc cancels
 *   - dialogue wiring: toggle off unchanged; toggle on + QR unavailable +
 *     no password flow → fail fast (no doomed username prompt)
 *
 * NOT covered hermetically (live test, design §15): the select + full
 * runQr2025Login happy path — it needs the MSC4388 rendezvous server and a
 * phone, and the local crypto gap (§16) blocks the secure channel today.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createPiJiti, EXT_DIR, makeCheck } from "./_harness.mjs";

const { check, finish } = makeCheck("qr2025");
const jiti = await createPiJiti(import.meta.url);
const require = createRequire(import.meta.url);
const jsQR = require("jsqr");

const qr = await jiti.import(path.join(EXT_DIR, "src/qr2025/index.ts"));
const { QrPane, runLoginDialogue, TOGGLE_AUTOCONNECT_OPTIONS, TOGGLE_THREADS_OPTIONS, TOGGLE_E2EE_OPTIONS, TOUR_OPTIONS } = await jiti.import(path.join(EXT_DIR, "src/login.ts"));

check("vendored modules load (import rewrites resolve)",
  typeof qr.isQr2025Available === "function" &&
  typeof qr.runQr2025Login === "function" &&
  typeof qr.renderQr2025 === "function");

// ---------------------------------------------------------------------------
// renderQr2025 — terminal QR round-trip via an independent decoder
// ---------------------------------------------------------------------------

{
  // A 2025-variant-shaped payload: "MATRIX" + type 0x03 + intent + 32-byte
  // key + length-prefixed session id + base url. Content is opaque to the
  // round-trip test — a FIXED fill (0x42) is used because jsQR (a 2017
  // decoder) misdetects the version/mask on some random module patterns
  // (deterministic content always decodes; the phone uses a maintained
  // decoder). ponytail: upgrade the test decoder if stronger coverage is
  // wanted; the renderer itself is verified by the byte-exact equality.
  const payload = Buffer.alloc(84, 0x42);
  payload.write("MATRIX", 0, "ascii");
  payload.writeUInt8(0x03, 6);
  payload.writeUInt8(0x00, 7);
  payload.write("abc123session!", 60, "ascii");
  const payloadBytes = new Uint8Array(payload);
  const terminal = qr.renderQr2025(payloadBytes);
  check("render: terminal output is half-block lines",
    terminal.split("\n").length > 10 && /[█▄]/.test(terminal),
    terminal.slice(0, 40));
  // Parse the half-blocks back to a pixel grid (█ = both, ▄ = bottom,
  // ▀ = top). Row-major: each terminal line becomes TWO pixel rows — all
  // top pixels first, then all bottom pixels.
  const lines = terminal.split("\n");
  const width = Math.max(...lines.map((l) => l.length));
  const grid = [];
  for (const line of lines) {
    const top = [];
    const bottom = [];
    for (let x = 0; x < width; x++) {
      const c = line[x] ?? " ";
      top.push(c === "█" || c === "▀" ? 255 : 0);
      bottom.push(c === "█" || c === "▄" ? 255 : 0);
    }
    grid.push(top, bottom);
  }
  const height = grid.length;
  const data = new Uint8ClampedArray(width * height * 4); // jsQR wants RGBA
  grid.forEach((row, y) =>
    row.forEach((v, x) => {
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }),
  );
  const decoded = jsQR(data, width, height);
  check("render: independent decode (jsQR) recovers the bytes",
    decoded != null && decoded.data.length === payloadBytes.length &&
    Buffer.from(decoded.data).equals(Buffer.from(payloadBytes)),
    `decoded=${decoded ? decoded.data.length : "null"} want=${payloadBytes.length}`);
}

// ---------------------------------------------------------------------------
// QrPane — Esc cancels
// ---------------------------------------------------------------------------

{
  const pane = new QrPane("qr-text");
  let fired = 0;
  pane.onEscape = () => fired++;
  pane.handleInput("a");
  check("QrPane: ordinary input does not fire Esc", fired === 0);
  pane.handleInput("\u001b");
  check("QrPane: Esc fires the cancel callback", fired === 1);
}

// ---------------------------------------------------------------------------
// makeDeviceId
// ---------------------------------------------------------------------------

{
  const a = qr.makeDeviceId();
  const b = qr.makeDeviceId();
  check("deviceId: 10 uppercase alphanumerics", /^[A-Z0-9]{10}$/.test(a), a);
  check("deviceId: random per call", a !== b);
}

// ---------------------------------------------------------------------------
// getOrRegisterClientId — RFC 7591 + persistence
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qr2025-cli-"));
  const file = path.join(dir, "oauth-client-id");

  // First login: register.
  let registrations = 0;
  const fetchRegister = async (url, init) => {
    registrations++;
    check("clientId: POST to the MAS registration endpoint",
      String(url).endsWith("/oauth2/registration") && init.method === "POST");
    return {
      ok: true,
      status: 200,
      json: async () => ({ client_id: "registered-client-1" }),
    };
  };
  const id1 = await qr.getOrRegisterClientId("https://mas.example", fetchRegister, dir);
  check("clientId: registration returns the client id", id1 === "registered-client-1");
  check("clientId: persisted for reuse", fs.existsSync(file));

  // Re-login: reuse, no second registration.
  const id2 = await qr.getOrRegisterClientId("https://mas.example", async () => {
    throw new Error("should not fetch when the id is persisted");
  }, dir);
  check("clientId: re-login reuses the persisted id (no fetch)",
    id2 === "registered-client-1" && registrations === 1);

  // Registration failure surfaces the MAS error.
  const fetchFail = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "invalid_client_metadata" }),
  });
  let failed = false;
  try {
    await qr.getOrRegisterClientId("https://mas.example", fetchFail, path.join(dir, "fresh"));
  } catch (e) {
    failed = e.message.includes("invalid_client_metadata");
  }
  check("clientId: registration failure carries the MAS error", failed);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// isQr2025Available — the probe matrix (design §16 gate)
// ---------------------------------------------------------------------------

const FAKE_METADATA = {
  issuer: "https://mas.example",
  base_url: "https://mas.example",
  authorization_endpoint: "https://mas.example/oauth2/authorize",
  token_endpoint: "https://mas.example/oauth2/token",
  revocation_endpoint: "https://mas.example/oauth2/revoke",
  registration_endpoint: "https://mas.example/oauth2/registration",
  device_authorization_endpoint: "https://mas.example/oauth2/device_authorization",
  response_modes_supported: ["query", "fragment"],
  response_types_supported: ["code"],
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
  code_challenge_methods_supported: ["S256"],
};

function probeFetch(opts = {}) {
  // opts: { metadata?, rendezvous: {status, body} }
  const jsonHeaders = new Headers({ "Content-Type": "application/json" });
  const fn = async (url) => {
    const u = String(url);
    if (u.includes("/versions"))
      return { ok: true, status: 200, headers: jsonHeaders, json: async () => ({ versions: [] }) };
    if (u.includes("auth_metadata")) {
      return { ok: true, status: 200, headers: jsonHeaders, json: async () => opts.metadata ?? FAKE_METADATA };
    }
    if (u.includes("msc4388")) {
      const r = opts.rendezvous ?? { status: 200, body: { create_available: true } };
      return {
        ok: r.status < 400,
        status: r.status,
        headers: jsonHeaders,
        json: async () => r.body,
        text: async () => JSON.stringify(r.body ?? {}),
      };
    }
    throw new Error(`probeFetch: unexpected url ${u}`);
  };
  return fn;
}

{
  // The REAL check (no override): today's published crypto-wasm lacks the
  // HPKE bindings — the probe reports it, not an error.
  const real = await qr.isQr2025Available("https://hs.example", probeFetch());
  check("probe: real crypto state is the documented blocker",
    real.ok === false && real.reason.includes("crypto-wasm"),
    JSON.stringify(real));
}
{
  const meta = { ...FAKE_METADATA, grant_types_supported: ["authorization_code", "refresh_token"] };
  const r = await qr.isQr2025Available("https://hs.example", probeFetch({ metadata: meta }), { cryptoChannel: true });
  check("probe: no device authorization grant -> reason",
    r.ok === false && r.reason.includes("device authorization"), JSON.stringify(r));
}
{
  const r = await qr.isQr2025Available("https://hs.example", probeFetch({ rendezvous: { status: 404, body: { errcode: "M_NOT_FOUND" } } }), { cryptoChannel: true });
  check("probe: 404 (flag off) -> msc4388_mode reason",
    r.ok === false && r.reason.includes("msc4388_mode"), JSON.stringify(r));
}
{
  const r = await qr.isQr2025Available("https://hs.example", probeFetch({ rendezvous: { status: 401, body: { errcode: "M_UNKNOWN" } } }), { cryptoChannel: true });
  check("probe: 401 (authenticated mode) -> reason",
    r.ok === false && r.reason.includes("authenticated"), JSON.stringify(r));
}
{
  const r = await qr.isQr2025Available("https://hs.example", probeFetch(), { cryptoChannel: true });
  check("probe: 200 create_available -> ok", r.ok === true, JSON.stringify(r));
}
{
  const r = await qr.isQr2025Available("https://hs.example", probeFetch({ rendezvous: { status: 200, body: { create_available: false } } }), { cryptoChannel: true });
  check("probe: create_available false -> reason", r.ok === false, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// runLoginDialogue wiring — toggle off unchanged, toggle on fail-fast
// ---------------------------------------------------------------------------

const HS = "https://tst2-matrix.r3d.nl";

function loginFetch(flows) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/versions")) return { ok: true, status: 200, json: async () => ({ versions: [] }) };
    if (u.includes("/login")) return { ok: true, status: 200, json: async () => ({ flows }) };
    throw new Error(`loginFetch: unexpected url ${u}`);
  };
}

function scriptedUi(script = {}) {
  const calls = { input: 0, select: 0, password: 0, notify: [] };
  const answers = {
    input: script.input ?? [],
    select: script.select ?? [],
    password: script.password ?? [],
  };
  let iInput = 0;
  let iSelect = 0;
  let iPassword = 0;
  return {
    calls,
    async input(_title, _ph) {
      calls.input++;
      const a = answers.input[iInput++];
      return a === undefined ? null : a;
    },
    async select(_title, _options) {
      calls.select++;
      const a = answers.select[iSelect++];
      return a === undefined ? null : a;
    },
    async confirm() {
      return true;
    },
    notify(message, kind) {
      calls.notify.push({ message, kind });
    },
    async password() {
      calls.password++;
      const a = answers.password[iPassword++];
      return a === undefined ? null : a;
    },
  };
}

{
  // Toggle OFF (the default): no-password server -> the old error, unchanged.
  const ui = scriptedUi({ input: [HS] });
  const result = await runLoginDialogue({
    ui,
    credsDir: fs.mkdtempSync(path.join(os.tmpdir(), "qr2025-dialog-")),
    updateConfig: () => {},
    fetchImpl: loginFetch([]),
    makeLoginClient: () => { throw new Error("no login should be attempted"); },
    homeserverPrefill: HS,
    // qr2025 absent -> off
  });
  check("dialogue: toggle off + no password flow -> the old error",
    result.ok === false && result.cancelled === false &&
    result.error === "No password login flow on the homeserver",
    JSON.stringify(result));
}
{
  // Toggle ON + no password flow + real (missing) crypto -> fail fast: the
  // QR reason is notified and NO username prompt is offered.
  const ui = scriptedUi({ input: [HS] });
  const result = await runLoginDialogue({
    ui,
    credsDir: fs.mkdtempSync(path.join(os.tmpdir(), "qr2025-dialog-")),
    updateConfig: () => {},
    fetchImpl: loginFetch([]),
    makeLoginClient: () => { throw new Error("no login should be attempted"); },
    homeserverPrefill: HS,
    qr2025: true,
  });
  check("dialogue: toggle on + QR unavailable + no password flow -> fail fast",
    result.ok === false && result.cancelled === false &&
    result.error === "No login method available on the homeserver",
    JSON.stringify(result));
  check("dialogue: fail fast surfaced the QR reason",
    ui.calls.notify.some((n) => n.message.includes("crypto-wasm")),
    JSON.stringify(ui.calls.notify));
  check("dialogue: fail fast did not offer a username prompt", ui.calls.input === 1);
}
{
  // Toggle ON + password server + real (missing) crypto -> the QR block
  // degrades to a warning and the credentials path runs UNCHANGED.
  const ui = scriptedUi({
    input: [HS, "vincent", "pi-updates"],
    select: [
      TOGGLE_AUTOCONNECT_OPTIONS[0],
      TOGGLE_THREADS_OPTIONS[0],
      TOGGLE_E2EE_OPTIONS[0],
      TOUR_OPTIONS[1],
    ],
    password: ["pw"],
  });
  const LOGIN_RESPONSE = {
    user_id: "@vincent:tst2-matrix.r3d.nl",
    homeserver: HS,
    device_id: "PIAGENT01",
    access_token: "fake-token",
  };
  const stub = { loginCalls: [], calls: 0 };
  const result = await runLoginDialogue({
    ui,
    credsDir: fs.mkdtempSync(path.join(os.tmpdir(), "qr2025-dialog-")),
    updateConfig: () => {},
    fetchImpl: loginFetch([{ type: "m.login.password" }]),
    makeLoginClient: () => ({
      async loginWithPassword(user, password) {
        stub.loginCalls.push({ user, password });
        return LOGIN_RESPONSE;
      },
      async resolveRoomAlias() {
        return { room_id: "!room:tst2-matrix.r3d.nl" };
      },
      async createRoom() {
        throw new Error("configured room should resolve, not be created");
      },
      async setRoomAlias() {
        throw new Error("configured room should resolve, not be re-aliased");
      },
    }),
    homeserverPrefill: HS,
    configuredRoomId: "#pi-updates:tst2-matrix.r3d.nl",
    qr2025: true,
  });
  // The room step resolves the configured alias and the toggle selects run.
  check("dialogue: toggle on + password server -> credentials path unchanged",
    result.ok === true && result.user_id === LOGIN_RESPONSE.user_id,
    JSON.stringify(result));
  check("dialogue: credentials login used the entered password",
    stub.loginCalls.length === 1 && stub.loginCalls[0].password === "pw");
  check("dialogue: QR unavailability was warned, not fatal",
    ui.calls.notify.some((n) => n.kind === "warning" && n.message.includes("crypto-wasm")),
    JSON.stringify(ui.calls.notify));
}

finish();
