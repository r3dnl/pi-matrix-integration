/**
 * E2EE-capable independent reader for the live scenario suite.
 *
 * Some test homeservers auto-enable room encryption (there is no client-side
 * opt-out), so the plain client-server reader cannot see message bodies
 * anymore. This reader is a real Matrix client on a FRESH DEVICE of one of
 * the room members (password login → its own device_id, so no other
 * device's Olm state is ever touched): it syncs, receives Megolm keys as
 * to-device traffic (the room's sending clients share keys with every
 * member device), decrypts, and serves the same `messages`/`waitUntil`
 * shape the plain RoomApi does. Assertions still run on homeserver-fetched
 * room state — decrypted — never on extension internals.
 *
 * Edits are flattened exactly like RoomApi.#flatten (m.replace → the new
 * content as `body`, `edited`/`editedId` set) so existing predicates keep
 * working.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR } from "../harness/_harness.mjs";
import { readCredentials } from "./room-api.mjs";

const RUN_TAG = String(Date.now());

function flatten(ev) {
  const c = ev.getContent?.() ?? ev.content ?? {};
  const raw = ev.rawEvent?.() ?? ev;
  const relates = c["m.relates_to"] ?? {};
  const edit = relates.rel_type === "m.replace" ? c["m.new_content"] : undefined;
  return {
    event_id: ev.getId?.() ?? raw.event_id,
    room: ev.getRoomId?.() ?? raw.room_id,
    sender: ev.getSender?.() ?? raw.sender,
    type: ev.getType?.() ?? raw.type,
    msgtype: edit?.msgtype ?? c.msgtype,
    body: edit?.body ?? c.body ?? "",
    original_body: c.body ?? "",
    edited: Boolean(edit),
    editedId: edit ? relates.event_id : undefined,
    threadRoot: relates.rel_type === "m.thread" ? relates.event_id : undefined,
    url: edit?.url ?? c.url ?? edit?.file?.url ?? c.file?.url,
    ts: ev.getTs?.() ?? raw.origin_server_ts ?? 0,
  };
}

/**
 * Log in the reader device and start syncing.
 *
 * Credentials lifecycle = the extension's own mechanism, per-instance:
 * if PI_MATRIX_READER_CREDENTIALS points at an existing credentials.json,
 * the reader rides THAT device (token login, persistent crypto store beside
 * the file — keys survive across runs, no re-mint). If the file is missing,
 * the reader logs in once with PI_MATRIX_READER_USER + _PASSWORD — which
 * creates a NEW device — and writes the credentials.json for every later
 * run. Reusing an account file whose device a live client owns would
 * overwrite that client's keys; the reader owns its own file, so it owns
 * its own device.
 */
