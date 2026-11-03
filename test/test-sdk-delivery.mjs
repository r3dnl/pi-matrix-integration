/**
 * test-sdk-delivery.mjs — the SdkOutbox sync read pipeline (src/sdk-client.ts
 * startDelivery): the 2026-09-18 incident class — a live user message lands
 * in the timeline as `m.room.encrypted` (the WASM decrypts it async, in
 * place). The pipeline must wait for `Event.decrypted` before feeding
 * parseMatrixEvent, or the message is silently dropped.
 *
 * - encrypted live event: not emitted until `Event.decrypted`, then emitted
 *   with the decrypted body
 * - decryption failure (`Event.decrypted` with error): never emitted,
 *   logged once
 * - plaintext live event: emitted immediately (no wait)
 * - backfill (non-live) events: baselined, never emitted (R9 semantics)
 */
import { createPiJiti, makeCheck } from "./_harness.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = await createPiJiti(import.meta.url);
const { createSdkOutbox } = jiti("../src/sdk-client.ts");
const { check, finish } = makeCheck("sdk-delivery");

const ROOM = "!pi-updates:test.example.org";
const SELF = "@pi_agent:test.example.org";

/** Minimal EventEmitter stand-in for a js-sdk MatrixEvent. */
function makeFakeEvent(raw) {
  const handlers = {};
  return {
    event: raw,
    on(type, cb) {
      (handlers[type] ??= []).push(cb);
    },
    off(type, cb) {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== cb);
    },
    emit(type, ...args) {
      for (const cb of [...(handlers[type] ?? [])]) cb(...args);
    },
  };
}

/** Minimal client: only what startDelivery wires up. */
function makeFakeClient(sdk) {
  const handlers = {};
  return {
    on(type, cb) {
      (handlers[type] ??= []).push(cb);
    },
    off(type, cb) {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== cb);
    },
    emitTimeline(event, room, removed, data) {
      for (const cb of handlers[sdk.RoomEvent.Timeline] ?? []) cb(event, room, undefined, removed, data);
    },
  };
}

const fakeSdk = {
  RoomEvent: { Timeline: "Room.timeline" },
  MatrixEventEvent: { Decrypted: "Event.decrypted" },
};

const outbox = createSdkOutbox({
  homeserver: "test.example.org",
  userId: SELF,
  roomId: ROOM,
  credentialsPath: "/dev/null",
});
const client = makeFakeClient(fakeSdk);
outbox.setTestClient(client, ROOM, fakeSdk);

const delivered = [];
const warned = [];
outbox.startDelivery({
  onMessage: (m) => delivered.push(m),
  bumpUnread: () => {},
  onSeedComplete: () => {},
});

const roomStub = { roomId: ROOM };

// 1. encrypted live event: held back until decrypted
// v42 semantics (MatrixEvent.setClearData): on decryption the RAW dict
// (event.event) STAYS m.room.encrypted — the plaintext lands in
// event.clearEvent. The pipeline must read clearEvent, not event.event.
const encRaw = {
  event_id: "$enc-1",
  sender: "@vincent:test.example.org",
  origin_server_ts: 1_700_000_000_000,
  type: "m.room.encrypted",
  room_id: ROOM,
  content: { alg: "m.megolm.v1.aes-sha2", ciphertext: "xxx" },
};
const encEvent = makeFakeEvent(encRaw);
client.emitTimeline(encEvent, roomStub, false, { liveEvent: true });
check("encrypted live event not emitted early", delivered.length === 0, JSON.stringify(delivered));

// decryption lands in clearEvent; the raw dict stays encrypted.
// REAL IClearEvent shape: { type, content, room_id? } ONLY — event_id /
// sender / origin_server_ts stay on the OUTER event (encRaw). The SDK's
// setClearData never copies them into clearEvent; the pipeline must merge
// them (getEffectiveEvent), else parseMatrixEvent drops on `!event_id`.
encEvent.clearEvent = {
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "here is the new reply", msgtype: "m.text" },
};
encEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, encEvent);
check(
  "decrypted event emitted with its body (v42 clearEvent semantics)",
  delivered.length === 1 && delivered[0].eventId === "$enc-1" && delivered[0].body === "here is the new reply",
  JSON.stringify(delivered),
);

// 2. decryption failure: never emitted
const failRaw = {
  event_id: "$enc-fail",
  sender: "@vincent:test.example.org",
  origin_server_ts: 1_700_000_001_000,
  type: "m.room.encrypted",
  room_id: ROOM,
  content: { alg: "m.megolm.v1.aes-sha2" },
};
const failEvent = makeFakeEvent(failRaw);
client.emitTimeline(failEvent, roomStub, false, { liveEvent: true });
failEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, failEvent, new Error("unknown message index"));
check("failed decryption never emitted", delivered.length === 1, JSON.stringify(delivered.map((m) => m.eventId)));

