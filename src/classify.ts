/**
 * Pi Matrix Integration — pure classification helpers (extracted from
 * index.ts, TO-BE restructure Slice 1).
 *
 * Module-level pure functions per the "constants → module, state → class"
 * rule: message → milestone/TODO extraction, Pi message text joining +
 * truncation, Matrix-id localpart, sub-agent name/role detection. No
 * state, no I/O.
 */

/** "@user:domain" → "user" (plain IDs pass through) */
export function localpartOf(sender: string): string {
  if (!sender.startsWith("@")) {
    return sender;
  }
  const colon = sender.indexOf(":");
  return colon > 0 ? sender.slice(1, colon) : sender.slice(1);
}

/** "@user:domain:port" → "domain:port" (the localpart never carries a
 *  colon, so the FIRST colon delimits; an id without a domain →
 *  undefined). The one shared domain extractor — the per-copy variants
 *  split on the LAST colon and mis-split ported homeservers. */
export function domainOf(id: string): string | undefined {
  const bare = id.startsWith("@") ? id.slice(1) : id;
  const colon = bare.indexOf(":");
  return colon > 0 ? bare.slice(colon + 1) : undefined;
}

// ===========================================================================
// Sub-agent detection (DESIGN §2.8 layer 1 — S4 event-based verdict)
// ===========================================================================

type SubagentTaskInput = { agent?: unknown; task?: unknown; cwd?: unknown };
type SubagentInput = {
  agent?: unknown;
  tasks?: SubagentTaskInput[];
  chain?: SubagentTaskInput[];
};

/**
 * Extract the sub-agent names from a `subagent` tool call. The shipped
 * extension's spawn tool takes one of three shapes (DESIGN S4): a single
 * `{ agent, task, cwd? }`, a parallel `{ tasks: [...] }` (≤8, 4
 * concurrent), or a chain `{ chain: [...] }` — one call spawns 1..N
 * sub-agents, each of which becomes a sub-thread under the active root.
 */
export function subagentNames(input: unknown): string[] {
  const names: string[] = [];
  const obj = (input ?? {}) as SubagentInput;
  if (typeof obj.agent === "string") names.push(obj.agent);
  for (const t of obj.tasks ?? []) if (typeof t?.agent === "string") names.push(t.agent);
  for (const c of obj.chain ?? []) if (typeof c?.agent === "string") names.push(c.agent);
  // De-dupe while preserving order (a parallel batch and a chain can repeat
  // an agent name).
  return [...new Set(names)];
}

/**
 * Role from the sub-agent name (DESIGN §1.6 / S4): explicit role if the
 * spawn payload had one, else a heuristic on the agent label, else
 * `unknown`. The agent name is the frontmatter `name` of
 * `~/.pi/agent/agents/*.md`.
 */
export function deriveRole(name: string): string {
  const m = name.match(/(tester|coder|reviewer|planner|designer|researcher|verifier)/i);
  return m ? m[1].toLowerCase() : "unknown";
}

/**
 * Extract a milestone statement from a message.
 *
 * Pi does not have a first-class "milestone" event — milestones are just
 * assistant text. Heuristic: look for explicit milestone markers in the
 * message text. Gated by `config.sendMilestones` (the extension only calls
 * this when the toggle is on).
 */
