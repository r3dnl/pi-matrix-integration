/**
 * Summary-cadence integration contract (INCIDENT-2026-10-22-SUMMARY-LOOP).
 *
 * The loop's historical fuel: a summary pass re-armed itself with exactly
 * one message — its own report-out (`post()` → `recordOnRoot` bumped the
 * send ledger `msgCount`, the number `runSummary`'s guard compared against
 * `lastSummaryAtMsg`). PROP-001 P2 removed the fuel: the cadence now runs
 * off `humanMsgCount`, which own sends never advance. The wake / directive
 * guards (summarizer-wake.mjs) keep the report-out out of the room;
 * THIS test pins the cadence side of the same contract end-to-end:
 *
 *   1. a human message then a real "final" post → exactly one dispatched pass;
 *   2. no further HUMAN tick → no further pass, ever — the extension's own
 *      posts (report-outs, milestones, echoes) advance no meter
 *      (PROP-001 P2 echo isolation);
 *   3. a real human message again → the pass re-arms (summaries follow
 *      human content).
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
import { EXT_DIR, createPiJiti, makeCheck } from "../harness/_harness.mjs";

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

  // Echo isolation (PROP-001 P2): own sends — even the report-out itself —
  // advance no meter and dispatch nothing.
  await tm.post("user work", "other");
  await tm.post("milestone body", "milestone");
  await tm.post("final report", "final");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  check("own sends dispatch nothing without a human tick", dispatched.length === 0, `n=${dispatched.length}`);

  // A human message then the report-out dispatches exactly one pass.
  await tm.recordHumanMessage();
  await tm.post("final report", "final");
  check("final post after a human tick dispatches one pass", dispatched.length === 1, `n=${dispatched.length}`);

  // Single-flight: a second final while the pass is in flight is deduped.
  await tm.post("another final", "final");
  check("in-flight second final does not double-dispatch", dispatched.length === 1, `n=${dispatched.length}`);

  // The pass completes (subagent path posts via updateSummary — a root edit,
  // NOT a new thread message; even that edit advances no meter).
  tm.updateSummary("## summary v1", "$rep-2").then(() => {});
  await new Promise((r) => setImmediate(r));
  dispatched[0].resolve();
  await new Promise((r) => setImmediate(r));

  // The incident's contract, now structural: with no HUMAN tick, NOTHING
  // re-arms — no post, no echo, no cadence point. Poll every settled
  // microtask.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  check("no human tick starves the loop forever", dispatched.length === 1, `n=${dispatched.length}`);

  // Human activity again re-arms: summaries follow human content.
  await tm.recordHumanMessage();
  await tm.post("new real work final", "final");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  check("a final after a human tick re-arms one pass", dispatched.length === 2, `n=${dispatched.length}`);
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

// ---- Part 3: a rejected root edit is retried, then given up — never re-posted --
// The old fallback posted `🧵 summary: …` as a NEW thread message and returned
// success. That left a second copy of the summary beside a stale root AND
// advanced the baseline + watermark, so the delta the rejected edit carried was
// never folded into the root again — a permanent gap. The guard: retry once,
// then return false, which leaves both untouched for the next pass to catch up.

function makeRejectingSend(failTimes) {
  const calls = [];
  let edits = 0;
  return {
    calls,
    async postThreadRoot(body) { calls.push(["root", body]); return { success: true, eventId: "$root-1" }; },
    async postThreadReply(body, rootId) { calls.push(["reply", body, rootId]); return { success: true, eventId: "$rep-1" }; },
    async editMessage(id, text) {
      edits += 1;
      calls.push(["edit", id, text]);
      return edits <= failTimes ? { success: false, error: "M_FORBIDDEN" } : { success: true };
    },
    async readTimeline() { return { success: false, messages: [] }; },
  };
}

function makeRejectManager(threadSend, stateFile) {
  return createThreadManager({
    enabled: true,
    roomKey: "!room:cadence",
    threadSend,
    statePath: path.join(stateDir, stateFile),
    threadSummaryByLlm: true,
    onSummarizeRequest: () => Promise.resolve(),
  });
}

{
  const send = makeRejectingSend(1);
  const tm = makeRejectManager(send, "retry.json");
  tm.beginSession("new", "sess-retry");
  await tm.ensureThreadRoot("retry");
  const ok = await tm.updateSummary("## v1", "$d1");
  check("a rejected edit is retried once and lands", ok === true && send.calls.filter((c) => c[0] === "edit").length === 2, JSON.stringify(send.calls.map((c) => c[0])));
  check("the retry posts no second summary message", send.calls.every((c) => c[0] !== "reply"), JSON.stringify(send.calls.map((c) => c[0])));
}

{
  const send = makeRejectingSend(99);
  const stateFile = "give-up.json";
  const tm = makeRejectManager(send, stateFile);
  tm.beginSession("new", "sess-giveup");
  await tm.ensureThreadRoot("giveup");
  const ok = await tm.updateSummary("## v1", "$d1");
  check("two rejections give up", ok === false && send.calls.filter((c) => c[0] === "edit").length === 2, JSON.stringify(send.calls.map((c) => c[0])));
  check("giving up posts nothing to the room", send.calls.filter((c) => c[0] === "reply").length === 0, JSON.stringify(send.calls.map((c) => c[0])));
  const entry = JSON.parse(fs.readFileSync(path.join(stateDir, stateFile), "utf-8"))["!room:cadence"];
  const root = entry.roots.find((r) => r.topic === "giveup");
  check(
    "a failed edit leaves baseline + watermark for the next pass",
    root.lastSummary === undefined && root.lastSummarizedEventId === undefined && root.lastSummaryAtHuman === undefined,
    JSON.stringify(root),
  );
}

fs.rmSync(stateDir, { recursive: true, force: true });
finish();
