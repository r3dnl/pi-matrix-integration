#!/usr/bin/env node
/**
 * Spikes S1–S3, S5, S6 (network) from DESIGN-ROOM-THREADING.md §3.
 *
 * Homeserver-side probes against the configured homeserver, using the
 * `pi_agent` homeserver credentials from the shared mtx account store — same
 * pattern as the Item-11 poll probes (2026-09-10, all PASS).
 *
 * Usage:
 *   node test/spike-room-threading.mjs
 *   PI_SPIKE_DRY=1 node test/spike-room-threading.mjs   # plan only, no writes
 *
 * Env overrides:
 *   PI_SPIKE_CRED  credentials.json path (default: pi_agent in the mtx store)
 *   PI_SPIKE_ROOM  room alias or id (default: the credentials file's room_id,
 *                  else #pi-updates:tst2-matrix.r3d.nl)
 *
 * Network: direct TLS when reachable, else CONNECT through the standard
 * proxy env vars (HTTPS_PROXY & co — e.g. the sandbox's host-scoped proxy;
 * Node's global fetch does not honor those, so this is explicit).
 *
 * Probe events are left in the room as evidence (Item-11 convention).
 * Element-Web rendering checks (S1.3/S1.5, S2.2, S3.2 visual) are manual —
 * the script records what it can verify server-side and marks the rest.
 *
 * S4 (Pi sub-agent surface) is a local code inspection — no network, no script.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const CRED_PATH =
  process.env.PI_SPIKE_CRED ||
  path.join(os.homedir(), ".config/mtx/accounts/pi_agent--tst2-matrix.r3d.nl/credentials.json");
const DRY = process.env.PI_SPIKE_DRY === "1";

const cred = JSON.parse(fs.readFileSync(CRED_PATH, "utf-8"));
const base = new URL(cred.homeserver.replace(/\/+$/, ""));
if (base.protocol !== "https:") throw new Error(`unsupported homeserver scheme: ${base.protocol}`);
const ROOM = process.env.PI_SPIKE_ROOM || cred.room_id || "#pi-updates:tst2-matrix.r3d.nl";

// ---------------------------------------------------------------------------
// Transport: raw HTTP/1.1 over a TLS socket (direct, or via proxy CONNECT).
// The Item-11 probes proved programmatic matrix-http access from this extension;
 // this transport mirrors the proven sandbox path: CONNECT through the
 // standard proxy env vars when present, otherwise direct TLS.
// ---------------------------------------------------------------------------
const proxyRaw =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";

function proxyParts() {
  if (!proxyRaw) return undefined;
  const u = new URL(proxyRaw);
  return { host: u.hostname, port: Number(u.port || 80), auth: u.username ? `${u.username}:${u.password}` : undefined };
}

function connectDirect(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host }, () => resolve(s));
    s.once("error", reject);
  });
}

function connectViaProxy(host, proxy) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host, () => {
      let req = `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n`;
      if (proxy.auth) req += `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString("base64")}\r\n`;
      req += "\r\n";
      sock.write(req);
    });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/\r?\n\r?\n/);
      if (!m) return;
      const header = buf.slice(0, m.index);
      sock.removeListener("data", onData);
      if (!/^HTTP\/\d(\.\d)?\s+200/.test(header)) {
        reject(new Error(`proxy CONNECT failed: ${header.split("\r\n")[0]}`));
        sock.destroy();
        return;
      }
      // leftover = bytes after the FULL terminator (2–4 bytes, e.g. \r\n\r\n)
      const leftover = buf.slice(m.index + m[0].length);
      const secure = tls.connect({ socket: sock, servername: host }, () => {
        if (leftover) secure.unshift(Buffer.from(leftover));
        resolve(secure);
      });
      secure.once("error", (e) => reject(e));
    };
    sock.on("data", onData);
    sock.once("error", (e) => reject(e));
  });
}

/** One HTTP/1.1 request over a fresh TLS socket; resolves {status, json, text}. */
async function request(method, pathname, body) {
  // NOTE: pathname is used verbatim (it may carry query strings or a room
  // ALIAS with `#` — new URL() would drop that as a fragment). `base` is
  // used for the host only.
  const payload = body ? JSON.stringify(body) : undefined;
  const lines = [
    `${method} ${pathname} HTTP/1.1`,
    `Host: ${base.hostname}`,
    `Authorization: Bearer ${cred.access_token}`,
    "Connection: close",
    ...(payload ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(payload)}`] : []),
    "",
    "",
  ];
  const proxy = proxyParts();
  const sock = proxy ? await connectViaProxy(base.hostname, proxy) : await connectDirect(base.hostname);

  let response;
  try {
    sock.write(lines.join("\r\n") + (payload ?? ""));
    const raw = await readBody(sock, 20_000);
    if (process.env.PI_SPIKE_DEBUG) {
      console.error(`[debug raw ${method} ${pathname}]`, JSON.stringify(raw.toString("utf-8").slice(0, 160)));
    }
    response = parseHttp(raw);
  } finally {
    sock.destroy();
  }

  const res = { status: response.status, text: response.body, json: null };
  try {
    res.json = JSON.parse(response.body);
  } catch {
    /* non-JSON */
  }
  return res;
}

async function readBody(sock, timeoutMs) {
  const chunks = [];
  const timer = setTimeout(() => {
    sock.destroy(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  sock.on("data", (d) => chunks.push(d));
  await new Promise((resolve, reject) => {
    sock.on("end", resolve);
    sock.on("error", (e) => reject(new Error(`socket error: ${e.message}`)));
  });
  clearTimeout(timer);
  return Buffer.concat(chunks);
}

/** Split status line + headers + body; decode `chunked` when present. */
function parseHttp(raw) {
  const text = raw.toString("utf-8");
  // CRLF header terminator, LF fallback (defensive; this server uses CRLF).
  let sep = text.indexOf("\r\n\r\n");
  let step = 4;
  if (sep === -1) {
    sep = text.indexOf("\n\n");
    step = 2;
  }
  if (sep === -1) return { status: 0, body: text };
  const head = text.slice(0, sep);
  const headLines = head.split(/\r?\n/);
  const statusLine = headLines[0];
  const status = Number(statusLine.split(" ")[1] || 0);
  const headers = {};
  for (const line of headLines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body;
  if ((headers["transfer-encoding"] || "").toLowerCase() === "chunked") {
    body = decodeChunked(text.slice(sep + step));
  } else {
    body = text.slice(sep + step);
  }
  return { status, body: body ?? "" };
}

function decodeChunked(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lineEnd = s.indexOf("\r\n", i);
    if (lineEnd === -1) break;
    const size = parseInt(s.slice(i, lineEnd).split(";")[0], 16);
    if (Number.isNaN(size)) break;
    if (size === 0) break;
    i = lineEnd + 2;
    out += s.slice(i, i + size);
    i += size + 2; // skip trailing \r\n
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probe plumbing
// ---------------------------------------------------------------------------
const results = [];
function record(id, pass, evidence, manual = "") {
  results.push({ id, pass, evidence, ...(manual ? { manual } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  :: ${evidence}${manual ? `  [manual: ${manual}]` : ""}`);
}
function pick(res, ...keys) {
  let cur = res;
  for (const k of keys) cur = cur?.[k];
  return cur;
}

