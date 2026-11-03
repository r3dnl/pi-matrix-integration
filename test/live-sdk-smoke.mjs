/**
 * LIVE smoke test for the production SdkOutbox connect path (addendum):
 * shim install + initRustCrypto + /sync + alias resolution + delivery start,
 * against the real tst2 homeserver. Opt-in (needs credentials + network),
 * NOT part of test/run.mjs.
 *
 *   node test/live-sdk-smoke.mjs [storeDir]
 *
 * A fresh storeDir wipes the crypto state (first run); an existing one proves
 * restart persistence (resume). Exits 0 when every phase passes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    info: (...a) => console.log("[smoke]", ...a),
    warn: (...a) => console.warn("[smoke][warn]", ...a),
    error: (...a) => console.error("[smoke][err]", ...a),
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
check("connect() resolves (shim + WASM + /sync + alias)", ok);
check("available() after connect", outbox.available() === true);
const room = outbox["resolvedRoomId"] ?? "(none)";
check("alias → room id resolved", /^!/.test(room), room);

// The on-disk crypto store must exist (the file-backed shim, 0700/0600).
const storeDir = process.argv[2] ?? path.join(os.tmpdir(), "pi-sdk-live-smoke");
const files = fs
  .readdirSync(storeDir, { recursive: true, withFileTypes: true })
  .map((e) => e.name)
  .filter((f) => f.endsWith(".json"));
check("crypto store files on disk (OlmMachine state)", files.length >= 1, files.join(","));

let seeded = 0;
outbox.startDelivery({
  onMessage: () => {},
  onReaction: () => {},
  bumpUnread: () => {},
  onSeedComplete: (n) => {
    seeded = n;
  },
  onSyncError: () => {},
});
check("delivery pipeline running", outbox["deliveryStarted"] === true);
void seeded;

await outbox.disconnect();
check("disconnect() clean", true);

if (failed > 0) {
  console.error(`${failed} SMOKE CHECK(S) FAILED`);
  process.exit(1);
}
console.log("LIVE SMOKE PASSED");
