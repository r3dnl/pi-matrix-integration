/**
 * Spike a (ADDENDUM-SDK-HTTP-TRANSPORT §8.1.a) — THROWAWAY:
 * matrix-js-sdk v42 import under the jiti loader pi uses, plus a basic
 * /sync against tst2. Proves Risk 2 (jiti/ESM interop) and that the sync
 * loop + room/timeline access work on this Synapse.
 *
 * Run: node test/spike-sdk-sync.mjs   (exits 0 when sync completes)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPiJiti, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);

const {
  MatrixClient: SdkClient,
  ClientEvent,
  SyncState,
  MemoryStore,
} = await jiti.import("matrix-js-sdk");
// PASSIVE fetch logger (no rewriting): record what the SDK's /sync calls
// actually receive, to diagnose the zero-rooms state.
const baseFetch = globalThis.fetch;
const syncResponses = [];
const loggingFetch = async (resource, init) => {
  const res = await baseFetch(resource, init);
  const url =
    typeof resource === "string" ? resource : resource instanceof URL ? resource.href : String(resource);
  if (/\/sync/.test(url)) {
    try {
      const data = await res.clone().json();
      syncResponses.push({
        url: url.slice(0, 160),
        top: Object.keys(data),
        roomsKeys: data.rooms ? Object.keys(data.rooms) : undefined,
        join: data.join ? Object.keys(data.join) : data.rooms?.join ? Object.keys(data.rooms.join) : undefined,
        status: res.status,
      });
    } catch {
      syncResponses.push({ url: url.slice(0, 160), status: res.status, parse: "failed" });
    }
  }
  return res;
};

const cred = JSON.parse(
  readFileSync(
    `${homedir()}/.config/mtx/accounts/pi_agent--tst2-matrix.r3d.nl/credentials.json`,
    "utf8",
  ),
);

const client = new SdkClient({
  baseUrl: cred.homeserver,
  accessToken: cred.access_token,
  deviceId: "PI_AGENT",
  userId: cred.user_id,
  logLevel: "warn",
  // v42 defaults to a no-op StubStore → getRooms()/getRoom() return nothing.
  // A MemoryStore keeps the rooms (the sync pipeline itself is store-agnostic).
  store: new MemoryStore(),
  fetchFn: loggingFetch,
});

client.on(ClientEvent.Sync, (s, prev) => {
  console.log(`[spike-a] sync state: ${prev ?? "-"} → ${s}`);
});

client.startClient({ timeout: 30_000, initialSync: true });

await waitUntil(
  () => client.getSyncState() === SyncState.Syncing,
  { timeoutMs: 30_000, intervalMs: 200, label: "first sync" },
);

const all = client.getRooms();
console.log(`[spike-a] rooms: ${all.length}`);
for (const r of all.slice(0, 12)) {
  console.log(
    `  ${r.roomId}  canonical=${r.getCanonicalAlias()}  alt=${JSON.stringify(r.getAltAliases())}  name=${JSON.stringify(r.name)}`,
  );
}
const byAlias = await client.getRoomIdForAlias("#pi-updates:tst2-matrix.r3d.nl");
console.log(`[spike-a] getRoomIdForAlias: ${JSON.stringify(byAlias)}`);
for (const r of syncResponses) console.log(`[spike-a] sync resp:`, JSON.stringify(r));
await waitUntil(
  () => client.getRoom(byAlias.room_id) !== null,
  { timeoutMs: 20_000, intervalMs: 500, label: "room object local" },
).catch(() => console.log("[spike-a] room object still null after 20s; visible rooms:", client.getVisibleRooms().length));
const room = client.getRoom(byAlias.room_id);
if (!room) {
  console.error("[spike-a] FAIL: pi room not found under the alias");
  await client.stopClient();
  process.exit(1);
}
const events = room.getLiveTimeline().getEvents().filter((e) => e.getType() === "m.room.message");
const last = events[events.length - 1];
console.log(`[spike-a] room ${room.roomId} (alias ${room.getCanonicalAlias()})`);
console.log(
  `[spike-a] timeline: ${events.length} m.room.message events; last: ts=${last.getTs()} sender=${last.getSender()} body=${JSON.stringify(last.getContent().body ?? "").slice(0, 60)}`,
);

// Event-shape check: what the shared parseMatrixEvent will consume.
const raw = {
  event_id: last.getId(),
  type: last.getType(),
  sender: last.getSender(),
  room_id: room.roomId,
  origin_server_ts: last.getTs(),
  content: last.getContent(),
};
console.log(`[spike-a] raw-shape: ${JSON.stringify(raw).slice(0, 200)}`);

// Own-echo check: the bot's last post (isFromPi parity, Risk 4).
const own = [...events].reverse().find((e) => e.getSender() === cred.user_id);
console.log(
  `[spike-a] last pi_agent event: ${own ? `ts=${own.getTs()} body=${JSON.stringify(own.getContent().body ?? "").slice(0, 40)}` : "none in window"}`,
);

await new Promise((r) => setTimeout(r, 1_500)); // let one more sync tick happen
await client.stopClient();
console.log("[spike-a] OK — jiti import + sync + room access all work");
process.exit(0);
