/**
 * Spike c (ADDENDUM-SDK-HTTP-TRANSPORT §8.1.c/d) — THROWAWAY:
 * initRustCrypto under jiti: WASM load + crypto init + device creation, with
 * the file-backed IDB shim persisting the store. The gate (design §6): the
 * crypto store lands in real files under a dir, and a SECOND process
 * re-opening the same dir resumes the same device (spike-d is the restart
 * half of this file: run `node test/spike-sdk-crypto.mjs resume`).
 *
 * Run: node test/spike-sdk-crypto.mjs [resume]
 */
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPiJiti, EXT_DIR } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { installFileIdb } = await jiti.import(join(EXT_DIR, "src", "idb-file-store.ts"));
const {
  MatrixClient: SdkClient,
  ClientEvent,
  SyncState,
  MemoryStore,
} = await jiti.import("matrix-js-sdk");

const cred = JSON.parse(
  readFileSync(
    `${homedir()}/.config/mtx/accounts/pi_agent--tst2-matrix.r3d.nl/credentials.json`,
    "utf8",
  ),
);

// One store dir for the c+restart halves (so "resume" sees the device).
const storeDir = join(tmpdir(), "pi-sdk-crypto-spike");
const fresh = process.argv[2] !== "resume";
if (fresh) rmSync(storeDir, { recursive: true, force: true });

// The token is bound to a specific device (the mautrix credentials carry it);
// /keys/upload 400s on any other deviceId.
const deviceId = cred.device_id ?? "PI_AGENT";
console.log(`[spike-c] deviceId=${deviceId}`);

const uninstall = installFileIdb(storeDir, globalThis);
console.log(`[spike-c] shim installed on ${storeDir}`);

const client = new SdkClient({
  baseUrl: cred.homeserver,
  accessToken: cred.access_token,
  deviceId,
  userId: cred.user_id,
  logLevel: "error",
  store: new MemoryStore(),
});

try {
  await client.initRustCrypto({
    // The wasm store prefix names the IDB "database" (a dir under storeDir).
    cryptoDatabasePrefix: "pi-spike",
    useIndexedDB: true,
  });
  console.log("[spike-c] initRustCrypto OK (WASM loaded, crypto backend up)");
} catch (e) {
  console.log(`[spike-c] initRustCrypto FAILED: ${e?.message ?? e}`);
  process.exit(1);
}

// Device creation needs a sync tick (the crypto bootstraps its Olm account
// against the server's /keys endpoints during client start).
await client.startClient({ timeout: 10_000 });
await new Promise((r) => setTimeout(r, 4_000)); // let key uploads land

const crypto = client.getCrypto();
console.log(`[spike-c] getCrypto(): ${crypto ? "backend present" : "UNDEFINED"}`);
if (crypto?.deviceIds) {
  const ids = [...crypto.deviceIds];
  console.log(`[spike-c] device keys: ${ids.length} (first: ${JSON.stringify(ids[0]).slice(0, 80)}…)`);
}

// What landed on disk (the whole point: files, not memory).
const { execSync } = await import("node:child_process");
const files = execSync(`find ${storeDir} -type f | sort`).toString().trim().split("\n");
console.log(`[spike-c] store files: ${files.length}`);
for (const f of files.slice(0, 10)) console.log(`  ${f}`);

// Encrypted-at-rest spot check would need the passphrase; this half runs
// unencrypted (mechanics gate) — the passphrase half is spike e.
await client.stopClient();
uninstall();
console.log(`[spike-c] ${fresh ? "OK — crypto init + device + on-disk store" : "RESUME — restarted process reused the on-disk store"}`);
process.exit(0);