export function extractMilestone(
  message: { content?: Array<{ type: string; text?: string }>; details?: unknown }
): string | null {
  if (!message.content) {
    return null;
  }

  const text = message.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join(" ");

  // Look for milestone patterns, anchored to line start: a marker quoted
  // mid-line (inside table cells, backticks, running prose) must not fire.
  const patterns = [
    /^milestone[:\s]+(.+)$/im,
    /^✓\s*complete[:\s]+(.+)$/im,
    /^milestone reached[:\s]+(.+)$/im,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract a TODO progress statement from a message.
 */
export function extractTodoUpdate(
  message: { content?: Array<{ type: string; text?: string }>; details?: unknown }
): string | null {
  if (!message.content) {
    return null;
  }

  const text = message.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join(" ");

  // Look for TODO patterns, anchored to line start (see extractMilestone).
  const patterns = [
    /^todo progress[:\s]+(.+)$/im,
    /^todo[:\s]+(updated|complete|progress)[:\s]*(.+)$/im,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return (match[2] || match[1]).trim();
    }
  }

  return null;
}

// ===========================================================================
// Final-message broadcast (config.sendFinalMessages)
// ===========================================================================

/** Default cutoff when `config.maxFinalMessageLength` is unset. */
export const DEFAULT_FINAL_MESSAGE_MAX_LENGTH = 2000;

/** Join all text blocks of a message into a single readable string. */
export function messageText(
  message: { role?: string; content?: Array<{ type: string; text?: string }> }
): string | null {
  if (!message?.content) {
    return null;
  }
  const text = message.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n")
    .trim();
  return text || null;
}

/**
 * Truncate a final message so it stays readable on mobile clients.
 * The cutoff is `config.finalMessageMaxLength` (default 2000, item 5).
 * Exported for API parity with the pre-restructure index.ts.
 */
export function truncateFinalMessage(text: string, maxLength: number = DEFAULT_FINAL_MESSAGE_MAX_LENGTH): string {
  const limit = maxLength > 0 ? maxLength : DEFAULT_FINAL_MESSAGE_MAX_LENGTH;
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit).trimEnd()}… (truncated)`;
}

// ===========================================================================
// Summarizer completion-notice detection (INCIDENT-2026-10-22-SUMMARY-LOOP)
// ===========================================================================

/** The agent type the cadence spawns for thread summaries (the one source of
 *  truth: integration.ts hands it to the provider, this file matches it). */
export const SUMMARIZER_AGENT_TYPE = "pi-matrix-integration-thread-summarizer";

/** pi-subagents' completion notice customType (src/runs/background/notify.js). */
const SUBAGENT_NOTIFY_CUSTOM_TYPE = "subagent-notify";

/**
 * True when a run was started by a pi-subagents completion notice that
 * reports ONLY summarizer runs.
 *
 * Such a wake must not report out to the room: the report-out is a new
 * thread message, and a new thread message re-arms the summary cadence
 * (threading.ts `recordOnRoot` bumps `msgCount`, which is exactly what
 * `runSummary`'s guard compares against `lastSummaryAtMsg`). Muting it
 * starves the loop.
 *
 * Mixed notices (a summarizer plus real work in one grouped notice) are NOT
 * muted — that notice carries a report the user needs, and its cadence re-arm
 * dies on the next quiet turn anyway.
 *
 * ponytail: pi-subagents 0.80.0 has no spawn-time knob to suppress the parent
 * wake (`notify.js:776` defaults `triggerTurn` to true for async runs). The
 * upgrade path is an upstream `notify: false` spawn param, which would let
 * this guard go away.
 */
export function isSummarizerWakeNotice(
  message: unknown,
  agentType: string = SUMMARIZER_AGENT_TYPE,
): boolean {
  const notice = message as
    | { customType?: unknown; details?: { runs?: unknown } }
    | undefined;
  if (notice?.customType !== SUBAGENT_NOTIFY_CUSTOM_TYPE) return false;
  const runs = Array.isArray(notice.details?.runs) ? (notice.details!.runs as unknown[]) : null;
  if (!runs || runs.length === 0) return false;
  return runs.every(
    (run) => (run as { agent?: unknown } | undefined)?.agent === agentType,
  );
}

/** The extension's own in-session directive customType (session-integration.ts). */
const MATRIX_DIRECTIVE_CUSTOM_TYPE = "matrix-directive";

/** `details.kind` set by the thread-summary directive injections
 *  (summarize-dispatch.ts). Structured identity — never prose matching. */
export const SUMMARIZE_DIRECTIVE_KIND = "summarize";

/**
 * True when a run was started by the extension's own in-session
 * thread-summary directive (Engine A of INCIDENT-2026-10-22-SUMMARY-LOOP:
 * the subagent-unavailable fallback injects the directive into the main
 * session; its "Pass done" report-out is the message that re-armed the
 * cadence). Same mute contract as `isSummarizerWakeNotice`: the summary
 * itself lands through `matrix_update_thread_summary` (a root edit, not a
 * new thread message), only the confirmation echo is dropped.
 */
export function isSummarizeDirectiveNotice(message: unknown): boolean {
  const msg = message as { customType?: unknown; details?: { kind?: unknown } } | undefined;
  return msg?.customType === MATRIX_DIRECTIVE_CUSTOM_TYPE && msg?.details?.kind === SUMMARIZE_DIRECTIVE_KIND;
}
