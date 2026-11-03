/**
 * nicobailon adapter contract (DESIGN-SUBAGENT-PROVIDER §3.2/§8): the
 * shared behavioral kit + this dialect's wire details (v1 envelope,
 * asyncComplete/notify completion channels, no consume call, input
 * normalizers, `subagent`/`workflow` watch names).
 */
import path from "node:path";
import { EXT_DIR, createPiJiti, makeCheck } from "./_harness.mjs";
import { providerContract } from "./_provider_kit.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("NICOBAILON-PROVIDER");
const SID = "session-1";
const RUN = "run-1";
const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
// src/shared/types.js: SUBAGENT_ASYNC_COMPLETE_EVENT
const ASYNC = "subagent:async-complete";

function makeBus({ scenario = "ok", result = "" } = {}) {
  const handlers = new Map();
  const requests = [];
  const spawns = [];
  let consumeSeen = 0;
  const bus = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, data) {
      const set = handlers.get(event);
      if (set) for (const fn of [...set]) fn(data);
      if (event === "subagents:rpc:consume") consumeSeen++;
      if (event !== REQUEST) return;
      requests.push(data);
      if (data.method === "spawn") spawns.push(data);
      const { requestId, method } = data;
      const reply = (payload) => bus.emit(REPLY_PREFIX + requestId, payload);
      if (method === "ping" && scenario !== "silent") {
        // rpc.js reply envelope: {version, requestId, method, success, data}
        reply(scenario === "unavailable" ? { success: false, error: { message: "no session" } } : { success: true, data: { version: 1 } });
      }
      if (method === "spawn") {
        if (scenario === "spawn-fail") reply({ success: false, error: { code: "invalid_params", message: "no such agent" } });
        else if (scenario === "ok" || scenario === "fail" || scenario === "hang") {
          // async spawn ack: data = {text, details:{runId, asyncId, ...}}
          reply({ success: true, data: { text: "queued", details: { runId: RUN, asyncId: RUN, mode: "single" } } });
          setTimeout(() => {
            if (scenario === "fail") bus.emit(ASYNC, { id: RUN, runId: RUN, sessionId: SID, state: "failed", success: false, summary: "boom" });
            // harness prefixes the agent name — the provider must strip it (live-root bug 2026-10-24)
            else if (scenario === "ok") bus.emit(ASYNC, { id: RUN, runId: RUN, sessionId: SID, state: "complete", success: true, summary: `pi-matrix-integration-thread-summarizer:\n\n${result}` });
          }, 0);
        }
      }
    },
  };
  return { bus, requests, spawns, consumeSeen: () => consumeSeen };
}

await providerContract(
  jiti,
  check,
  {
    id: "nicobailon",
    makeBus,
    assertSpawn(requests, check) {
      const spawn = requests.find((r) => r.method === "spawn");
      check(
        "spawn wire shape: v1 envelope {agent, task, async, quiet origin}",
        spawn?.version === 1 &&
          spawn?.params?.agent === "pi-matrix-integration-thread-summarizer" &&
          spawn?.params?.task === "PROMPT" &&
          spawn?.params?.async === true &&
          spawn?.params?.scheduleOrigin?.quiet === true,
        JSON.stringify(spawn),
      );
    },
  },
);

// ---- dialect wire specifics beyond the shared kit ----
{
  const { createNicobailonProvider } = await jiti.import(
    path.join(EXT_DIR, "src/subagent-providers/nicobailon-provider.ts"),
  );
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const mk = (bus, over = {}) =>
    createNicobailonProvider({
      events: bus,
      logger: quiet,
      agentType: "pi-matrix-integration-thread-summarizer",
      pingTimeoutMs: 20,
      runTimeoutMs: 500,
      ...over,
    });

  // The v1 dialect has no consume — the asyncComplete event IS the ack.
  {
    const { bus, consumeSeen } = makeBus({ scenario: "ok", result: "body" });
    const p = mk(bus);
    check("run resolves", (await p.runIsolated("P")) === "body", "");
    check("no consume request in this dialect", consumeSeen() === 0, String(consumeSeen()));
  }

  // Non-complete states (partial/stopped) read as failures — the root
  // keeps its last summary.
  {
    const handlers = new Map();
    const bus = {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event, data) {
        const set = handlers.get(event);
        if (set) for (const fn of [...set]) fn(data);
        if (event === REQUEST && data.method === "ping") {
          bus.emit(REPLY_PREFIX + data.requestId, { success: true, data: {} });
        }
        if (event === REQUEST && data.method === "spawn") {
          bus.emit(REPLY_PREFIX + data.requestId, { success: true, data: { details: { runId: RUN } } });
          setTimeout(() => bus.emit(ASYNC, { runId: RUN, state: "partial", success: false, summary: "budget exhausted" }), 0);
        }
      },
    };
    check("partial state → null (keep the last summary)", (await mk(bus).runIsolated("P")) === null, "");
  }

  // completionChannel: forwards completions for runs nobody awaits.
  {
    const { bus } = makeBus({ scenario: "silent" });
    const p = mk(bus);
    const seen = [];
    const off = p.completionChannel((name, result) => seen.push([name, result]));
    bus.emit(ASYNC, { runId: "pane-run-1", state: "complete", success: true, summary: "done" });
    check("channel forwards unknown-run completions", seen.length === 1 && seen[0][0] === "pane-run-1" && seen[0][1] === "done", JSON.stringify(seen));
    bus.emit(ASYNC, { runId: "pane-run-f", state: "failed", success: false, summary: "boom" });
    check("channel forwards failed runs too (the spawn line must settle)", seen.length === 2 && seen[1][0] === "pane-run-f" && seen[1][1] === "boom", JSON.stringify(seen));
    off();
    bus.emit(ASYNC, { runId: "pane-run-2", state: "complete", success: true, summary: "later" });
    check("unsubscribe stops the flow", seen.length === 2, JSON.stringify(seen));
  }

  // Watch names + normalizers (DESIGN-SUBAGENT-PROVIDER §5).
  {
    const p = mk(makeBus({ scenario: "silent" }).bus);
    check(
      "watch names: subagent+Agent / workflow",
      p.spawnWatch.agentToolNames.join() === "subagent,Agent" && p.spawnWatch.workflowToolNames.join() === "workflow",
      JSON.stringify(p.spawnWatch),
    );
    check(
      "task → first-line name + agent type",
      JSON.stringify(p.spawnWatch.normalizeAgent({ task: "line one\nline two", agent: "explore" })) ===
        JSON.stringify({ name: "line one", subagent_type: "explore" }),
      "",
    );
    check(
      "long task → 120-char cap",
      p.spawnWatch.normalizeAgent({ task: "x".repeat(200), agent: "a" }).name.length === 120,
      "",
    );
    check(
      "agent-only input names the run by agent",
      JSON.stringify(p.spawnWatch.normalizeAgent({ agent: "worker" })) ===
        JSON.stringify({ name: "worker", subagent_type: "worker" }),
      "",
    );
    check("nameless input → null (no bus spawn)", p.spawnWatch.normalizeAgent({}) === null, "");
    check(
      "workflow normalizer",
      p.spawnWatch.normalizeWorkflow({ name: "wf" })?.subagent_type === "workflow" &&
        p.spawnWatch.normalizeWorkflow({}).name === "workflow",
      "",
    );
  }
}

finish();
