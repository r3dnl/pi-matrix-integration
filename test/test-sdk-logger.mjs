/**
 * test-sdk-logger.mjs — the sdk transport's js-sdk `Logger` (src/logger.ts
 * `createJsSdkFileLogger`): lines land in the logfile, not the console;
 * getChild prefixes the namespace; 1 MB rotation keeps the file bounded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createJsSdkFileLogger } = jiti("../src/logger.ts");
const { check, finish } = makeCheck("sdk-logger");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-log-"));
const logPath = path.join(tmp, "pi-matrix-http-sdk.log");

const logger = createJsSdkFileLogger(logPath);
logger.info("sync started", { a: 1 });
logger.debug(new Error("boom"));
const sync = logger.getChild("sync");
sync.warn("long poll timeout");

// Severity gate (the js-sdk rebind bypasses loglevel's own gating — this
// is the only filter): an INFO gate must drop debug/trace, keep warn.
const gatedPath = path.join(tmp, "gated.log");
const gated = createJsSdkFileLogger(gatedPath, "info");
gated.debug("sync tick");
gated.trace("wire bytes");
gated.info("sync started");
gated.warn("long poll timeout");
const gatedRaw = fs.readFileSync(gatedPath, "utf8");
check("gate drops debug/trace", !gatedRaw.includes("debug") && !gatedRaw.includes("trace"), gatedRaw);
check("gate keeps info/warn", /\[info\] sync started/.test(gatedRaw) && /\[warn\] long poll timeout/.test(gatedRaw));

const raw = fs.readFileSync(logPath, "utf8");
// `append` writes `<iso> [level] message` — an entry starts with the ISO
// timestamp (an Error stack spans continuation lines without one).
const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z /;
const entries = raw.split("\n").filter((l) => ISO.test(l)).map((l) => l.replace(ISO, ""));
check("one entry per call", entries.length === 3, `got ${entries.length}`);
check("level + message format", entries[0] === `[info] sync started {"a":1}`, entries[0]);
check("error captured", raw.includes("[debug] Error: boom"));
check("getChild namespace prefix", entries[2] === `[warn] [sync] long poll timeout`, entries[2]);

// rotation: push the file past 1 MB → renamed to .old, fresh file started
fs.appendFileSync(logPath, "x".repeat(1_100_000));
logger.info("after rotation");
check("rotated to .old", fs.existsSync(`${logPath}.old`));
check(
  "fresh file holds the new line only",
  /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z \[info\] after rotation\n$/.test(fs.readFileSync(logPath, "utf8")),
);

finish();
