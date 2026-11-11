/**
 * Ring 1 runner — the offline tier (docs/dev/testing.md §1).
 *
 * Membership is the test/offline/ DIRECTORY: a new unit lands there and
 * runs (the developing.md rule: add to discovery, never a second runner).
 * Order: config-contract.mjs pins first — the cheap schema/wiring gate
 * every other suite assumes — then the rest sorted, then the deep logic/
 * suites (nested Ring-1 content, also runnable standalone as test:logic),
 * and deps-contract.mjs last: it audits the package manifest, which no
 * other suite depends on.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const offline = fs
  .readdirSync(path.join(here, "offline"))
  .filter((f) => f.endsWith(".mjs"))
  // shadow-diff is a two-file CLI; it joins the tier only as --selftest below.
  .filter((f) => f !== "shadow-diff.mjs")
  .sort();
const tests = [
  "offline/config-contract.mjs",
  ...offline.filter((f) => f !== "config-contract.mjs").map((f) => `offline/${f}`),
  "logic/00-core.mjs",
  "logic/01-threading.mjs",
  "logic/02-transport-footer.mjs",
  "logic/03-sdk-crypto.mjs",
  "deps-contract.mjs",
];
// Wall-time budget (release story 8): the offline tier is the per-push
// gate; past two minutes it stops being run on every save. CI asserts on
// the printed total.
const BUDGET_MS = 120_000;
// shadow-diff runs its fixture selftest (the §5.3 gate: "runs on two fixture
// NDJSON files") on top of its bare discovery run.
const testFiles = [...tests, { file: "offline/shadow-diff.mjs", args: ["--selftest"] }];

async function run(spec) {
  const file = typeof spec === "string" ? spec : spec.file;
  const args = typeof spec === "string" ? [] : spec.args;
  console.log(`\n########## ${file}${args.length ? " " + args.join(" ") : ""} ##########`);
  const child = spawn(process.execPath, [path.join(here, file), ...args], {
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  return { code, ok: code === 0 };
}

const results = [];
const t0 = Date.now();
for (const t of testFiles) {
  const r = await run(t);
  const name = typeof t === "string" ? t : t.file;
  results.push({ t: name, ...r });
  console.log(`\n=> ${name}: ${r.ok ? "PASS" : `FAIL (exit ${r.code})`}`);
}

const failed = results.filter((r) => !r.ok).length;
const elapsed = Date.now() - t0;
console.log(`\nwall time: ${(elapsed / 1000).toFixed(1)} s (budget ${BUDGET_MS / 1000} s)`);
if (failed > 0) {
  console.error(`\n${failed}/${testFiles.length} test suite(s) FAILED`);
  process.exit(1);
}
if (elapsed > BUDGET_MS) {
  console.error(`\noffline tier exceeded its ${BUDGET_MS / 1000} s budget — fix or re-tier the slow suite`);
  process.exit(1);
}
console.log(`\nAll ${testFiles.length} test suites passed.`);