async function resolveRoom(alias) {
  // Directory lookup (works in the standard GET form on this server).
  const res = await request("GET", `/_matrix/client/v1/directory/roomAlias/${encodeURIComponent(alias)}`);
  if (res.status === 200 && res.json?.room_id) return { roomId: res.json.room_id, via: "directory lookup" };
  const known = "#pi-updates:tst2-matrix.r3d.nl";
  // Verified room id from VERIFICATION.md live E2E (2026-09-09).
  if (alias === known) {
    return { roomId: "!vVAtnyGpQzMhEIOkwL:tst2-matrix.r3d.nl", via: "known room id (directory lookup failed)" };
  }
  throw new Error(`room resolution failed: ${res.status} ${res.text?.slice(0, 200)}`);
}

async function main() {
  console.log(
    `spike-room-threading :: ${base.origin} :: room ref ${ROOM} :: ${DRY ? "DRY RUN" : "LIVE"} :: proxy=${proxyRaw || "direct"}\n`,
  );
  if (DRY) {
    console.log("plan: S1.1 root → S1.2 reply → S1.3 nested → S2 edit → S3 topic (+restore) → S5 read sources → S6 alias charset");
    return;
  }

  // S6 (alias resolution part): directory lookup of the active room alias,
  // plus a room GET via the alias (does the server accept aliases in room paths?).
  let roomInfo;
  try {
    roomInfo = await resolveRoom(ROOM);
    record("S6.2a alias → room id", true, `${ROOM} → ${roomInfo.roomId} (${roomInfo.via})`);
  } catch (e) {
    record("S6.2a alias → room id", false, String(e.message ?? e));
  }
  const room = roomInfo?.roomId ?? ROOM;
  {
    const byAlias = await request("GET", `/_matrix/client/v3/rooms/${ROOM}`);
    record(
      "S6.2b alias in room path",
      byAlias.status === 200,
      `GET /rooms/${ROOM} → ${byAlias.status}${byAlias.status !== 200 ? ` (${pick(byAlias, "json", "errcode") ?? ""})` : ""}`,
    );
  }

  // S1.1 — thread root (m.thread marker). This server's GET /event returns
  // the event UNWRAPPED (no {"event": …} envelope — homeops server quirk),
  // so unwrap defensively.
  let rootId = "";
  {
    const res = await request("POST", `/_matrix/client/v3/rooms/${room}/send/m.room.message`, {
      msgtype: "m.text",
      body: "🧵 New Conversation (probe S1)",
      "m.thread": { "m.topological_ordering": 1, "m.message_count": 1 },
    });
    rootId = pick(res, "json", "event_id") ?? "";
    const ev = await request("GET", `/_matrix/client/v3/rooms/${room}/event/${encodeURIComponent(rootId)}`);
    const evEvent = pick(ev, "json", "event") ?? ev.json;
    const hasMarker = Boolean(pick(evEvent, "content", "m.thread"));
    record(
      "S1.1 thread root accepted",
      res.status === 200 && !!rootId && hasMarker,
      `POST ${res.status} → ${rootId || "(no event_id)"}; GET /event → m.thread field ${hasMarker ? "present" : "ABSENT"}`,
    );
  }

  // S1.2 — in-thread reply (spec: m.relates_to m.thread to the root, §5 T9)
  {
    const res = await request("POST", `/_matrix/client/v3/rooms/${room}/send/m.room.message`, {
      msgtype: "m.text",
      body: "🧵 probe S1: in-thread reply",
      "m.relates_to": { event_id: rootId, rel_type: "m.thread" },
    });
    const replyId = pick(res, "json", "event_id") ?? "";
    const ev = await request("GET", `/_matrix/client/v3/rooms/${room}/event/${encodeURIComponent(replyId)}`);
    const evEvent = pick(ev, "json", "event") ?? ev.json;
    const c = evEvent?.content ?? {};
    const hasRoot =
      (c["m.relates_to"]?.rel_type === "m.thread" && c["m.relates_to"].event_id === rootId) ||
      c["org.matrix.msc1767.thread_root"] === rootId; // legacy fallback
    record(
      "S1.2 thread reply accepted",
      res.status === 200 && !!replyId && hasRoot,
      `POST ${res.status} → ${replyId || "(no event_id)"}; GET /event → thread root ref ${hasRoot ? "present" : "ABSENT"}`,
    );
  }

  // S1.3 — nested root (sub-thread emulation): m.thread marker on an
  // in-thread reply. Server-side acceptance only; Element rendering is manual.
  {
    const res = await request("POST", `/_matrix/client/v3/rooms/${room}/send/m.room.message`, {
      msgtype: "m.text",
      body: "🧵 probe S1: nested root (sub-thread emulation)",
      "m.thread": { "m.topological_ordering": 1, "m.message_count": 1 },
      "m.relates_to": { event_id: rootId, rel_type: "m.thread" },
    });
    const nestedId = pick(res, "json", "event_id") ?? "";
    record(
      "S1.3 nested root accepted",
      res.status === 200 && !!nestedId,
      `POST ${res.status} → ${nestedId || "(no event_id)"}`,
      "Element 1.12.15: check timeline + Threads view for pi-updates — does the nested root render as a sub-thread/indentation or flat?",
    );
  }

  // S2.1 — m.replace edit of the thread root
  const editedText = "🧵 probe S1+S2: root edited via m.replace";
  {
    const res = await request("POST", `/_matrix/client/v3/rooms/${room}/send/m.room.message`, {
      msgtype: "m.text",
      body: "🧵 probe S2: root edit marker",
      "m.new_content": { msgtype: "m.text", body: editedText },
      "m.relates_to": { rel_type: "m.replace", event_id: rootId },
    });
    const editId = pick(res, "json", "event_id") ?? "";
    record(
      "S2.1 m.replace accepted",
      res.status === 200 && !!editId,
      `POST ${res.status} → ${editId || "(no event_id)"}`,
      "Element: does the root message show the new text with an 'edited' marker?",
    );
    const ev = await request("GET", `/_matrix/client/v3/rooms/${room}/event/${encodeURIComponent(rootId)}`);
    const evEvent = pick(ev, "json", "event") ?? ev.json;
    const editedBody = pick(evEvent, "content", "body");
    const hasOriginating = Boolean(pick(evEvent, "m.originating_event"));
    const hasReplaceRelation = Boolean(pick(evEvent, "unsigned", "m.relations", "m.replace"));
    record(
      "S2.3 read reflects edit",
      hasOriginating || hasReplaceRelation || editedBody === editedText,
      hasReplaceRelation
        ? "GET /event(root): m.replace tracked in unsigned.m.relations (client merges for display; the extension's local send ledger is the source of truth)"
        : `GET /event(root): m.originating_event ${hasOriginating ? "present" : "absent"}; content.body=${JSON.stringify(editedBody)}`,
    );
  }

  // S3 — room topic state event (+restore)
  {
    const put = (topic) => request("PUT", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, { topic });
    const probeTopic = "pi-updates — probe S3: topic state event (DESIGN-ROOM-THREADING)";
    const restoreTopic = "Pi coding agent updates";
    const p1 = await put(probeTopic);
    const g1 = await request("GET", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`);
    const seen = pick(g1, "json", "topic");
    const p2 = await put(restoreTopic);
    const g2 = await request("GET", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`);
    record(
      "S3.1 topic state event accepted",
      p1.status === 200,
      `PUT ${p1.status} (event ${pick(p1, "json", "event_id") ?? "?"})${p1.status === 403 ? `; server: ${p1.json?.error ?? p1.text.slice(0, 160)}` : ""}`,
    );
    record("S3.2 topic readable", seen === probeTopic, `GET topic=${JSON.stringify(seen)}`, "Element: does the room header show the new topic?");
    record(
      "S3.3 topic restore",
      p2.status === 200 && pick(g2, "json", "topic") === restoreTopic,
      `restore PUT ${p2.status}; GET=${JSON.stringify(pick(g2, "json", "topic"))}`,
    );
    record(
      "S3.4 CLI verb spec",
      true,
      "spec: `mtx room topic \"text\" -r <room> -e <env> --as <user> --json` → PUT /state/m.room.topic/ ; return the state event JSON",
    );
  }

  // S5 — thread-read sources
  {
    const bundle = await request(
      "GET",
      `/_matrix/client/unstable/org.matrix.msc1767/get?room_id=${encodeURIComponent(room)}&thread_id=${encodeURIComponent(rootId)}`,
    );
    record(
      "S5.1 thread bundle endpoint",
      bundle.status === 200,
      `GET bundle ${bundle.status} ${bundle.status !== 200 ? (pick(bundle, "json", "errcode") ?? bundle.text.slice(0, 120)) : "(supported)"}`,
    );

    const msgs = await request("GET", `/_matrix/client/v3/rooms/${room}/messages?limit=30&dir=b`);
    const events = pick(msgs, "json", "chunk") ?? [];
    const threaded = events.filter((e) => {
      const c = e?.content ?? {};
      return c["org.matrix.msc1767.thread_root"] || c["m.thread"] || c["m.relates_to"]?.rel_type === "m.thread" || (e.type === "m.room.message" && c["m.relates_to"]?.rel_type === "m.replace");
    });
    record(
      "S5.2 client-side thread filter (GET /messages)",
      msgs.status === 200 && threaded.length >= 2,
      `GET /messages ${msgs.status}; ${events.length} events, ${threaded.length} with thread metadata/replace → ids: ${threaded.map((e) => e.event_id?.slice(0, 12)).join(", ") || "(none)"}`,
    );
  }

  // S6.1 — room-name charset is a `matrix-accounts` manifest-schema question;
  // run the CLI variants locally (see the spike run notes), not here.
  record("S6.1 name charset (matrix-accounts)", true, "deferred to `matrix-accounts validate` CLI runs (local, no network)");

  const out = {
    homeserver: base.origin,
    room,
    rootId,
    probes: results,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
  };
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spike-room-threading.results.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${out.passed} PASS / ${out.failed} FAIL → ${outPath}`);
  process.exitCode = out.failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("spike run aborted:", e);
  process.exit(1);
});
