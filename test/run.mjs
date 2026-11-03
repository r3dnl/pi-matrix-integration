/**
 * Runs the full test suite for pi-matrix-integration:
 *   1. repro.mjs             — extension loads + factory + handlers, like pi does
 *   2. test-logic.mjs        — handler/funnel logic against the fake outbox
 *   3. test-gates.mjs        — config gates (sendMilestones, autoConnect) via factory
 *   4. test-unread-model.mjs — the D1 unread model (port of mtx unread.py + thread dim)
 *   5. shadow-diff.mjs       — §5.2/§5.3 comparator selftest over the fixture NDJSON pairs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// config-contract first: it is the cheap schema/wiring gate, and every other
// suite assumes the config chains it checks are intact.
const tests = ["config-contract.mjs", "config-migration.mjs", "repro.mjs", "logic/00-core.mjs", "logic/01-threading.mjs", "logic/02-transport-footer.mjs", "logic/03-sdk-crypto.mjs", "e2e-stub-cycle.mjs", "test-gates.mjs", "test-unread-model.mjs", "test-project-provision.mjs", "test-sdk-logger.mjs", "test-stdout-capture.mjs", "test-sdk-delivery.mjs", "test-account-lock.mjs", "test-polls.mjs", "login-check.mjs", "login-wiring-check.mjs", "qr2025-check.mjs", "subagent-bus.mjs", "owner-bus.mjs", "tintinweb-provider.mjs", "nicobailon-provider.mjs", "summarizer-wake.mjs", "summarize-cadence.mjs", "stale-message-guard.mjs", "deps-contract.mjs", "security-boundary.mjs"];
// Wall-time budget (release story 8): the offline tier is the per-push
// gate; past two minutes it stops being run on every save. CI asserts on
// the printed total.
const BUDGET_MS = 120_000;
// shadow-diff runs its fixture selftest (the §5.3 gate: "runs on two fixture
// NDJSON files") rather than the two-file CLI.
const testFiles = [...tests, { file: "shadow-diff.mjs", args: ["--selftest"] }];

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
