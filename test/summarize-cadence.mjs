/**
 * Summary-cadence integration contract (INCIDENT-2026-10-22-SUMMARY-LOOP).
 *
 * The loop's fuel: a summary pass re-arms itself with exactly one message —
 * its own report-out (`post()` → `recordOnRoot` bumps `msgCount`, which is
 * what `runSummary`'s guard compares against `lastSummaryAtMsg`). The wake /
 * directive guards (summarizer-wake.mjs) keep that report-out out of the
 * room; THIS test pins the cadence side of the same contract end-to-end:
 *
 *   1. one real "final" post  → exactly one dispatched pass;
 *   2. no further thread post → no further pass, ever (the loop starves);
 *   3. a real post again      → the pass re-arms (summaries follow content).
 *
 * No fake clock is needed: the cadence path has no timers (Date.now feeds
 * `lastActivity` bookkeeping only), so the contract is deterministic with
 * plain awaits. The dispatcher and the subagent are fakes — no Matrix, no
 * pi-subagents. Part 2 covers the Engine A wiring in createSummarizeDispatcher
 * (the fallback directive must carry the structured `{ kind: "summarize" }`
 * identity the lifecycle guard mutes on).
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { EXT_DIR, createPiJiti, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("SUMMARIZE-CADENCE");

const { createThreadManager } = await jiti.import(path.join(EXT_DIR, "src", "threading.ts"));
const { createSummarizeDispatcher } = await jiti.import(path.join(EXT_DIR, "src", "summarize-dispatch.ts"));
const { SUMMARIZE_DIRECTIVE_KIND } = await jiti.import(path.join(EXT_DIR, "src", "classify.ts"));

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-matrix-cadence-"));

function makeFakeSend() {
  let n = 0;
  return {
    calls: [],
    async postThreadRoot(body) { this.calls.push(["root", body]); return { success: true, eventId: `$root-${++n}` }; },
    async postThreadReply(body, rootId) { this.calls.push(["reply", body, rootId]); return { success: true, eventId: `$rep-${++n}` }; },
    async editMessage(id, text) { this.calls.push(["edit", id, text]); return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
  };
}

// ---- Part 1: ThreadManager cadence + single-flight + starvation -------------

function makeCadenceManager(overrides = {}) {
  const dispatched = [];
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:cadence",
    threadSend: makeFakeSend(),
    statePath: path.join(stateDir, `state-${Math.random().toString(36).slice(2)}.json`),
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => new Promise((resolve) => dispatched.push({ root, resolve })),
    ...overrides,
  });
  return { tm, dispatched };
}

{
  const { tm, dispatched } = makeCadenceManager();
  tm.beginSession("new", "sess-1");
  await tm.ensureThreadRoot("cadence");

  // A non-final post never triggers a pass.
  await tm.post("user work", "other");
  await tm.post("milestone body", "milestone");
  check("non-final posts do not dispatch", dispatched.length === 0, `n=${dispatched.length}`);

  // The report-out ("final") dispatches exactly one pass.
  await tm.post("final report", "final");
  check("final post dispatches one pass", dispatched.length === 1, `n=${dispatched.length}`);

  // Single-flight: a second final while the pass is in flight is deduped.
  await tm.post("another final", "final");
  check("in-flight second final does not double-dispatch", dispatched.length === 1, `n=${dispatched.length}`);

  // The pass completes (subagent path posts via updateSummary — a root edit,
  // NOT a new thread message; this is what the muted wake would otherwise be).
  tm.updateSummary("## summary v1", "$rep-2").then(() => {});
  await new Promise((r) => setImmediate(r));
  dispatched[0].resolve();
  await new Promise((r) => setImmediate(r));

  // The incident's contract: with the wake report-out muted, NOTHING posts —
  // so no second pass can ever fire. Poll every settled microtask.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  check("muted wake (no post) starves the loop", dispatched.length === 1, `n=${dispatched.length}`);

  // Real activity again re-arms: summaries follow content.
  await tm.post("new real work final", "final");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  check("a new real final re-arms one pass", dispatched.length === 2, `n=${dispatched.length}`);
}

// ---- Part 2: Engine A wiring — the fallback directive's structured identity --

const rootFixture = { eventId: "$root-1", topic: "cadence", lastSummary: "old baseline" };
const delta = [{ eventId: "$d1", sender: "@u:t", body: "a thread message", timestamp: 1 }];

{
  const injected = [];
  const posted = [];
  const dispatch = createSummarizeDispatcher({
    source: "room",
    readDelta: async () => delta,
    subagent: { isAvailable: async () => false, run: async () => "unused" },
    injectDirective: (text, details) => injected.push({ text, details }),
    updateSummary: async (s, w) => { posted.push([s, w]); return true; },
  });
  await dispatch(rootFixture);
  check("unavailable subagent falls back to the directive", injected.length === 1, JSON.stringify(injected.map((i) => Object.keys(i))));
  check(
    "fallback directive carries kind=summarize (structured mute identity)",
    injected[0]?.details?.kind === SUMMARIZE_DIRECTIVE_KIND,
    JSON.stringify(injected[0]?.details),
  );
  check("directive body is the summary pass instruction", String(injected[0]?.text).startsWith("Run a Matrix thread-summary pass"), String(injected[0]?.text).slice(0, 40));
  check("fallback path posts no summary itself", posted.length === 0);
}

{
  const injected = [];
  const posted = [];
  const dispatch = createSummarizeDispatcher({
    source: "room",
    readDelta: async () => delta,
    subagent: { isAvailable: async () => true, run: async () => "## new summary" },
    injectDirective: (text, details) => injected.push({ text, details }),
    updateSummary: async (s, w) => { posted.push([s, w]); return true; },
  });
  await dispatch(rootFixture);
  check("available subagent path injects nothing", injected.length === 0);
  check("available subagent posts the summary + watermark", posted.length === 1 && posted[0][0] === "## new summary" && posted[0][1] === "$d1", JSON.stringify(posted));
}

{
  // A failed/empty run keeps the last summary — never clobbers the root.
  const posted = [];
  const dispatch = createSummarizeDispatcher({
    source: "room",
    readDelta: async () => delta,
    subagent: { isAvailable: async () => true, run: async () => null },
    injectDirective: () => {},
    updateSummary: async (s, w) => { posted.push([s, w]); return true; },
  });
  await dispatch(rootFixture);
  check("null subagent result posts nothing", posted.length === 0, JSON.stringify(posted));
}

fs.rmSync(stateDir, { recursive: true, force: true });
finish();
