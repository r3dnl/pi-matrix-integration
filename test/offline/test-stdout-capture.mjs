/**
 * test-stdout-capture.mjs — the two stdout-capture layers in
 * src/logger.ts:
 *
 * - `rebindJsSdkModuleLogger`: rebinds the real matrix-js-sdk module-level
 *   logger (lib/logger.js — the "setting pendingEvent status" source) in
 *   place; calls on the shared object and its children land in the
 *   logfile, not the console.
 * - `installConsoleInterceptor`: global `console` + unhandled
 *   rejections route to the logfile; the newest install owns the route,
 *   only the newest teardown restores; stale uninstallers no-op.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  createJsSdkFileLogger,
  rebindJsSdkModuleLogger,
  installConsoleInterceptor,
} = jiti("../../src/logger.ts");
const { check, finish } = makeCheck("stdout-capture");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-stdout-"));
const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z /;
const entries = (p) =>
  fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => ISO.test(l));

// --- layer 1: the real module-level logger object, rebound in place
const { logger: sdkLogger } = await import("matrix-js-sdk/lib/logger.js");
const target = createJsSdkFileLogger(path.join(tmp, "pi-matrix-http-sdk.log"));
rebindJsSdkModuleLogger(sdkLogger, target);
sdkLogger.log("setting pendingEvent status to sent (rebound)");
sdkLogger.getChild("sync").warn("namespaced child");
check(
  "log() lands in the file",
  entries(
    path.join(tmp, "pi-matrix-http-sdk.log"),
  ).some((l) => l.includes("[info] setting pendingEvent status to sent (rebound)")),
);
check(
  "getChild routes to the file with the namespace prefix",
  entries(path.join(tmp, "pi-matrix-http-sdk.log")).some(
    (l) => l.includes("[warn]") && l.includes("[sync] namespaced child"),
  ),
);
check("getChild is cached per namespace", sdkLogger.getChild("sync") === sdkLogger.getChild("sync"));

// --- layer 2: global console interception (note: check()'s own console
// output is routed to the file while installed; visible again after
// uninstall)
const consoleLogPath = path.join(tmp, "console.log");
const origLog = console.log;
const uninstall = installConsoleInterceptor(consoleLogPath);
console.log("probe line");
console.warn("warn probe", { n: 1 });
check("console.log lands in the file", entries(consoleLogPath).some((l) => l.includes("[log] probe line")));
check(
  "console.warn lands in the file",
  entries(consoleLogPath).some((l) => l.includes('[warn] warn probe {"n":1}')),
);
check("console re-bound", console.log !== origLog);

// ownership (F4): the newest install re-targets the capture; a
// superseded stack's uninstaller is a no-op; only the newest teardown
// restores the console (the old first-install-wins flag let a stale
// /matrix-switch teardown kill capture the new stack still expected).
const secondLogPath = path.join(tmp, "second.log");
const secondUninstall = installConsoleInterceptor(secondLogPath);
console.log("routed to second");
check(
  "second install re-targets the capture",
  entries(secondLogPath).some((l) => l.includes("routed to second")) &&
    !entries(consoleLogPath).some((l) => l.includes("routed to second")),
);
uninstall(); // the superseded stack's teardown
check("stale uninstall keeps capture", console.log !== origLog);
console.log("still captured");
check(
  "capture still lands in the newest target",
  entries(secondLogPath).some((l) => l.includes("still captured")),
);

// unhandled rejection -> the file (the interceptor's handler swallows
// Node's default fatal exit — that is the log-and-continue semantics)
Promise.reject(new Error("rejection test"));
await new Promise((r) => setTimeout(r, 100));
check(
  "unhandled rejection lands in the newest target",
  entries(secondLogPath).some((l) => l.includes("unhandled promise rejection: Error: rejection test")),
);

secondUninstall();
check("newest uninstall restores the original console", console.log === origLog);

finish();
