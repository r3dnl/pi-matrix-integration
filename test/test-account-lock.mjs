/**
 * Cross-process account lock (src/sdk-client.ts acquireAccountLock):
 * a live holder blocks the second instance; a stale (dead pid) lock is
 * reclaimed; release only clears a lock this process holds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createPiJiti, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { SdkOutbox } = await jiti.import("../src/sdk-client.ts");
const { check, finish } = makeCheck("ACCOUNT-LOCK");

function mkOutbox(accountDir) {
  const credentialsPath = path.join(accountDir, "credentials.json");
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({ access_token: "test", device_id: "TEST" }),
  );
  const noop = () => {};
  return new SdkOutbox({
    homeserver: "matrix.example",
    userId: "@t:example",
    roomId: "#r:example",
    credentialsPath,
    logPath: path.join(accountDir, "pi-matrix.log"),
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  });
}

function deadPid() {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},50)"], {
    stdio: "ignore",
  });
  return new Promise((resolve) =>
    child.on("close", () => resolve(child.pid)),
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-matrix-lock-"));
const lockPath = path.join(dir, "pi-matrix.lock");

// 1. Clean acquire: creates the lockfile with our pid.
const o1 = mkOutbox(dir);
check("clean acquire", (await o1.acquireAccountLock()) === true);
check(
  "lockfile written",
  JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid,
);

// 2. Live holder, SAME pid (DESIGN-SUBAGENT-TRACKING §4.1): a fresh outbox
//    in this process no longer yields permanently — it polls (1 s) until
//    the holder releases, then acquires. No double Olm account is started
//    while the holder is still connected.
const o2 = mkOutbox(dir);
const pending = o2.acquireAccountLock();
await new Promise((resolve) => setTimeout(resolve, 1500));
check(
  "live holder still blocks while held",
  fs.existsSync(lockPath) &&
    JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid,
);
o1.releaseAccountLock();
check("retry-wait acquires after release", (await pending) === true);
o2.releaseAccountLock();
check("release removes own lock", !fs.existsSync(lockPath));

// 5. Stale lock (dead pid) is reclaimed by the next instance.

// 5. Stale lock (dead pid) is reclaimed by the next instance.
fs.writeFileSync(
  lockPath,
  JSON.stringify({ pid: await deadPid(), room: "#r:example" }),
);
const o3 = mkOutbox(dir);
check("stale lock reclaimed", (await o3.acquireAccountLock()) === true);
check(
  "reclaimed lock is ours",
  JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid,
);
o3.releaseAccountLock();

// 6. Missing account dir: nothing to lock — connect proceeds (no guard).
const o4 = new SdkOutbox({
  homeserver: "matrix.example",
  userId: "@t:example",
  roomId: "#r:example",
  credentialsPath: path.join(dir, "does-not-exist", "credentials.json"),
  logPath: path.join(dir, "pi-matrix.log"),
  logger: { debug(){}, info(){}, warn(){}, error(){} },
});
check("no account dir = no lock", (await o4.acquireAccountLock()) === true);

finish();
