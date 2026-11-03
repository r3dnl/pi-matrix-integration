/**
 * Pi Matrix Integration - Thread-summary prompts 
 *
 * Pure, network-free helpers for the room-sourced summarizer. The summary is a
 * pure function of the room artifact — the current root summary (baseline) plus
 * the delta of Matrix thread messages — so it survives /compact, /reload, and Pi
 * restarts. These helpers build that prompt; they never touch the network.
 *
 * Two consumers:
 *  - `buildThreadSummarizePrompt`      — the isolated `pi-matrix-integration-thread-summarizer` subagent's task.
 *  - `buildThreadSummarizeDirective`   — the in-session fallback (injected as a
 *    hidden user message; the agent answers via `matrix_update_thread_summary`).
 */

/**
 * The minimal shape of a room timeline event the summarizer needs. Structurally
 * compatible with `MatrixMessage` and the outbox `readTimeline`/`readMessages`
 * rows, so both sources feed the same pure filter.
 */
export interface ThreadDeltaMessage {
  eventId: string;
  sender: string;
  body?: string;
  formattedBody?: string;
  timestamp: number;
  // Thread metadata (threads-and-summaries.md): a reply in a thread carries `threadRoot`
  // (its root's event id); a thread root itself sets `isThreadRoot`.
  threadRoot?: string;
  isThreadRoot?: boolean;
}

/**
 * Select the thread delta: the messages that belong to `rootEventId`'s thread
 * (in-thread replies via `threadRoot`, plus the root itself), optionally
 * trimmed to "after the last summarized event" (`sinceEventId`), and capped to
 * the most recent `cap` (the list is oldest → newest, so the tail is newest).
 *
 * `sinceEventId` is the per-root event-id watermark (threads-and-summaries.md gap 3): when the
 * watermark event is still in the window, everything up to and including it is
 * dropped; when it has scrolled out of the window, the whole (capped) window is
 * kept — the baseline already covers the older history, so over-including a
 * little is harmless.
 */
export function filterThreadDelta(
  messages: readonly ThreadDeltaMessage[],
  rootEventId: string,
  cap = 40,
  sinceEventId?: string,
): ThreadDeltaMessage[] {
  const inThread = messages.filter(
    (m) => m.threadRoot === rootEventId || (m.isThreadRoot && m.eventId === rootEventId),
  );
  let delta = inThread;
  if (sinceEventId) {
    const idx = inThread.findIndex((m) => m.eventId === sinceEventId);
    if (idx >= 0) delta = inThread.slice(idx + 1);
  }
  return cap > 0 ? delta.slice(-cap) : delta;
}

/** One bullet per message: `sender: body`. */
export function formatDeltaMessages(delta: readonly ThreadDeltaMessage[]): string {
  if (delta.length === 0) return "(no new messages in the thread since the last summary)";
  return delta
    .map((m) => {
      const body = (m.body ?? m.formattedBody ?? "").trim() || "(non-text message)";
      return `- ${m.sender}: ${body}`;
    })
    .join("\n");
}

/**
 * Fir-tree size limits for the summary shape. The summary ages like a fir
 * tree: sparse durable milestones at the top, dense recent detail at the
 * bottom; the totals are capped so the root stays phone-readable.
 */
export interface SummaryLimits {
  /** Max lines in `## Milestones` (the evergreen, sparse top). */
  milestoneMax?: number;
  /** Max bullets in `## Recent activity` (the dense bottom). */
  recentMax?: number;
  /** Hard cap on the whole summary body, in lines. */
  maxLines?: number;
}

export const DEFAULT_SUMMARY_LIMITS: Required<SummaryLimits> = {
  milestoneMax: 8,
  recentMax: 5,
  maxLines: 25,
};

/** Fill every cap per-field: a caller may pass a partial (optional config). */
function resolveLimits(limits?: SummaryLimits): Required<SummaryLimits> {
  return {
    milestoneMax: limits?.milestoneMax ?? DEFAULT_SUMMARY_LIMITS.milestoneMax,
    recentMax: limits?.recentMax ?? DEFAULT_SUMMARY_LIMITS.recentMax,
    maxLines: limits?.maxLines ?? DEFAULT_SUMMARY_LIMITS.maxLines,
  };
}

export interface ThreadSummarizeInput {
  topic: string;
  lastSummary?: string;
  delta: readonly ThreadDeltaMessage[];
  /** Fir-tree caps (default DEFAULT_SUMMARY_LIMITS). */
  limits?: SummaryLimits;
  /**
   * Major-milestone candidates from the persisted work ledger
   * (`root.milestones`). An evergreen anchor: the LLM must keep each
   * represented in ## Milestones, so distant majors survive every rewrite
   * even if the summarizer's own condensing drifts.
   */
  milestoneCandidates?: readonly string[];
}

