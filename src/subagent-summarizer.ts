/**
 * Pi Matrix Integration — Subagent summarizer driver (DESIGN-ROOM-SUMMARIZER §5/§6)
 *
 * Thin driver over a `SubagentProvider` (DESIGN-SUBAGENT-PROVIDER §3): the
 * dialect knowledge (RPC event names, spawn payload, completion correlation,
 * result consumption) lives in `src/subagent-providers/<dialect>-provider.ts`. This
 * file keeps the public surface the cadence codes against —
 * `isAvailable()` → false means "no provider here, use the in-session
 * directive"; `run(prompt)` resolves the new summary body or null (never
 * clobber the root).
 *
 * R1 of DESIGN-SUBAGENT-PROVIDER: the default provider is the tintinweb
 * adapter holding the original bodies verbatim; the existing fake-bus tests
 * replay unchanged (the refactor's correctness gate, G2).
 */

import type { MatrixLogger } from "./logger.js";
import { createConsoleLogger } from "./logger.js";
import { createTintinwebProvider } from "./subagent-providers/tintinweb-provider.js";
import type { SubagentEvents, SubagentProvider } from "./subagent-provider.js";

export type { SubagentEvents } from "./subagent-provider.js";

export interface SubagentSummarizerOptions {
  events: SubagentEvents;
  /** Subagent type (an agent file in the agent dir). Default "pi-matrix-integration-thread-summarizer". */
  agentType?: string;
  /** Optional model pin ("provider/modelId") for the run. Omit to inherit. */
  model?: string;
  /** ms before an unanswered ping is treated as "not available". Default 1500. */
  pingTimeoutMs?: number;
  /** ms before a running subagent is abandoned (resolve null). Watchdog
   *  ceiling for hung children, not a time budget. Default 120000. */
  runTimeoutMs?: number;
  /** ms for the spawn ACK (dispatched immediately on accept). Default 30000. */
  spawnTimeoutMs?: number;
  logger?: MatrixLogger;
  /**
   * Resolved provider (DESIGN-SUBAGENT-PROVIDER §4). Omit → the tintinweb
   * adapter, preserving today's behavior for every existing caller.
   */
  provider?: SubagentProvider;
}

export interface SubagentSummarizer {
  isAvailable(): Promise<boolean>;
  /**
   * Spawn the summarizer subagent and resolve with its final text (the new
   * summary body) on completion. Resolves `null` when unavailable, the spawn
   * fails, the run errors, or it times out — the caller then keeps the last
   * summary (never clobber the root). The result is consumed so a completion
   * notification is not delivered on top of it.
   */
  run(prompt: string, description?: string): Promise<string | null>;
}

/**
 * Build a subagent-summarizer driver bound to an event bus. Pure with respect
 * to the bus: inject a fake bus in tests to exercise the ping/spawn/settle/
 * consume paths without `pi-subagents` installed.
 */
export function createSubagentSummarizer(opts: SubagentSummarizerOptions): SubagentSummarizer {
  const provider =
    opts.provider ??
    createTintinwebProvider({
      events: opts.events,
      logger: opts.logger ?? createConsoleLogger(),
      agentType: opts.agentType ?? "pi-matrix-integration-thread-summarizer",
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      pingTimeoutMs: opts.pingTimeoutMs ?? 1500,
      runTimeoutMs: opts.runTimeoutMs ?? 120_000,
      ...(opts.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: opts.spawnTimeoutMs } : {}),
    });

  return {
    isAvailable: () => provider.isAvailable(),
    run: (prompt, description) => provider.runIsolated(prompt, description),
  };
}
