// One-shot forensics: decrypt room events with a COPY of the account's
// crypto store (no sync, no to-device traffic) and print their thread
// relations. Usage: jiti tools/decrypt-event.ts <roomId> <eventId> [eventId...]
import { readFileSync } from "node:fs";
import { installFileIdb } from "../src/idb-file-store.js";
import * as sdk from "matrix-js-sdk";

const [roomId, ...eventIds] = process.argv.slice(2);
const cred = JSON.parse(
  readFileSync("/home/vincent/.config/mtx/projects/homeops/accounts/pi_agent--matrix.r3d.nl/credentials.json", "utf8"),
);

installFileIdb("/tmp/store-copy", globalThis as never);

const client = new sdk.MatrixClient({
  baseUrl: cred.homeserver,
  accessToken: cred.access_token,
  userId: cred.user_id,
  deviceId: cred.device_id,
  store: new sdk.MemoryStore(),
});
await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: "pi" });

for (const eventId of eventIds) {
  try {
    const raw = await client.fetchRoomEvent(roomId, eventId);
    const ev = new sdk.MatrixEvent(raw as never);
    if (ev.isEncrypted()) {
      try {
        await client.decryptEventIfNeeded(ev, { emit: false });
      } catch (e) {
        console.log(eventId, "| DECRYPT FAILED:", String(e).slice(0, 120));
        continue;
      }
    }
    const eff = ev.getEffectiveEvent() as { type?: string; origin_server_ts?: number; content?: Record<string, unknown> };
    const c = (eff.content ?? {}) as Record<string, unknown>;
    const body = String((c["m.new_content"] as Record<string, unknown>)?.body ?? c.body ?? "").replace(/\s+/g, " ").slice(0, 100);
    const rel = c["m.thread"] as { event_id?: string; "is_falling_back"?: boolean } | undefined;
    const rep = c["m.relates_to"] as { event_id?: string; rel_type?: string } | undefined;
    const verbose = !!process.env.VERBOSE;
    const full = verbose
      ? JSON.stringify(c).replace(/\s+/g, " ")
      : body;
    console.log(
      eventId,
      "|", eff.type,
      "|", new Date(eff.origin_server_ts ?? 0).toISOString(),
      "| rel:", rel ? `m.thread->${rel.event_id}${rel["is_falling_back"] ? " (fallback)" : ""}` : rep ? `${rep.rel_type}->${rep.event_id}` : "NONE",
      "|", full.slice(0, verbose ? 4000 : 100),
    );
  } catch (e) {
    console.log(eventId, "| ERROR:", String(e).slice(0, 160));
  }
}
process.exit(0);
