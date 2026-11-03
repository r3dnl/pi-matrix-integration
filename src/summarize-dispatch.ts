/**
 * Pi Matrix Integration - Thread-summary dispatch (threads-and-summaries.md + source flag)
 *
 * Decides how a summary pass runs for a thread root, and who runs it:
 *
 *  - `source: "room"` (default): the delta is the thread's own Matrix
 *    messages (`readDelta`). The isolated `pi-matrix-integration-thread-summarizer` subagent runs the
 *    pass when pi-subagents is present; the in-session directive is the
 *    fallback when it is not. On failure the last summary is kept.
 *  - `source: "session"` (legacy, threads-and-summaries.md): the delta is the main Pi
 *    session's own context. That context only exists in the main session,
 *    so the pass runs THERE — a baseline-only directive is injected; no
 *    subagent spawn, no context copy, no room read.
 *
 * The in-session path posts via the `matrix_update_thread_summary` tool
 * (the extension prepends the `🧵 {topic}` line); the subagent path posts
 * directly through `updateSummary`.
 */

import type { MatrixLogger } from "./logger.js";
import { createConsoleLogger } from "./logger.js";
import { SUMMARIZE_DIRECTIVE_KIND } from "./classify.js";
import type { SummaryLimits, ThreadDeltaMessage } from "./summarize.js";
import { buildThreadSummarizeDirective, buildThreadSummarizePrompt } from "./summarize.js";
import type { SubagentSummarizer } from "./subagent-summarizer.js";

/** Minimal root surface the dispatcher needs (structural view of ThreadRootState). */
export interface SummarizeRoot {
  eventId: string;
  topic: string;
  lastSummary?: string;
  lastSummarizedEventId?: string;
  /** Persisted milestone ledger — the evergreen fir-tree anchor. */
  milestones?: readonly string[];
}

export interface SummarizeDispatcherDeps {
  /** "session" runs the legacy in-session pass; anything else runs the room-sourced pass. */
  source?: "room" | "session";
  /** Fir-tree shape caps handed to both runners (default DEFAULT_SUMMARY_LIMITS). */
  limits?: SummaryLimits;
  /** Room-sourced delta, read from the room rather than the session. Not called in session mode. */
  readDelta: (root: SummarizeRoot) => Promise<ThreadDeltaMessage[]>;
  /** Subagent driver (room mode only; `isAvailable()` pings the RPC bus). */
  subagent: SubagentSummarizer;
  /** In-session path: inject the hidden user directive the agent answers via the tool. */
  injectDirective: (text: string, details?: { kind: string }) => void;
  /** Post a new summary body to the thread root (+ optionally advance the event watermark). */
  updateSummary: (summary: string, watermarkEventId?: string) => Promise<boolean>;
  logger?: MatrixLogger;
}

/**
 * Fire-and-forget: the dispatch never blocks the caller's send path. The
 * returned promise (room mode) settles when the run finished or failed — it
 * NEVER rejects (all failures are caught and logged). The ThreadManager
 * single-flight guard uses it to release the in-flight flag; session mode
 * has no async phase to track and returns undefined.
 */
export type SummarizeDispatcher = (root: SummarizeRoot) => Promise<void> | void;

export function createSummarizeDispatcher(deps: SummarizeDispatcherDeps): SummarizeDispatcher {
  const source = deps.source === "session" ? "session" : "room";
  const logger = deps.logger ?? createConsoleLogger();
  return (root: SummarizeRoot) => {
    if (source === "session") {
      // Legacy (threads-and-summaries.md): the main session's own context is the delta
      // source, so the main session runs the pass — no subagent spawn, no
      // context copy, no room read.
      deps.injectDirective(buildThreadSummarizeDirective(root, [], { limits: deps.limits }), {
        kind: SUMMARIZE_DIRECTIVE_KIND,
      });
      return;
    }
    return (async () => {
      const delta = await deps.readDelta(root);
      const lastDeltaEventId = delta.length > 0 ? delta[delta.length - 1].eventId : undefined;
      if (await deps.subagent.isAvailable()) {
        const prompt = buildThreadSummarizePrompt({
          topic: root.topic,
          lastSummary: root.lastSummary,
          delta,
          limits: deps.limits,
          milestoneCandidates: root.milestones,
        });
        const summary = await deps.subagent.run(prompt, `Matrix thread summary (${root.topic})`);
        // null = subagent failed / empty result → keep lastSummary; never
        // clobber the root.
        if (summary !== null) {
          await deps.updateSummary(summary, lastDeltaEventId).catch((error: unknown) => {
            logger.warn(`[matrix] thread summary post failed: ${error}`);
          });
        }
      } else {
        // Room-sourced in-session fallback (pi-subagents absent). Warn —
        // silent fallback hid a dead provider binding for a whole session
        // (auto-detect latches its startup probe; incident-style debugging
        // cost). If this fires unexpectedly, check subagents.provider.
        logger.warn("[matrix] summarizer subagent unavailable — in-session directive fallback (check piMatrixSubagents.provider)");
        deps.injectDirective(
          buildThreadSummarizeDirective(root, delta, { limits: deps.limits, milestoneCandidates: root.milestones }),
          { kind: SUMMARIZE_DIRECTIVE_KIND },
        );
      }
    })().catch((error: unknown) => {
      logger.warn(`[matrix] thread summary run failed: ${error}`);
    });
  };
}