export async function createCryptoReader(homeserver, { credentialsPath, username, password, logger = console }) {
  const jiti = await createPiJiti(import.meta.url);
  const sdk = await jiti.import("matrix-js-sdk");
  const { installFileIdb } = await jiti.import(path.join(EXT_DIR, "src/idb-file-store.ts"));

  let login;
  if (credentialsPath && fs.existsSync(credentialsPath)) {
    const creds = readCredentials(credentialsPath);
    login = { user_id: creds.user_id, access_token: creds.access_token, device_id: creds.device_id };
    if (!login.user_id || !login.device_id) throw new Error(`reader credentials file ${credentialsPath} lacks user_id/device_id`);
  } else {
    if (!username || !password) {
      throw new Error(
        `reader: ${credentialsPath ?? "no credentials file"} — run once with PI_MATRIX_READER_USER + PI_MATRIX_READER_PASSWORD to create it`,
      );
    }
    // The homeserver rate-limits login bursts (429); honor its retry hint.
    let loginRes;
    for (let attempt = 0; ; attempt++) {
      loginRes = await fetch(`${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: username },
          password,
        }),
      });
      if (loginRes.ok || (loginRes.status !== 429 && loginRes.status !== 502) || attempt >= 3) break;
      const body = await loginRes.json().catch(() => ({}));
      const wait = Number(body.retry_after_ms ?? 0) || 10_000;
      logger.info?.(`[live] reader login rate-limited (${loginRes.status}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!loginRes.ok) throw new Error(`reader login failed: HTTP ${loginRes.status}`);
    const j = await loginRes.json();
    login = { user_id: j.user_id, access_token: j.access_token, device_id: j.device_id };
    if (credentialsPath) {
      // matrix-commander-style layout, 0600 — the same shape /matrix-login
      // writes, so the reader account behaves like any other account dir.
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        credentialsPath,
        JSON.stringify({ homeserver, user_id: login.user_id, device_id: login.device_id, access_token: login.access_token }, null, 2),
        { mode: 0o600 },
      );
      logger.info?.(`[live] reader: created device ${login.device_id} → ${credentialsPath}`);
    }
  }

  // Persistent crypto store beside the credentials file (the account-dir
  // layout the extension uses): the device keeps its Olm identity and its
  // room keys between runs.
  const storeBase = credentialsPath ? path.dirname(credentialsPath) : fs.mkdtempSync(path.join(os.tmpdir(), `pi-matrix-live-reader-${RUN_TAG}-`));
  const storeDir = path.join(storeBase, "reader-store");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const uninstallIdb = installFileIdb(storeDir, globalThis);
  const reader = sdk.createClient({
    baseUrl: homeserver,
    userId: login.user_id,
    accessToken: login.access_token,
    deviceId: login.device_id,
  });
  // Same seam src/sdk-client.ts uses: file-backed IDB (installed above)
  // + the Rust crypto WASM. Fresh store in `storeDir` → this device mints
  // its own Olm account; no other device's key material is ever touched.
  await reader.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: "pi-matrix-live-reader-" });

  // Keep the LIVE MatrixEvent references: js-sdk decrypts asynchronously
  // after the timeline emit and mutates the same object, so flattening at
  // emit time would freeze the pre-decryption (empty) body. Flatten on read.
  const events = new Map();
  const add = (ev) => {
    try {
      const id = ev.getId?.();
      if (id) events.set(id, ev);
    } catch {
      /* id-less transient event — nothing to key on */
    }
  };
  reader.on(sdk.RoomEvent.Timeline, (ev, room, toStartOfTimeline) => {
    if (!toStartOfTimeline) add(ev);
  });
  reader.on(sdk.RoomEvent.Event, (ev) => add(ev));
  reader.on(sdk.RoomEvent.MyMembership, (room, membership) => {
    if (membership === "invite") {
      reader.joinRoom(room.roomId).catch((error) => logger.warn?.(`[live] reader join failed: ${error}`));
    }
  });

  await reader.startClient({ initialSyncLimit: 0 });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("reader first sync timed out")), 30_000);
    reader.once("sync", (state) => {
      if (state === "PREPARED") {
        clearTimeout(t);
        resolve();
      }
    });
  });

  return {
    userId: login.user_id,
    deviceId: login.device_id,
    /** Chronological decrypted+plain room events, same shape as RoomApi.messages. */
    async messages(roomId, { limit = 200 } = {}) {
      // Scope to the room: the persistent reader device also syncs prior
      // run rooms, and cross-room bodies must never satisfy a predicate.
      return [...events.values()]
        .map(flatten)
        .filter((e) => e.body && (!roomId || e.room === roomId))
        .sort((a, b) => a.ts - b.ts)
        .slice(-limit);
    },
    async waitUntil(roomId, pred, { timeoutMs = 45_000, label = "" } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = await this.messages(roomId, { limit: 1000 });
        const hit = pred(all);
        if (hit) return { hit, all };
        if (Date.now() >= deadline) {
          throw new Error(
            `crypto-reader timed out (${timeoutMs}ms) waiting for ${label}; last bodies: ${JSON.stringify(
              all.slice(-12).map((e) => e.body.slice(0, 70)),
            )}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    stop() {
      reader.stopClient();
      uninstallIdb();
    },
  };
}