/** The output shape the summary must follow (shared by both runners). */
function summaryShape(l: SummaryLimits): string[] {
  return [
    "# Topic: {one-line topic}",
    "## Milestones",
    `- {major event} (oldest first, at most ${l.milestoneMax} lines)`,
    "## Recent activity",
    `- {point} — status: {completed | in progress | blocked} (newest last, max ${l.recentMax} points)`,
    "",
    "### latest:",
    "{where things stand right now}",
    "",
    "### next:",
    "{immediate next step}",
    "",
    "## Main decisions",
    "- {decision} (reason)  ·  an unsettled choice as `OPEN: {question}`",
  ];
}

/** The aging + hygiene rules (shared by both runners; rules, not shape). */
function summaryRules(l: SummaryLimits): string[] {
  return [
    "Fir-tree aging rules (sparse major events on top, dense recent detail below):",
    `- ## Milestones holds the durable major events, oldest first, at most ${l.milestoneMax} lines.`,
    "- When a ## Recent activity point stops mattering, fold its essence into ## Milestones.",
    `- If ## Milestones exceeds ${l.milestoneMax} lines, merge the two oldest into one line; drop a milestone only when clearly irrelevant.`,
    `- ## Recent activity keeps the newest ${l.recentMax} points in detail; older material moves up instead of piling up.`,
    "- Keep baseline points that are still true; update the ones the delta changed; drop obsolete ones. The delta is the newest material — fold it in.",
    "- Only include sections that have content. No timestamps, no \"as of\", no meta-commentary.",
    // A decision is something the user chose or the code proves. Recommendation
    // language in the conversation is not a choice: the scheduled runner turned
    // an option it was shown as "recommended" into a decision the user never made,
    // and the next run inherited it as fact.
    "- Record only decisions actually taken. A choice still being weighed goes as `OPEN: {question}` — never resolve it yourself, not even when the conversation recommends one.",
    "- If the baseline states a decision and the delta shows it was never taken (or was reversed), correct the line instead of repeating it.",
    `At most ${l.maxLines} lines total.`,
  ];
}

function milestoneCandidateLines(candidates: readonly string[] | undefined): string[] {
  if (!candidates || candidates.length === 0) return [];
  return [
    "",
    "Major-milestone candidates from the work ledger (keep each represented in ## Milestones):",
    ...candidates.map((m) => `- ${m}`),
  ];
}

/**
 * The isolated `pi-matrix-integration-thread-summarizer` subagent's task: baseline + delta → the new
 * summary body. Self-contained — the subagent has no other context, so the
 * topic, baseline, and the delta all travel in the prompt.
 */
export function buildThreadSummarizePrompt(input: ThreadSummarizeInput): string {
  const limits = resolveLimits(input.limits);
  const baseline =
    input.lastSummary?.trim() || "(none yet — the root is a bare '🧵 New Conversation' label)";
  return [
    "Rewrite the summary for this Matrix conversation thread.",
    "",
    `Topic: ${input.topic}`,
    "",
    "Baseline summary (covers the earlier part of the thread; keep the points that are still true, update or drop the obsolete ones):",
    baseline,
    "",
    "Newest thread messages (the delta to fold in):",
    formatDeltaMessages(input.delta),
    ...milestoneCandidateLines(input.milestoneCandidates),
    "",
    "Write the new summary body in markdown, plain simple English:",
    ...summaryShape(limits),
    "",
    ...summaryRules(limits),
    "Reply with ONLY the summary body — no preamble, no explanation.",
  ].join("\n");
}

/**
 * The in-session fallback directive (injected as a hidden user message; the
 * agent answers by calling `matrix_update_thread_summary`). Room-sourced like
 * the subagent prompt — when `delta` is supplied, it is the content source,
 * not the agent's own session memory.
 */
export function buildThreadSummarizeDirective(
  root: { topic: string; lastSummary?: string },
  delta: readonly ThreadDeltaMessage[] = [],
  opts: { limits?: SummaryLimits; milestoneCandidates?: readonly string[] } = {},
): string {
  const limits = resolveLimits(opts.limits);
  const baseline =
    root.lastSummary?.trim() || "(none yet — the root is a bare '🧵 New Conversation' label)";
  const lines: string[] = [
    "Run a Matrix thread-summary pass for this session now.",
    "",
    "Current root summary (baseline — keep points that are still true; update or remove obsolete ones):",
    baseline,
  ];
  if (delta.length > 0) {
    lines.push("", "Newest thread messages (the delta to fold in):", formatDeltaMessages(delta));
  }
  lines.push(
    ...milestoneCandidateLines(opts.milestoneCandidates),
    "",
    "Write the new root summary in markdown, plain simple English:",
    ...summaryShape(limits),
    "",
    ...summaryRules(limits),
    "Then call the tool `matrix_update_thread_summary` with that markdown body (no 🧵 line — the extension adds it).",
  );
  return lines.join("\n");
}
