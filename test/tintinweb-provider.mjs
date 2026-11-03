/**
 * tintinweb adapter contract (DESIGN-SUBAGENT-PROVIDER §3.1/§8): the
 * shared behavioral kit + this dialect's wire details (spawn payload keys,
 * consume suppression, `Agent`/`SubagentWorkflow` watch names).
 */
import path from "node:path";
import { EXT_DIR, createPiJiti, makeCheck } from "./_harness.mjs";
import { providerContract } from "./_provider_kit.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("TINTINWEB-PROVIDER");
const AGENT = "agent-1";

function makeBus({ scenario = "ok", result = "" } = {}) {
  const handlers = new Map();
  const spawns = [];
  let consumed = 0;
  const bus = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, data) {
      const set = handlers.get(event);
      if (set) for (const fn of [...set]) fn(data);
      if (event === "subagents:rpc:consume") consumed++;
      if (event === "subagents:rpc:ping" && scenario !== "silent") {
        bus.emit(
          `subagents:rpc:ping:reply:${data.requestId}`,
          scenario === "unavailable"
            ? { success: false, error: "pi-subagents not present" }
            : { success: true, data: { version: 2 } },
        );
      }
      if (event === "subagents:rpc:spawn") {
        spawns.push(data);
        if (scenario === "spawn-fail") {
          bus.emit(`subagents:rpc:spawn:reply:${data.requestId}`, { success: false, error: "rejected" });
        } else if (scenario === "ok" || scenario === "fail" || scenario === "hang") {
          bus.emit(`subagents:rpc:spawn:reply:${data.requestId}`, { success: true, data: { id: AGENT } });
          setTimeout(() => {
            if (scenario === "fail") bus.emit("subagents:failed", { id: AGENT, status: "failed" });
            else if (scenario === "ok") bus.emit("subagents:completed", { id: AGENT, status: "completed", result });
          }, 0);
        }
      }
    },
  };
  return { bus, spawns, consumed: () => consumed };
}

await providerContract(
  jiti,
  check,
  {
    id: "tintinweb",
    makeBus,
    assertSpawn(spawns, check) {
      check(
        "spawn wire shape: {requestId, type, prompt, options.isolated}",
        spawns[0]?.type === "pi-matrix-integration-thread-summarizer" &&
          spawns[0]?.prompt === "PROMPT" &&
          spawns[0]?.options?.isolated === true,
        JSON.stringify(spawns[0]),
      );
    },
  },
);

// ---- dialect wire specifics beyond the shared kit ----
{
  const { createTintinwebProvider } = await jiti.import(
    path.join(EXT_DIR, "src/subagent-providers/tintinweb-provider.ts"),
  );
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const p = createTintinwebProvider({
    events: makeBus({ scenario: "silent" }).bus,
    logger: quiet,
    agentType: "pi-matrix-integration-thread-summarizer",
    pingTimeoutMs: 20,
    runTimeoutMs: 100,
  });
  check(
    "watch names: Agent / SubagentWorkflow",
    p.spawnWatch.agentToolNames.join() === "Agent" && p.spawnWatch.workflowToolNames.join() === "SubagentWorkflow",
    JSON.stringify(p.spawnWatch),
  );
  check(
    "normalizeAgent passes the bus shape through",
    p.spawnWatch.normalizeAgent({ name: "x", subagent_type: "explore" })?.subagent_type === "explore",
    "",
  );
  check(
    "normalizeWorkflow falls back to name=workflow",
    p.spawnWatch.normalizeWorkflow({}).name === "workflow",
    "",
  );
  check("no completionChannel in this dialect", p.completionChannel === undefined, "");
}

finish();
