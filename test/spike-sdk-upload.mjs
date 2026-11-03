/**
 * Spike b (ADDENDUM-SDK-HTTP-TRANSPORT §8.1.b) — THROWAWAY:
 * Does `client.uploadContent` reach this Synapse's registered media verb?
 * Prior live probe: `POST /_matrix/client/v3/media/upload` → 404 (unregistered),
 * `POST /_matrix/media/v3/upload` → 200 (the working media-repo). js-sdk's
 * uploadContent targets `MediaPrefix.V3` = `/_matrix/media/v3` — verify it
 * round-trips (upload → content_uri → download) on tst2.
 *
 * Run: node test/spike-sdk-upload.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPiJiti, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  MatrixClient: SdkClient,
  SyncState,
} = await jiti.import("matrix-js-sdk");

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
  logLevel: "error",
});

// A tiny payload; no need to sync for upload (media-repo doesn't need a room).
const payload = Buffer.from(`spike-b ${new Date().toISOString()}\n`.repeat(50));
try {
  const res = await client.uploadContent(payload, {
    type: "text/plain",
    name: "pi-spike-b.txt",
  });
  const mxc = res.content_uri ?? res.contentUri ?? res;
  console.log(`[spike-b] upload OK → ${String(mxc).slice(0, 60)}…`);
  console.log(
    `[spike-b] uploadContent resolved: ${JSON.stringify(res).slice(0, 140)}`,
  );

  // Download it back to confirm the mxc is retrievable (the media-repo
  // download verb is the one R2 found registered: /_matrix/media/download).
  const dlUrl = `https://${cred.homeserver.replace(/^https?:\/\//, "")}/_matrix/client/v1/media/download/${encodeURIComponent(String(mxc))}`;
  let dlStatus = "n/a";
  try {
    const r = await fetch(dlUrl, { headers: { Authorization: `Bearer ${cred.access_token}` } });
    dlStatus = `${r.status} (${(await r.text()).length} chars)`;
  } catch (e) {
    dlStatus = `fetch failed: ${e.message}`;
  }
  console.log(`[spike-b] download round-trip: ${dlStatus}`);

  console.log("[spike-b] OK — uploadContent targets a registered media verb");
} catch (e) {
  console.log(`[spike-b] upload FAILED: ${e.errcode ?? ""} ${e.message}`.trim());
  console.log("[spike-b] → need the media-repo POST override in sdk-client.ts (Risk 1 fallback)");
} finally {
  await client.stopClient().catch(() => {});
}
process.exit(0);