// 3. plaintext live event: emitted immediately
const plainRaw = {
  event_id: "$plain-1",
  sender: "@vincent:test.example.org",
  origin_server_ts: 1_700_000_002_000,
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "go ahead", msgtype: "m.text" },
};
client.emitTimeline(makeFakeEvent(plainRaw), roomStub, false, { liveEvent: true });
check(
  "plaintext live event emitted immediately",
  delivered.length === 2 && delivered[1].body === "go ahead",
  JSON.stringify(delivered.map((m) => m.eventId)),
);

// 4. backfill (non-live) events: baselined, never emitted
const backfillRaw = {
  event_id: "$back-1",
  sender: "@vincent:test.example.org",
  origin_server_ts: 1_700_000_003_000,
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "old backfill", msgtype: "m.text" },
};
client.emitTimeline(makeFakeEvent(backfillRaw), roomStub, false, undefined);
check("backfill event baselined, not emitted", delivered.length === 2, JSON.stringify(delivered.map((m) => m.eventId)));

// 5. ENCRYPTED backfill: old events stay baselined even once decrypted
const oldEncRaw = {
  event_id: "$enc-old",
  sender: "@vincent:test.example.org",
  origin_server_ts: Date.now() - 3_600_000, // 1 h ago — outside the 10-min grace
  type: "m.room.encrypted",
  room_id: ROOM,
  content: { alg: "m.megolm.v1.aes-sha2", ciphertext: "xxx" },
};
const oldEncEvent = makeFakeEvent(oldEncRaw);
client.emitTimeline(oldEncEvent, roomStub, false, undefined);
oldEncEvent.clearEvent = {
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "hour-old backfill", msgtype: "m.text" },
};
oldEncEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, oldEncEvent);
check("old encrypted backfill stays baselined", delivered.length === 2, JSON.stringify(delivered.map((m) => m.eventId)));

// 6. ENCRYPTED backfill sent while the client was down (within the grace
//    window): emitted, not baselined (the 2026-09-18 `test123` case)
const recentEncRaw = {
  event_id: "$enc-recent",
  sender: "@vincent:test.example.org",
  origin_server_ts: Date.now() - 5_000,
  type: "m.room.encrypted",
  room_id: ROOM,
  content: { alg: "m.megolm.v1.aes-sha2", ciphertext: "xxx" },
};
const recentEncEvent = makeFakeEvent(recentEncRaw);
client.emitTimeline(recentEncEvent, roomStub, false, undefined);
recentEncEvent.clearEvent = {
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "sent while down", msgtype: "m.text" },
};
recentEncEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, recentEncEvent);
check(
  "recent encrypted backfill is emitted",
  delivered.length === 3 && delivered[2].body === "sent while down",
  JSON.stringify(delivered.map((m) => m.eventId)),
);

// 7. reconnect persistence (the 2026-09-18 re-injection bug): a second
//    outbox sharing the same seenPath must not re-emit events the first
//    already delivered — but still delivers genuinely new ones.
const seenPath = join(mkdtempSync(join(tmpdir(), "sdk-seen-")), "seen.json");
const outboxA = createSdkOutbox({
  homeserver: "test.example.org",
  userId: SELF,
  roomId: ROOM,
  credentialsPath: "/dev/null",
  seenPath,
});
const clientA = makeFakeClient(fakeSdk);
outboxA.setTestClient(clientA, ROOM, fakeSdk);
const deliveredA = [];
outboxA.startDelivery({
  onMessage: (m) => deliveredA.push(m),
  bumpUnread: () => {},
  onSeedComplete: () => {},
});
const reconnectRaw = {
  event_id: "$enc-reconnect",
  sender: "@vincent:test.example.org",
  origin_server_ts: Date.now() - 5_000,
  type: "m.room.encrypted",
  room_id: ROOM,
  content: { alg: "m.megolm.v1.aes-sha2", ciphertext: "xxx" },
};
const reconnectEvent = makeFakeEvent(reconnectRaw);
clientA.emitTimeline(reconnectEvent, roomStub, false, { liveEvent: true });
reconnectEvent.clearEvent = {
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "delivered in session one", msgtype: "m.text" },
};
reconnectEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, reconnectEvent);
check(
  "first connection delivers the recent event",
  deliveredA.length === 1 && deliveredA[0].eventId === "$enc-reconnect",
  JSON.stringify(deliveredA.map((m) => m.eventId)),
);

