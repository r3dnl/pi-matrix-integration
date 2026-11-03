/**
 * LIVE check for the at-rest storePassphrase path (the WASM's meta-DB):
 * fresh store dir + passphrase → crypto init + meta-DB files on disk;
 * restart-resume with the SAME passphrase must succeed; a WRONG
 * passphrase is reported (informational — the SDK may fail or degrade).
 * Opt-in, NOT part of test/run.mjs.
 *
 *   node test/live-sdk-passphrase.mjs [storeDir] [passphrase]
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createPiJiti, EXT_DIR } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { SdkOutbox } = await jiti.import(path.join(EXT_DIR, "src/sdk-client.ts"));

const storeDir = process.argv[2] ?? path.join(os.tmpdir(), "pi-sdk-pw-smoke");
const goodPass = process.argv[3] ?? "pw-smoke-test";
const logger = { info: () => {}, warn: (...a) => console.warn("[pw][warn]", ...a), error: () => {}, debug: () => {} };
const base = {
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
  cryptoStoreDir: storeDir,
  syncTimeoutMs: 60000,
};

let failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name} ${extra}`);
  }
};

// 1) Fresh store + passphrase → init must succeed + the meta-DB (the
//    passphrase path: `<prefix>::matrix-sdk-crypto-meta`) must land on disk.
const first = new SdkOutbox({ ...base, storePassphrase: goodPass, logger });
const ok1 = await first.connect();
check("fresh connect with storePassphrase", ok1);
const entries = fs.readdirSync(storeDir, { recursive: true })
  .map((p) => String(p))
  .filter(Boolean);
const hasMeta = entries.some((p) => p.includes("matrix-sdk-crypto-meta"));
check("meta-DB dir on disk (the passphrase store)", hasMeta, entries.join(" | "));
await first.disconnect();

// 2) Restart-resume with the SAME passphrase.
const second = new SdkOutbox({ ...base, storePassphrase: goodPass, logger });
const ok2 = await second.connect();
check("restart-resume with the same passphrase", ok2);
await second.disconnect();

// 3) Informational: a WRONG passphrase.
const wrong = new SdkOutbox({ ...base, storePassphrase: "deliberately-wrong", logger });
let wrongResult;
try {
  const ok3 = await wrong.connect();
  wrongResult = `connect returned ${ok3}`;
  if (ok3) await wrong.disconnect();
} catch (e) {
  wrongResult = `connect threw: ${e.message}`;
}
console.log(`info  wrong passphrase → ${wrongResult}`);

if (failed > 0) {
  console.error(`${failed} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("PASSPHRASE CHECK PASSED");
