/**
 * Pi Matrix Integration - Message Handler
 *
 * Handles message processing between Pi and Matrix:
 * - Incoming: route Matrix messages to the session
 * - Outgoing: format and send Pi milestones / final / user lines to Matrix
 *
 * Decision questions have ONE path: the `ask_user_question` mirror (the RPIV
 * dual-surface bridge in `ask-user-mirror.ts`). The bespoke `matrix_request_decision`
 * tool and its decision-ID reply-correlation were removed as dead code.
 */

import type {
  MatrixMessage,
  PiMessage,
  PiMessageType,
  MatrixSendResult,
} from './types.js';
import type { OutboxResult, Outbox } from './outbox.js';
import type { ThreadManager, SendKind } from './threading.js';
import { convertMarkdown, htmlToMarkdown, looksLikeHtml, removeTableBlocks, stripHtmlTags } from './markdown.js';
import { createConsoleLogger, type MatrixLogger } from './logger.js';

/** Options for MessageHandler (small config object from the extension). */
export interface MessageHandlerOptions {
  /** Dedupe window for outgoing sends (ms). Default 600_000 (10 min). */
  dedupeWindowMs?: number;
  /** Convert outgoing markdown to HTML and send it as a formatted body. Default false. */
  sendFormatted?: boolean;
  /** Send detected table blocks in separate sends. Default false. */
  tablesInSeparateMessage?: boolean;
  /** Thread router: when it has an active thread,
   * outgoing traffic rides the thread delegate instead of the flat
   * `outbox.postMessage` path. Absent/flat → the plain outbox send. */
  threadManager?: ThreadManager;
  /** Outbox seam: the pipeline's write surface for
   *  thread-targeted posts + edits (`postInThread` / `editInThread`).
   *  Absent → thread writes soft-fail (`{ success: false }`, flat mode). */
  outbox?: Outbox;
  /** Where warnings/debug lines go; defaults to the console. */
  logger?: MatrixLogger;
  /** Icon for milestone messages. Default "🎯". */
  milestoneIcon?: string;
  /** Icon for user messages sent to Matrix. Default "🧑". */
  userMessageIcon?: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 600_000;

// Outgoing-type prefixes (see getMessagePrefix below) plus the bare marker
// words the heuristics strip ("Milestone: ", "TODO progress: "). Stripping
// them from the dedupe key makes "🎯 Milestone: X" (sent at message_end)
// collide with the same line re-embedded in "💬 Pi: …" (final broadcast),
// which is exactly the duplication pair the earlier feature fixes.
const DEDUPE_PREFIXES = [
  '🎯 Milestone: ',
  '💬 Pi: ',
  '🧑 User: ',
  '📋 TODO: ',
  '📊 Status: ',
  '❔ Question: ',
  '❌ Error: ',
  '🤖 Pi: ',
  'Milestone: ',
  'TODO progress: ',
];

/** Collapse whitespace and strip outgoing prefixes — the dedupe key. */
function normalizeDedupeKey(text: string): string {
  let key = text.replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of DEDUPE_PREFIXES) {
      if (key.startsWith(prefix)) {
        key = key.slice(prefix.length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return key;
}

/** Machine-traffic prefixes: the outgoing-type prefixes plus the thread
 *  root and decision-post markers (machine-generated, never typed). An
 *  INBOUND body starting with one is pi's own broadcast or a SIBLING pi
 *  session's (shared account: the sender match can't tell them apart —
 *  everything surviving the send-record guards is forced isFromPi=false),
 *  and it must never become a prompt in this session. */
const MACHINE_TRAFFIC_PREFIXES = [
  ...DEDUPE_PREFIXES,
  "🧵 New Conversation",
  "🤖 Pi decision",
];

/** True when `body` opens with a pi machine-traffic prefix. */
export function isPiMachineTraffic(body: string): boolean {
  const text = (body ?? "").trimStart();
  if (text.length === 0) return false;
  return MACHINE_TRAFFIC_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * Message handler for Pi-Matrix integration
 */
export class MessageHandler {
  // Normalized outgoing body → last-send time. Expired entries are
  // pruned lazily; cleared in cleanup().
  private recentSends: Map<string, number> = new Map();
  private dedupeWindowMs: number;
  private sendFormatted: boolean;
  private tablesInSeparateMessage: boolean;
  private threadManager?: ThreadManager;
  private outbox?: Outbox;
  private logger: MatrixLogger;
  private opts: MessageHandlerOptions;

  constructor(options: MessageHandlerOptions = {}) {
    this.opts = options;
    this.outbox = options.outbox;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.sendFormatted = options.sendFormatted ?? false;
    this.tablesInSeparateMessage = options.tablesInSeparateMessage ?? false;
    this.threadManager = options.threadManager;
    this.logger = options.logger ?? createConsoleLogger();
  }

  // ==========================================================================
  // Incoming Message Handling (Matrix → Pi)
  // ==========================================================================

  /**
   * Handle an incoming Matrix message.
   *
   * Returns the Pi message to inject into the session, or null when the
   * message was consumed (messages from Pi itself).
   */
  handleIncomingMessage(matrixMessage: MatrixMessage): PiMessage | null {
    // Skip messages from Pi itself
    if (matrixMessage.isFromPi) {
      return null;
    }

    return this.formatForPi(matrixMessage);
  }

  // ==========================================================================
  // Outgoing Message Handling (Pi → Matrix)
  // ==========================================================================

  /**
   * Handle outgoing Pi message — the single choke point for heuristic /
   * final / TODO sends. Decision re-issues route through the pipeline with
   * `post(text, "decision", { dedupe: false })` (a re-ask is intentional, so
   * it opts out of the content-key window explicitly).
   *
   * Threading (threads-and-summaries.md): when the session is pending, the first
   * outgoing user message creates the thread root and is posted into it
   * (ordering invariant: root first, then the reply). With an active
   * thread, traffic routes into it through the outbox; on any thread
   * failure the send falls back to the flat path.
   */
  async handleOutgoingMessage(piMessage: PiMessage): Promise<MatrixSendResult> {
    const kind: SendKind =
      piMessage.type === 'milestone' ? 'milestone' : piMessage.type === 'final' ? 'final' : piMessage.type === 'user' ? 'user' : 'other';

    // Format first (prefix + details), then the single outgoing pipeline
    // (format → dedupe → write; threads-and-summaries.md). `metadata.flat` skips thread
    // routing entirely (the /new session-start announcement: it announces
    // a NEW session, so it must not soft-attach into the previous session's
    // thread under `threadPendingRoute: "latest"`).
    return this.post(this.formatForMatrix(piMessage), kind, { flat: piMessage.metadata?.flat === true });
  }

  /**
   * The single outgoing pipeline: format → dedupe → write.
   * Every room write lands in this class. Consumer sends enter `post()`
   * (format → dedupe → route); consumers pass markdown (or a
   * pre-prefixed plain line), `kind` feeds the thread ledger, and
   * `dedupe: false` explicitly opts out of the content-key window
   * (decision re-issues — a
   * re-ask is intentional, so it must not be suppressed). Thread routing +
   * ledger happen in the ThreadManager; the actual outbox write comes back
   * through `postInThread` (the pipeline owns format + dedupe, the manager
   * owns route + ledger only). Writes the ThreadManager starts on its own —
   * the thread root, milestone lines, the summary edit — enter through
   * `postInThread` / `postThreadRoot` / `editInThread`, which format but do
   * not consult the dedupe window.
   */
  async post(
    text: string,
    kind: SendKind = "other",
    opts?: { dedupe?: boolean; flat?: boolean; html?: string },
  ): Promise<MatrixSendResult> {
    const dedupe = opts?.dedupe !== false;
    const flat = opts?.flat === true;
    const html = opts?.html;
    const now = Date.now();
    const key = normalizeDedupeKey(text);

    // Content-level dedupe: identical outgoing content within the window is
    // skipped (no send call). Logged, silent in the room. `dedupe: false`
    // skips both the check and the record.
    if (dedupe) {
      this.pruneRecentSends(now);
      const lastSent = this.recentSends.get(key);
      if (lastSent !== undefined && now - lastSent < this.dedupeWindowMs) {
        this.recentSends.set(key, now); // refresh the window on repeated near-sends
        this.logger.debug(
          `[matrix] deduped outgoing send (within ${this.dedupeWindowMs}ms window): ${key.slice(0, 60)}`,
        );
        return { eventId: "", success: true, deduped: true, timestamp: now };
      }
    }

    // Threading (threads-and-summaries.md): pending session + first user message
    // creates the thread root and posts into it (ordering invariant: root
    // first, then the reply); active threads route all traffic in-thread.
    // On any thread failure the send falls back to the flat path (threads-and-summaries.md —
    // never drop the message). transport-and-state.md: the manager computes route +
    // ledger and delegates the write back to this pipeline — html is no
    // longer pre-computed here, the write step formats.
    const tm = this.threadManager;
    if (flat) {
      // Explicit flat send (opts.flat): skip thread routing/ledger, write
      // straight to the room. Dedupe above still applies.
    } else if (tm?.enabled()) {
      // Thread creation trigger: pending session + first message of certain kinds
      // User messages and final messages both create the thread root (threads-and-summaries.md)
      const shouldCreateThread = tm.pending() && (kind === "user" || kind === "final");
      if (shouldCreateThread) {
        // For user messages, use the message text as topic; for final messages, no topic
        const topic = kind === "user" 
          ? text.replace(/^🧑\s*User:\s*/, "").replace(/\s+/g, " ").trim()
          : undefined;
        const root = await tm.ensureThreadRoot(topic);
        if (root) {
          const r = await tm.post(text, kind, undefined, html);
          if (r.success) {
            if (dedupe) this.recentSends.set(key, now);
            return r;
          }
          this.logger.warn(
            `[matrix] in-thread post failed (${r.error ?? "no active thread"}) — flat fallback: ${key.slice(0, 80)}`,
          );
        } else {
          this.logger.warn(
            `[matrix] thread root send failed (pending session) — flat fallback: ${key.slice(0, 80)}`,
          );
        }
        // root creation failed / flat mode → fall through to the flat send
      } else {
        const r = await tm.post(text, kind, undefined, html);
        if (r.success) {
          if (dedupe) this.recentSends.set(key, now);
          return r;
        }
        if (tm.pending()) {
          this.logger.debug(
            `[matrix] thread post skipped (${r.error ?? "no active thread"}, pending session) — flat fallback: ${key.slice(0, 80)}`,
          );
        } else {
          this.logger.warn(
            `[matrix] thread post failed (${r.error ?? "no active thread"}) — flat fallback: ${key.slice(0, 80)}`,
          );
        }
      }
    }

    // Flat send: the write leaves through `outboxSend`, the one
    // `outbox.postMessage` call in this class (transport-and-state.md; the
    // facade pair is deleted; the PI_MATRIX_TEST_OUTBOX seam stands in
    // for the SdkOutbox in the spawned suites).
    let result: MatrixSendResult;
    if (html) {
      // Caller-supplied formatted body (sub-agent color, transport-and-state.md
      // configuration-and-room-behaviour.md transport-and-state.md): ships as formatted_body with a tag-stripped
      // plain fallback, regardless of the sendFormatted gate.
      result = await this.outboxSend(stripHtmlTags(text), html);
    } else if (this.sendFormatted) {
      result = await this.sendFormattedMessage(text);
    } else {
      const r = await this.outbox!.postMessage(text);
      result = { success: r.success, eventId: r.eventId ?? "", error: r.error, timestamp: now };
    }
    this.logger.debug(
      `[matrix] flat send (${kind}, ${flat ? "explicit" : `threading ${tm?.enabled() ? "fallthrough" : "off"}`}): ${key.slice(0, 80)}`,
    );
    if (dedupe && result.success) {
      this.recentSends.set(key, now);
    }
    return result;
  }

  /**
   * Thread-targeted write step of the pipeline: the
   * ThreadManager's injected write delegate lands here. Format at write
   * time (caller-supplied `html` wins; otherwise the `sendFormatted` gate
   * converts markdown via markdown.ts — the single formatter), then the
   * outbox seam. No routing, no dedupe — those live in `post()`.
   * `rootId` undefined posts a thread root (a marker, never deduped);
   * `nestedRoot` marks sub-thread roots (threads-and-summaries.md emulated nesting).
   */
  async postInThread(
    text: string,
    rootId?: string,
    opts?: { nestedRoot?: boolean; html?: string },
  ): Promise<OutboxResult> {
    if (!this.outbox) return { success: false, error: "no outbox (thread writes need the Matrix transport)" };
    const { body, html } =
      opts?.html !== undefined ? { body: text, html: opts.html } : this.threadPayload(text);
    if (rootId === undefined) {
      return this.outbox.postThreadRoot(body, html);
    }
    return this.outbox.postThreadReply(body, rootId, opts?.nestedRoot, html);
  }

  /**
   * Root edit via `m.replace` (transport-and-state.md + always-html rule): the edit
   * path skips dedupe structurally — `post()` is never on this path, so a
   * re-edited summary is never "deduped". `html` wins over the pipeline's
   * conversion (markdown.ts is the single formatter); `threadRoot: true`
   * keeps the `m.thread` marker in the new content. The threads-and-summaries.md fallback
   * (rejected m.replace → a new in-thread summary message) stays in
   * ThreadManager.editSummary.
   */
  async editInThread(targetEventId: string, text: string, html?: string): Promise<OutboxResult> {
    if (!this.outbox) return { success: false, error: "no outbox" };
    const formatted = html ?? convertMarkdown(text).html;
    return this.outbox.editMessage(targetEventId, text, { threadRoot: true, html: formatted });
  }

  /**
   * Thread-path payload (mirrors `sendFormattedMessage` without the table
   * split — in a thread, tables stay inline in the html; the flat path
   * keeps its `tablesInSeparateMessage` behavior). Plain mode → `html`
   * undefined, the post carries a plain `body` only. The
   * pipeline's formatter step — postInThread converts at write time
   * instead of callers pre-computing.
   */
  private threadPayload(matrixText: string): { body: string; html?: string } {
    if (!this.sendFormatted) return { body: matrixText };
    if (looksLikeHtml(matrixText)) return { body: stripHtmlTags(matrixText), html: matrixText };
    return { body: matrixText, html: convertMarkdown(matrixText).html };
  }

  /**
   * Send a formatted (HTML) message. With `tablesInSeparateMessage`, table
   * blocks go out as their own sends; the surrounding text keeps its
   * own send with the tables removed. Plain `body` always stays available
   * as the fallback for non-HTML clients.
   */
  private async sendFormattedMessage(matrixText: string): Promise<MatrixSendResult> {
    // Raw-HTML passthrough: content that is already HTML ships verbatim as
    // formatted_body (no markdown conversion, no escaping) with a
    // tag-stripped body fallback. Tolerates the "label: " message prefix.
    if (looksLikeHtml(matrixText)) {
      return this.outboxSend(stripHtmlTags(matrixText), matrixText);
    }

    const conversion = convertMarkdown(matrixText);
    if (!this.tablesInSeparateMessage || conversion.tables.length === 0) {
      return this.outboxSend(matrixText, conversion.html);
    }

    const results: MatrixSendResult[] = [];
    const mainText = removeTableBlocks(matrixText, conversion.tables);
    if (mainText.trim() !== '') {
      results.push(await this.outboxSend(mainText, conversion.htmlWithoutTables));
    }
    for (const table of conversion.tables) {
      results.push(await this.outboxSend(table.source, table.html));
    }

    const failed = results.find((r) => !r.success);
    if (failed) {
      return failed;
    }
    return results[results.length - 1];
  }

  /** Drop dedupe entries that fell out of the window. */
  private pruneRecentSends(now: number): void {
    for (const [key, sentAt] of this.recentSends) {
      if (now - sentAt >= this.dedupeWindowMs) {
        this.recentSends.delete(key);
      }
    }
  }

  /**
   * Send milestone to Matrix
   */
  async sendMilestone(milestone: string, details?: Record<string, unknown>): Promise<MatrixSendResult> {
    const piMessage: PiMessage = {
      type: 'milestone',
      content: milestone,
      metadata: details,
      timestamp: Date.now(),
    };

    return this.handleOutgoingMessage(piMessage);
  }

  /**
   * Broadcast a turn's final assistant message to Matrix (opt-in via
   * `sendFinalMessages`). Distinct from milestones: no marker matching, just
   * the last thing the user saw in the terminal for this turn.
   */
  async sendFinalMessage(text: string): Promise<MatrixSendResult> {
    const piMessage: PiMessage = {
      type: 'final',
      content: text,
      timestamp: Date.now(),
    };

    return this.handleOutgoingMessage(piMessage);
  }

  /**
   * Send a "User says:" line to Matrix — the user's own terminal-typed
   * prompt, so a phone-only user sees what they asked for (or what a
   * colleague at the terminal asked). Distinct from `final` (the assistant's
   * answer) and `milestone` (heuristic markers): this is the user's voice.
   */
  async sendUserMessage(text: string): Promise<MatrixSendResult> {
    const piMessage: PiMessage = {
      type: 'user',
      content: text,
      timestamp: Date.now(),
    };

    return this.handleOutgoingMessage(piMessage);
  }

  // ==========================================================================
  // Message Formatting
  // ==========================================================================

  /**
   * Format Matrix message for Pi session
   */
  formatForPi(matrixMessage: MatrixMessage): PiMessage {
    const senderName = this.extractSenderName(matrixMessage.sender);
    // The room speaks HTML (formatted_body); the session speaks markdown.
    // Render HTML back so the injection is native to the Pi terminal and
    // cheaper in tokens. Plain bodies (no tags) pass through untouched.
    const raw = matrixMessage.formattedBody || matrixMessage.body;
    const content = looksLikeHtml(raw) ? htmlToMarkdown(raw) : raw;

    return {
      type: 'response',
      content,
      metadata: {
        matrix: {
          eventId: matrixMessage.eventId,
          sender: matrixMessage.sender,
          senderName,
          roomId: matrixMessage.roomId,
          timestamp: matrixMessage.timestamp,
        },
      },
      timestamp: matrixMessage.timestamp,
    };
  }

  /**
   * Format Pi message for Matrix
   */
  formatForMatrix(piMessage: PiMessage): string {
    const prefix = this.getMessagePrefix(piMessage.type);
    const content = piMessage.content;

    // Add details if present
    let metadataText = '';
    if (piMessage.metadata) {
      const metadata = piMessage.metadata as Record<string, unknown>;
      if (metadata.details) {
        metadataText = `\n\nDetails: ${JSON.stringify(metadata.details, null, 2)}`;
      }
    }

    return `${prefix}${content}${metadataText}`;
  }

  /**
   * Get message prefix based on type
   */
  private getMessagePrefix(type: PiMessageType): string {
    switch (type) {
      case 'milestone':
        return `${this.opts.milestoneIcon ?? '🎯'} Milestone: `;
      case 'question':
        return '❔ Question: ';
      case 'status':
        return '📊 Status: ';
      case 'todo':
        return '📋 TODO: ';
      case 'error':
        return '❌ Error: ';
      case 'final':
        return '💬 Pi: ';
      case 'user':
        return `${this.opts.userMessageIcon ?? '🧑'} User: `;
      default:
        return '🤖 Pi: ';
    }
  }

  /**
   * Extract sender name from Matrix ID
   */
  private extractSenderName(sender: string): string {
    // Remove @ and :domain from Matrix ID
    if (sender.startsWith('@')) {
      const parts = sender.split(':');
      if (parts.length > 0) {
        return parts[0].substring(1); // Remove @
      }
    }
    return sender;
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Cleanup resources: clear the dedupe bookkeeping.
   */
  cleanup(): void {
    this.recentSends.clear();
  }

  /**
   * The single outbox write call (the flat + formatted paths): the outbox's
   * `postMessage(body, html)` result normalized to the MatrixSendResult
   * shape the dedupe bookkeeping + callers expect. Absent outbox (unit
   * test sites without a seam) → soft-fail, no write.
   */
  private async outboxSend(body: string, html?: string): Promise<MatrixSendResult> {
    if (!this.outbox) return { success: false, error: "no outbox", timestamp: Date.now() };
    const res = await this.outbox.postMessage(body, html);
    return { success: res.success, eventId: res.eventId ?? "", error: res.error, timestamp: Date.now() };
  }
}

/**
 * Create message handler (the outbox is the single write surface —
 * inject it via `options.outbox`; the PI_MATRIX_TEST_OUTBOX seam stands
 * in for the SdkOutbox in the spawned suites).
 */
export function createMessageHandler(
  options?: MessageHandlerOptions,
): MessageHandler {
  return new MessageHandler(options);
}
