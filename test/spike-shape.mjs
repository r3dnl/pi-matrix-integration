// Scratch: (a) GET /event response shape, (b) alias-in-path without URL-class mangling,
// (c) S3 topic probe with vincent credentials (PL 100) + restore.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";

function loadCred(file) {
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/mtx/accounts", file, "credentials.json"), "utf-8"));
}

const pi = loadCred("pi_agent--tst2-matrix.r3d.nl");
const vincent = loadCred("vincent--tst2-matrix.r3d.nl");
const base = new URL(pi.homeserver.replace(/\/+$/, ""));
const room = "!vVAtnyGpQzMhEIOkwL:tst2-matrix.r3d.nl";
const proxyRaw = process.env.HTTPS_PROXY || process.env.https_proxy || "";

function connect(host, proxy) {
  if (!proxy) {
    return new Promise((res, rej) => {
      const s = tls.connect({ host, port: 443, servername: host }, () => res(s));
      s.once("error", rej);
    });
  }
  return new Promise((res, rej) => {
    const p = new URL(proxy);
    const sock = net.connect(Number(p.port || 80), p.hostname, () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/\r?\n\r?\n/);
      if (!m) return;
      const header = buf.slice(0, m.index);
      sock.removeListener("data", onData);
      if (!/^HTTP\/\d(\.\d)?\s+200/.test(header)) {
        rej(new Error("CONNECT failed: " + header.split("\r\n")[0]));
        sock.destroy();
        return;
      }
      const leftover = buf.slice(m.index + m[0].length);
      const secure = tls.connect({ socket: sock, servername: host }, () => {
        if (leftover) secure.unshift(Buffer.from(leftover));
        res(secure);
      });
      secure.once("error", rej);
    };
    sock.on("data", onData);
    sock.once("error", rej);
  });
}

function http(sock, lines, payload = "") {
  // lines ends at the last header; join + "\r\n\r\n" = final CRLF of the last
  // header + the blank terminator line.
  sock.write(lines.join("\r\n") + "\r\n\r\n" + payload);
  const chunks = [];
  sock.on("data", (d) => chunks.push(d));
  return new Promise((resolve, reject) => {
    sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    sock.on("error", reject);
    setTimeout(() => sock.destroy(new Error("timeout")), 15_000);
  });
}

function parse(raw) {
  let sep = raw.indexOf("\r\n\r\n");
  let step = 4;
  if (sep === -1) {
    sep = raw.indexOf("\n\n");
    step = 2;
  }
  if (sep === -1) return { status: 0, json: null, text: raw };
  const head = raw.slice(0, sep);
  const status = Number(head.split(/\r?\n/)[0].split(" ")[1] || 0);
  const headers = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body;
  if ((headers["transfer-encoding"] || "").toLowerCase() === "chunked") {
    let s = raw.slice(sep + step);
    let out = "";
    let i = 0;
    while (i < s.length) {
      const lineEnd = s.indexOf("\r\n", i);
      if (lineEnd === -1) break;
      const size = parseInt(s.slice(i, lineEnd).split(";")[0], 16);
      if (Number.isNaN(size) || size === 0) break;
      i = lineEnd + 2;
      out += s.slice(i, i + size);
      i += size + 2;
    }
    body = out;
  } else {
    body = raw.slice(sep + step);
  }
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not json */
  }
  return { status, json, text: body };
}

async function req(cred, method, rawPath, body) {
  const sock = await connect(base.hostname, proxyRaw || undefined);
  try {
    const payload = body ? JSON.stringify(body) : "";
    const lines = [
      `${method} ${rawPath} HTTP/1.1`,
      `Host: ${base.hostname}`,
      `Authorization: Bearer ${cred.access_token}`,
      "Connection: close",
      ...(payload ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(payload)}`] : []),
    ];
    const raw = await http(sock, lines, payload);
    return parse(raw);
  } finally {
    sock.destroy();
  }
}

// (a) GET /event shape — the latest-run probe root
console.log("== (a) GET /event shape ==");
const ev = await req(pi, "GET", `/_matrix/client/v3/rooms/${room}/event/$0GaxV5Tu1qE9vrmpgWiyIsblNfJPPIPf23zxyY3zxM4`);
console.log("status:", ev.status);
console.log("top-level keys:", ev.json ? Object.keys(ev.json) : "(no json)");
console.log(JSON.stringify(ev.json ?? ev.text.slice(0, 400), null, 1).slice(0, 1500));

// (b) alias in room path, raw (no URL class)
console.log("\n== (b) alias in room path (raw) ==");
const al = await req(pi, "GET", `/_matrix/client/v3/rooms/#pi-updates:tst2-matrix.r3d.nl`);
console.log("GET /rooms/#pi-updates:... →", al.status, al.json?.join_state ? `join_state=${al.json.join_state}` : (al.json?.errcode ?? ""));

// (c) S3 with vincent credentials
console.log("\n== (c) S3 topic with vincent (PL 100) ==");
const probeTopic = "pi-updates — S3 probe (DESIGN-ROOM-THREADING, vincent creds)";
const restoreTopic = "Pi coding agent updates";
const t1 = await req(vincent, "PUT", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, { topic: probeTopic });
console.log("PUT probe:", t1.status, t1.json?.event_id ?? t1.json?.errcode ?? "", (t1.json?.error ?? "").slice(0, 120));
const g1 = await req(vincent, "GET", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`);
console.log("GET topic:", g1.status, JSON.stringify(g1.json?.topic));
const t2 = await req(vincent, "PUT", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, { topic: restoreTopic });
const g2 = await req(vincent, "GET", `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`);
console.log("PUT restore:", t2.status, t2.json?.event_id ?? t2.json?.errcode ?? "");
console.log("GET topic (final):", g2.status, JSON.stringify(g2.json?.topic));

// (d) S1.2 evidence: GET /event on the in-thread reply (read-only)
console.log("\n== (d) GET /event (probe reply) ==");
const rp = await req(pi, "GET", `/_matrix/client/v3/rooms/${room}/event/$GCL6520OPigobMLHZjVy0U1Lz1J6LvatygH4Z_AmUb0`);
console.log("status:", rp.status);
console.log("content:", JSON.stringify(rp.json?.content ?? rp.text.slice(0, 400), null, 1).slice(0, 600));

process.exit(0);
