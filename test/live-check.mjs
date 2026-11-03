/**
 * LIVE end-to-end check for pi-matrix-integration.
 *
 * Unlike the offline suite (fake `mtx`, no network), this loads the real
 * extension config + MatrixClient the way Pi does (jiti) and drives them
 * against the real homeserver via the real `mtx` CLI:
 *
 *   1. connect()            — exactly what `/matrix-connect` runs
 *   2. sendMessage + readMessages — outgoing round-trip as the bot account
 *   3. getRoomMembers / getUnreadCount
 *   4. live receive — start the poller, have a *second* account (vincent)
 *      post a message, and confirm the poller emits it to the handler
 *      (Matrix → Pi), the path that injects into the session.
 *
 * Requires: the `pi_agent` account + `pi-updates` room provisioned
 * (see manifests/tst2-pi.json) and network access to the homeserver.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPiJiti, EXT_DIR, requireLiveEnv } from "./_harness.mjs";

const pexecFile = promisify(execFile);

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

const jiti = await createPiJiti(import.meta.url);
const { resolveStartupConfig } = await jiti.import(`${EXT_DIR}/src/config.ts`);
const { createSdkOutbox } = await jiti.import(`${EXT_DIR}/src/sdk-client.ts`);
const { createMessageHandler } = await jiti.import(`${EXT_DIR}/src/message-handler.ts`);

// ---- load the real config the extension would load --------------------------
requireLiveEnv();
const { config, valid, errors } = resolveStartupConfig();
check("real config is valid", valid === true, JSON.stringify(errors));
console.log(`  config: user=${config.userId} room=${config.roomId} server=${config.homeserver}`);

// TO-BE Slice 6: the facade pair is deleted — the live harness rides the
// outbox seam (createSdkOutbox + the delivery verbs).
const outbox = createSdkOutbox(config);
const handler = createMessageHandler({ outbox });

// ---- 1) connect — what /matrix-connect runs --------------------------------
console.log("== connect (live /matrix-connect) ==");
const connected = await outbox.connect();
check("connect() === true", connected === true, JSON.stringify({ connected }));

// ---- 2) outgoing round-trip -------------------------------------------------
console.log("== send + read (live, as the bot account) ==");
const marker = `live E2E ${new Date().toISOString()}`;
const sent = await outbox.postMessage(`[Pi live E2E] ${marker}`);
check("postMessage success", sent.success === true, JSON.stringify(sent));
check("postMessage returned an event id", Boolean(sent.eventId), sent.eventId);

const msgs = await outbox.readMessages(5);
check("readMessages returns events", msgs.length > 0, String(msgs.length));
const ours = msgs.find((m) => m.body.includes(marker));
check("sent message is read back", Boolean(ours), JSON.stringify(msgs.map((m) => m.body)));
check("own message flagged isFromPi", ours?.isFromPi === true, JSON.stringify(ours));

// ---- 3) room ops ------------------------------------------------------------
console.log("== room ops ==");
const members = await outbox.roomMembers();
check(
  "room members include both accounts",
  members.length >= 2,
  JSON.stringify(members),
);

// ---- 4) live receive — a second account posts; the sync delivery must emit it
console.log("== live receive (sync delivery) ==");
const emitted = [];
outbox.startDelivery({
  onMessage: (m) => {
    emitted.push(m);
    // Mirror the real wiring: route through the message handler.
    const piMessage = handler.handleIncomingMessage(m);
    if (piMessage) {
      console.log(`  [emit] from ${m.sender} -> PiMessage type=${piMessage.type} content=${JSON.stringify(piMessage.content)}`);
    }
  },
  onReaction: () => {},
  bumpUnread: () => {},
  onSyncError: (e) => console.log("  [sync-error]", e.message),
});

const POLL_MS = 1500;
await new Promise((r) => setTimeout(r, POLL_MS + 400)); // baseline sync window
const baselineEmitted = emitted.slice(0, emitted.length);
// The seed round baselines old backfill (never emitted) but DELIBERATELY
// emits recent backfill (sent within BACKFILL_GRACE_MS while the client was
// down — the seed-baseline gap; sdk-client.ts). An active room always has
// some of it, so the invariant is "no stale-history flood", not "quiet
// window": every baseline emission must be a recent event, never old
// history replayed as new.
const RECENT_GRACE_MS = 600_000; // mirror BACKFILL_GRACE_MS
const nowTs = Date.now();
check(
  "baseline poll emits at most recent backfill (no stale-history flood)",
  baselineEmitted.every((m) => m.timestamp > 0 && nowTs - m.timestamp < RECENT_GRACE_MS),
  JSON.stringify(baselineEmitted.map((m) => [m.eventId, m.timestamp])),
);

// Have the *other* member (vincent) post into the room, as a real user would.
const roomRef = config.roomId;
const receiveText = `reply from vincent ${new Date().toISOString()}`;
try {
  await pexecFile(
    "mtx",
    // ponytail: derive the mtx env name from the domain (tst2/prd2 are the
    // two known registries); add a branch when a third env appears.
    ["message", "send", receiveText, "-r", roomRef, "--as", "vincent", "-e", (config.homeserver ?? "").includes("tst2") ? "tst2" : "prd2", "--json"],
    { timeout: 30_000 },
  );
  check("vincent's message accepted by mtx", true);
} catch (err) {
  check("vincent's message accepted by mtx", false, String(err));
}

await new Promise((r) => setTimeout(r, POLL_MS + 400));
const received = emitted.find((m) => m.body.includes(receiveText.slice(14))); // the timestamp marker
check("poller emitted the second account's message", Boolean(received), JSON.stringify(emitted.map((m) => m.body)));
check(
  "emitted message is not from Pi (isFromPi=false)",
  received?.isFromPi === false,
  JSON.stringify(received),
);
check(
  "message handler formatted it for Pi (attribution prefix)",
  received ? received.body.includes(receiveText.slice(14)) : false,
  JSON.stringify(received?.body),
);

outbox.stopDelivery();
void outbox.disconnect();
handler.cleanup?.();

if (failures === 0) {
  console.log("LIVE E2E: ALL CHECKS PASSED");
  process.exit(0);
}
console.error(`LIVE E2E: ${failures} CHECK(S) FAILED`);
process.exit(1);
