/**
 * Pi Matrix Integration — pure classification helpers (extracted from
 * index.ts during the entry-point split).
 *
 * Module-level pure functions per the "constants → module, state → class"
 * rule: message → milestone/TODO extraction, Pi message text joining +
 * truncation, Matrix-id localpart, sub-agent name/role detection, the pi
 * broadcast prefixes behind the dedupe key and the sibling-session guard.
 * No state, no I/O.
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
// Sub-agent detection (threads-and-summaries.md layer 1 — review round 4 event-based verdict)
// ===========================================================================

type SubagentTaskInput = { agent?: unknown; task?: unknown; cwd?: unknown };
type SubagentInput = {
  agent?: unknown;
  tasks?: SubagentTaskInput[];
  chain?: SubagentTaskInput[];
};

/**
 * Extract the sub-agent names from a `subagent` tool call. The shipped
 * extension's spawn tool takes one of three shapes (review round 4): a single
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
 * Role from the sub-agent name (threads-and-summaries.md / review round 4): explicit role if the
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
export function extractTodoUpdate(message: object): string | null {
  // AgentMessage is a union (BashExecutionMessage carries no content at
  // all), so the fields are read through a guarded cast: only block arrays
  // carry the todo markers (a plain string has no .filter — the guard is
  // the type narrowing AND the runtime guard).
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter((c): c is { type: string; text: string } => {
      const b = c as { type?: unknown; text?: unknown };
      return b?.type === "text" && typeof b.text === "string" && b.text !== "";
    })
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
 * The cutoff is `config.finalMessageMaxLength` (default 2000).
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
// Summarizer completion-notice detection (the 2026-10 summary-loop incident)
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
 * wake (its async runs default `triggerTurn` to true). The
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

/** The relayed-room-message customType (session-integration.ts
 *  `injectMatrixMessage`). Exported so the summary-pass mute lift can
 *  recognise a room message as human input — swallowing a mid-pass room
 *  question is what the 2026-11 live incident did.
 *  Distinct from the directive/wake-notice types: matching this one can
 *  never self-unmute a pass. */
export const MATRIX_MESSAGE_CUSTOM_TYPE = "matrix-message";

/** `details.kind` set by the thread-summary directive injections
 *  (summarize-dispatch.ts). Structured identity — never prose matching. */
export const SUMMARIZE_DIRECTIVE_KIND = "summarize";

/**
 * True when a run was started by the extension's own in-session
 * thread-summary directive (Engine A of the 2026-10 summary-loop incident:
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

// ===========================================================================
// Pi broadcast prefixes (the dedupe key + the sibling-session guard)
// ===========================================================================

/** The icons pi writes into its outgoing prefixes. These values are the
 *  icon defaults in config-utils.ts `DEFAULT_CONFIG`. */
export const DEFAULT_OUTGOING_ICONS = { milestone: "🎯", user: "🧑", thread: "🧵" };

/** The icons a pi broadcast can open with, resolved. See `iconChoices`. */
export interface OutgoingIcons {
  milestoneIcon?: string;
  userMessageIcon?: string;
  threadIcon?: string;
}

/** Both spellings of one icon: the configured one plus the default. Two pi
 *  sessions sharing a room can be configured differently, and each one's
 *  broadcast has to be recognised by the other. */
function iconChoices(configured: string | undefined, fallback: string): string[] {
  return configured === undefined || configured === fallback ? [fallback] : [configured, fallback];
}

/** Every prefix a pi broadcast can open with, plus the bare marker words the
 *  heuristics strip ("Milestone: ", "TODO progress: "). Stripping them makes
 *  "🎯 Milestone: X" (sent at message_end) collide with the same line
 *  re-embedded in "💬 Pi: X" (the final broadcast) — the duplication pair this
 *  window exists for. MessageHandler.getMessagePrefix posts these strings, so
 *  they are built from the configured icons: a custom icon must not silently
 *  disarm the dedupe key or the guard. */
function outgoingPrefixes(icons: OutgoingIcons): string[] {
  const configurable: string[] = [];
  for (const icon of iconChoices(icons.milestoneIcon, DEFAULT_OUTGOING_ICONS.milestone)) {
    configurable.push(`${icon} Milestone: `);
  }
  for (const icon of iconChoices(icons.userMessageIcon, DEFAULT_OUTGOING_ICONS.user)) {
    configurable.push(`${icon} User: `);
  }
  return [
    ...configurable,
    "💬 Pi: ",
    "📋 TODO: ",
    "📊 Status: ",
    "❔ Question: ",
    "❌ Error: ",
    "🤖 Pi: ",
    "Milestone: ",
    "TODO progress: ",
  ];
}

/** Collapse whitespace and strip outgoing prefixes — the dedupe key. */
export function normalizeDedupeKey(text: string, icons: OutgoingIcons = {}): string {
  let key = text.replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of outgoingPrefixes(icons)) {
      if (key.startsWith(prefix)) {
        key = key.slice(prefix.length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return key;
}

/** The dedupe prefixes plus the thread root and decision-post markers. An
 *  INBOUND body opening with one of these is pi's own broadcast or a SIBLING
 *  pi session's (shared account: the sender match cannot tell them apart —
 *  everything surviving the send-record guards arrives isFromPi=false), and it
 *  must never become a prompt in this session. */
function machineTrafficPrefixes(icons: OutgoingIcons): string[] {
  const rootLabels = iconChoices(icons.threadIcon, DEFAULT_OUTGOING_ICONS.thread).map(
    (icon) => `${icon} New Conversation`,
  );
  return [
    ...outgoingPrefixes(icons),
    // The root label ThreadManager `postThreadRoot` posts, icon included.
    ...rootLabels,
    "🤖 Pi decision",
  ];
}

/** True when `body` opens with a pi machine-traffic prefix. */
export function isPiMachineTraffic(body: string, icons: OutgoingIcons = {}): boolean {
  const text = (body ?? "").trimStart();
  if (text.length === 0) return false;
  return machineTrafficPrefixes(icons).some((prefix) => text.startsWith(prefix));
}
