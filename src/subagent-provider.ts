/**
 * Pi Matrix Integration — SubagentProvider contract.
 *
 * The single seam between this extension and the sub-agent provider package
 * installed alongside pi (`@tintinweb/pi-subagents` today, `pi-subagents`
 * (nicobailon) as the trial target, `@gotgenes/pi-subagents` as the
 * dialect-compatible fallback). Providers are reached ONLY through the
 * injected `pi.events` bus — never an import (different install roots; a
 * hard import is not guaranteed to resolve from a local extension,
 * threads-and-summaries.md).
 *
 * Rules:
 *  - Only the composition root (`integration.ts` buildStack) resolves a
 *    provider. The bus, lifecycle, watchers and posting code consume the
 *    normalized `AgentSpawnInput` shape and never learn who provided it.
 *  - Adapters own every wire-format detail (event names, payload shapes,
 *    completion correlation). Nothing else may know a dialect.
 *  - Availability failure is a VALUE, never a throw: no provider → callers
 *    fall back exactly as before the contract existed.
 */

import type { AgentSpawnInput } from "./subagent-bus.js";
import type { MatrixLogger } from "./logger.js";

export type SubagentProviderId = "tintinweb" | "nicobailon";

/** The minimal event-bus surface a provider needs (the `pi.events` bus). */
export interface SubagentEvents {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** Per-stack settings handed to a provider factory (resolved defaults). */
export interface SubagentProviderDeps {
  events: SubagentEvents;
  logger: MatrixLogger;
  /** Tool-less agent type used for the room-summary run. "pi-matrix-integration-thread-summarizer". */
  agentType: string;
  /** Optional model pin ("provider/modelId") for the run. */
  model?: string;
  /** ms before an unanswered availability probe means "not installed". */
  pingTimeoutMs: number;
  /** ms before a running subagent is abandoned (resolve null). */
  runTimeoutMs: number;
  /** ms for the spawn ACK only (dispatched immediately on accept; the only
   *  real failure mode is the bus never answering). Separate from
   *  runTimeoutMs, which is a hung-child watchdog ceiling, not a budget.
   *  Default 30000. */
  spawnTimeoutMs?: number;
}

/**
 * Tool-call names that register bus spawns + the input normalizers
 * . The
 * watchers route a `tool_call` whose name matches `agentToolNames` (resp.
 * `workflowToolNames`) through the matching normalizer and hand the result
 * to the bus; the bus only ever sees `AgentSpawnInput`.
 */
export interface SpawnWatch {
  agentToolNames: string[];
  workflowToolNames: string[];
  normalizeAgent(input: Record<string, unknown>): AgentSpawnInput | null;
  normalizeWorkflow(input: Record<string, unknown>): AgentSpawnInput | null;
}

export interface SubagentProvider {
  readonly id: SubagentProviderId;
  /** Dialect-specific availability probe over the injected bus. */
  isAvailable(): Promise<boolean>;
  /**
   * Isolated, tool-less one-shot run (the room-summarizer use,
   * threads-and-summaries.md). Resolves the final text, or null when
   * unavailable / spawn failed / run failed / timed out — the caller keeps
   * the last summary and never clobbers the root. The result is consumed so
   * no completion notification lands on top of it.
   */
  runIsolated(prompt: string, description?: string): Promise<string | null>;
  readonly spawnWatch: SpawnWatch;
  /**
   * Optional provider-side completion signal that can settle bus records
   * for children this process does not host (detached-runner posture,
   * configuration-and-room-behaviour.md). Returns the unsubscribe.
   */
  completionChannel?(onSettle: (name: string, result: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Shared adapter helpers (moved verbatim from subagent-summarizer.ts)
// ---------------------------------------------------------------------------

let seq = 0;
export function newRequestId(): string {
  seq += 1;
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const rand = c?.randomUUID ? c.randomUUID() : `r${Math.floor(Math.random() * 1e12).toString(36)}`;
  return `${rand}-${seq}`;
}

/** A fire-and-forget timer that must not keep the process alive. */
export function unref<T>(timer: T): T {
  const u = (timer as { unref?: () => void }).unref;
  if (typeof u === "function") u.call(timer);
  return timer;
}

/** Config value for `subagents.provider` . */
export type SubagentProviderSetting = "auto" | SubagentProviderId;
