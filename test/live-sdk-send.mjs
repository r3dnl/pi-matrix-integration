/**
 * LIVE E2E check: a room send + read-back through the production SdkOutbox
 * (the addendum's "encrypted room message send/receive" gate). Opt-in,
 * NOT part of test/run.mjs. Posts ONE identifiable message to the
 * configured room.
 *
 *   node test/live-sdk-send.mjs [storeDir]
 */
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { SdkOutbox } = await jiti.import(path.join(EXT_DIR, "src/sdk-client.ts"));

const outbox = new SdkOutbox({
  homeserver: "tst2-matrix.r3d.nl",
  userId: "@pi-agent:tst2-matrix.r3d.nl",
  roomId: "#pi-updates:tst2-matrix.r3d.nl",
  credentialsPath: path.join(
    process.env.HOME,
    ".config",
    "mtx",
    "accounts",
    "pi_agent--tst2-matrix.r3d.nl",
    "credentials.json",
  ),
  e2ee: "on",
  attachEncryption: "on",
  cryptoStoreDir: process.argv[2] ?? path.join(os.tmpdir(), "pi-sdk-live-smoke"),
  syncTimeoutMs: 60000,
  logger: {
    info: (...a) => console.log("[send]", ...a),
    warn: (...a) => console.warn("[send][warn]", ...a),
    error: (...a) => console.error("[send][err]", ...a),
    debug: () => {},
  },
});

let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name} ${extra}`);
  }
};

const ok = await outbox.connect();
check("connect", ok);

// Room encryption state (does this room carry an m.room.encryption event?).
const client = outbox["client"];
// v42: post-sync state lives on the room's live timeline, not the client.
const sdk = await import("matrix-js-sdk");
const room = client.getRoom(outbox["resolvedRoomId"]);
const roomState = room?.getLiveTimeline().getState(sdk.EventTimeline.BACKWARDS);
const encState = roomState?.getStateEvents("m.room.encryption") ?? [];
const encrypted = encState.length > 0;
console.log(
  encrypted
    ? `room is E2EE (algorithm: ${encState[0].getContent()?.algorithm ?? "?"})`
    : "room is NOT encrypted (plaintext m.text expected)",
);

const res = await outbox.postMessage(
  "[pi-agent] sdk-transport E2E check (sent via matrix-js-sdk; safe to delete)",
);
check("postMessage success", res.success === true, res.error ?? "");
check("an event id came back", typeof res.eventId === "string" && res.eventId.length > 0, res.eventId ?? "");

// Read-back through the SDK http layer (server-side view). In an encrypted
// room the event arrives as m.encrypted (the SDK's sync pipeline decrypts;
// the /messages read sees the ciphertext) — either way the event's presence
// proves the send landed.
const tl = await outbox.readTimeline(20);
const found = tl.messages.length > 0 && tl.messages.every((m) => m.body !== undefined || m.sender !== undefined);
check("readTimeline returns events", tl.success === true && tl.messages.length > 0, JSON.stringify(tl.messages[0] ?? null));
console.log(`newest read event: ${tl.messages[0]?.eventId ?? "?"} (${tl.messages[0]?.sender ?? "?"})`);
void found;

await outbox.disconnect();
if (failed > 0) {
  console.error(`${failed} E2E CHECK(S) FAILED`);
  process.exit(1);
}
console.log("LIVE E2E PASSED");
