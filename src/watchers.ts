/**
 * Pi Matrix Integration — ToolWatchers (TO-BE restructure, Slice 3).
 *
 * The sub-agent sub-thread markers (DESIGN §1.5/§2.8, S4 verdict:
 * event-based), extracted verbatim from index.ts: the shipped
 * `subagent` extension registers a tool (configurable via
 * `subagentToolName`); one call spawns 1..N sub-agents → N sub-thread
 * roots under the active thread root, plus a completion marker from the
 * spawn call's result. Gated on `subThreads` (which itself requires
 * `threads`); with no subagent extension present, nothing fires and
 * threading is unaffected.
 *
 * The core `Agent` / `SubagentWorkflow` tools (DESIGN-SUBAGENT-TRACKING
 * §4.5): their spawns are routed to the sub-agent bus via the `coreAgent`
 * delegate — the OWNER instance registers spawns (spawn line / anchor),
 * a SIDE-CHAIN instance registers nested spawns (milestone lines, §4.6).
 * Detection is always on; the delegate decides what gets reported.
 *
 * The instance is rebuilt with the stack on /matrix-switch (the
 * object-stable rebind discipline) — the index.ts registrations dispatch
 * through the CURRENT watcher at call time.
 */

import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { MatrixConfig } from "./types.js";
import type { ThreadManager } from "./threading.js";
import { deriveRole, subagentNames } from "./classify.js";
import type { AgentSpawnInput } from "./subagent-bus.js";
import type { SpawnWatch } from "./subagent-provider.js";

/** The core Agent-tool delegate (wired by the composition root). Inputs are
 *  provider-normalized by the watcher (DESIGN-SUBAGENT-PROVIDER §5) — the
 *  delegate only ever sees the bus's `AgentSpawnInput` shape. */
export interface CoreAgentDelegate {
  /** An agent-spawn tool_call in THIS session (owner spawn or nested spawn). */
  onAgentTool(input: AgentSpawnInput): void;
  /** A workflow-spawn tool_call in THIS session (container spawn). */
  onWorkflowTool(input: AgentSpawnInput): void;
  /** The spawn tool_result of a detached child: attach the provider run
   *  id to the running record (DESIGN-SUBAGENT-PROVIDER §6 — the join
   *  key for the completion-channel settle). */
  onAgentRunId?(prompt: string, runId: string): void;
}

/** Full default watch for stacks built without a resolved provider
 *  (DESIGN-SUBAGENT-PROVIDER §5): today's tintinweb tool names + today's
 *  input passthrough, so the pre-contract behavior is the fallback. */
const DEFAULT_SPAWN_WATCH: SpawnWatch = {
  agentToolNames: ["Agent"],
  workflowToolNames: ["SubagentWorkflow"],
  normalizeAgent: (input) => ({ ...input }) as AgentSpawnInput,
  normalizeWorkflow: (input) => ({
    name: typeof input.name === "string" && input.name ? input.name : "workflow",
    subagent_type: "workflow",
  }),
};

export interface ToolWatchersDeps {
  /** The stack's config — always the current one (the watcher is rebuilt
   *  with the stack). */
  cfg: MatrixConfig;
  threadManager: ThreadManager;
  /** Optional: the core Agent-tool delegate (undefined in stacks built
   *  before sub-agent tracking — nothing fires). */
  coreAgent?: CoreAgentDelegate;
  /** Live spawn-name source (DESIGN-SUBAGENT-PROVIDER §5): the resolved
   *  provider's `spawnWatch`, consulted per call so an `auto` re-probe
   *  (§4) can re-bind without rebuilding the watcher. Absent → today's
   *  tintinweb tool names (pre-contract fallback). */
  getSpawnWatch?: () => SpawnWatch;
  /** Temporary spawn-diagnostics sink (debug level) — see `onToolCall`. */
  log?: (line: string) => void;
}

export class ToolWatchers {
  private readonly deps: ToolWatchersDeps;

  constructor(deps: ToolWatchersDeps) {
    this.deps = deps;
  }

  /** The provider's agent/workflow spawn tools → the bus delegate; the
   *  `subagent` tool_call → one sub-thread spawn per agent name. */
  async onToolCall(event: ToolCallEvent): Promise<void> {
    const cfg = this.deps.cfg;
    const spawnWatch = this.deps.getSpawnWatch?.() ?? DEFAULT_SPAWN_WATCH;
    const watched =
      spawnWatch.agentToolNames.includes(event.toolName) ||
      spawnWatch.workflowToolNames.includes(event.toolName);
    if (watched) {
      this.deps.log?.(
        `[matrix] tool_call ${event.toolName} watched — input keys: ${Object.keys(event.input ?? {}).join(",")}`,
      );
    }
    if (spawnWatch.agentToolNames.includes(event.toolName)) {
      const norm = spawnWatch.normalizeAgent((event.input ?? {}) as Record<string, unknown>);
      if (norm) this.deps.coreAgent?.onAgentTool(norm);
      else this.deps.log?.(`[matrix] tool_call ${event.toolName} normalizeAgent → null`);
      // A dialect may route spawns through the same tool the sub-thread
      // markers watch (nicobailon's `subagent`): a name collision must not
      // consume the event — the marker path below still runs when
      // `subThreads` is on.
      if (event.toolName !== (cfg.subagentToolName ?? "subagent")) return;
    } else if (spawnWatch.workflowToolNames.includes(event.toolName)) {
      const norm = spawnWatch.normalizeWorkflow((event.input ?? {}) as Record<string, unknown>);
      if (norm) this.deps.coreAgent?.onWorkflowTool(norm);
      return;
    }
    if (!cfg.threads || !cfg.subThreads) return;
    if (event.toolName !== (cfg.subagentToolName ?? "subagent")) return;
    for (const name of subagentNames(event.input)) {
      await this.deps.threadManager.spawnSubThread(name, deriveRole(name));
    }
  }

  /** The `subagent` tool_result → the completion marker per agent name;
   *  also the run-id attach point for detached children (§6). */
  async onToolResult(event: ToolResultEvent): Promise<void> {
    const cfg = this.deps.cfg;
    const spawnWatch = this.deps.getSpawnWatch?.() ?? DEFAULT_SPAWN_WATCH;
    if (!event.isError && spawnWatch.agentToolNames.includes(event.toolName)) {
      const norm = spawnWatch.normalizeAgent((event.input ?? {}) as Record<string, unknown>);
      const det = event.details as { details?: { runId?: string; asyncId?: string } } | undefined;
      const runId = det?.details?.runId ?? det?.details?.asyncId;
      if (norm?.prompt && runId) this.deps.coreAgent?.onAgentRunId?.(norm.prompt, runId);
    }
    if (!cfg.threads || !cfg.subThreads) return;
    if (event.toolName !== (cfg.subagentToolName ?? "subagent")) return;
    for (const name of subagentNames(event.input)) {
      await this.deps.threadManager.completeSubThread(name, !event.isError, deriveRole(name));
    }
  }
}

/** Build the tool watchers (the one-line factory pattern). */
export function createToolWatchers(deps: ToolWatchersDeps): ToolWatchers {
  return new ToolWatchers(deps);
}