// second connection (new pi session): same event re-backfilled → suppressed
const outboxB = createSdkOutbox({
  homeserver: "test.example.org",
  userId: SELF,
  roomId: ROOM,
  credentialsPath: "/dev/null",
  seenPath,
});
const clientB = makeFakeClient(fakeSdk);
outboxB.setTestClient(clientB, ROOM, fakeSdk);
const deliveredB = [];
outboxB.startDelivery({
  onMessage: (m) => deliveredB.push(m),
  bumpUnread: () => {},
  onSeedComplete: () => {},
});
const reBackfillEvent = makeFakeEvent(reconnectRaw);
clientB.emitTimeline(reBackfillEvent, roomStub, false, { liveEvent: true });
reBackfillEvent.clearEvent = {
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "delivered in session one", msgtype: "m.text" },
};
reBackfillEvent.emit(fakeSdk.MatrixEventEvent.Decrypted, reBackfillEvent);
check(
  "reconnect does not re-emit the already-delivered event",
  deliveredB.length === 0,
  JSON.stringify(deliveredB.map((m) => m.eventId)),
);
check("seen ids persisted to disk", JSON.parse(readFileSync(seenPath, "utf8")).includes("$enc-reconnect"), seenPath);

// …but a genuinely new event (sent while down) still lands — plaintext,
// the live path (no decryption round-trip to fake up)
const freshRaw = {
  event_id: "$plain-fresh",
  sender: "@vincent:test.example.org",
  origin_server_ts: Date.now() - 1_000,
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "sent while down", msgtype: "m.text" },
};
clientB.emitTimeline(makeFakeEvent(freshRaw), roomStub, false, { liveEvent: true });
check(
  "reconnect still delivers a genuinely new event",
  deliveredB.length === 1 && deliveredB[0].eventId === "$plain-fresh",
  JSON.stringify(deliveredB.map((m) => m.eventId)),
);

// 8. shared-account self-drop (2026-10-09): the human sends from PI'S OWN
//    user id (robbie's credentials shared with the human's Element client).
//    "Pi's own post" = the event id recorded at send time (+ ~! local
//    echoes), NOT sender === selfUserId — a sender match would drop the
//    human's messages too.

// 8a. a human message from pi's own user id is USER INPUT, not pi's own
const humanSharedRaw = {
  event_id: "$human-shared",
  sender: SELF,
  origin_server_ts: Date.now() - 1_000,
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "human typing as the shared account", msgtype: "m.text" },
};
clientA.emitTimeline(makeFakeEvent(humanSharedRaw), roomStub, false, { liveEvent: true });
check(
  "shared-account human message is delivered with isFromPi=false",
  deliveredA.length === 2 && deliveredA[1].eventId === "$human-shared" && deliveredA[1].isFromPi === false,
  JSON.stringify(deliveredA.map((m) => [m.eventId, m.isFromPi])),
);

// 8b. a ~! temp-id event is a js-sdk local echo of pi's own send → dropped
const tempEchoRaw = {
  event_id: "~!own-echo-1",
  sender: SELF,
  origin_server_ts: Date.now(),
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "pi's own local echo", msgtype: "m.text" },
};
clientA.emitTimeline(makeFakeEvent(tempEchoRaw), roomStub, false, { liveEvent: true });
check(
  "~! temp-id local echo is dropped",
  deliveredA.length === 2,
  JSON.stringify(deliveredA.map((m) => m.eventId)),
);

// 8c. pi's own send is recorded at send time → the confirmed copy dedupes
clientA.sendMessage = async () => ({ event_id: "$own-confirmed" });
const ownSend = await outboxA.postMessage("pi's own post");
check("postMessage returns the recorded event id", ownSend.success && ownSend.eventId === "$own-confirmed", JSON.stringify(ownSend));
const ownConfirmedRaw = {
  event_id: "$own-confirmed",
  sender: SELF,
  origin_server_ts: Date.now(),
  type: "m.room.message",
  room_id: ROOM,
  content: { body: "pi's own post (confirmed)", msgtype: "m.text" },
};
clientA.emitTimeline(makeFakeEvent(ownConfirmedRaw), roomStub, false, { liveEvent: true });
check(
  "confirmed copy of pi's own send is deduped (send record, not sender)",
  deliveredA.length === 2,
  JSON.stringify(deliveredA.map((m) => m.eventId)),
);

// 8d. the send record persists: a RESTARTED connection (new outbox, same
//     seenPath) still dedupes the confirmed copy of pi's own send
const outboxC = createSdkOutbox({
  homeserver: "test.example.org",
  userId: SELF,
  roomId: ROOM,
  credentialsPath: "/dev/null",
  seenPath,
});
const clientC = makeFakeClient(fakeSdk);
outboxC.setTestClient(clientC, ROOM, fakeSdk);
const deliveredC = [];
outboxC.startDelivery({
  onMessage: (m) => deliveredC.push(m),
  bumpUnread: () => {},
  onSeedComplete: () => {},
});
clientC.emitTimeline(makeFakeEvent(ownConfirmedRaw), roomStub, false, { liveEvent: true });
check(
  "restarted connection still dedupes the confirmed copy (send record persisted)",
  deliveredC.length === 0,
  JSON.stringify(deliveredC.map((m) => m.eventId)),
);

finish();
