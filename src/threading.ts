/**
 * Pi Matrix Integration - Thread Manager
 *
 * threads-and-summaries.md: the session→thread lifecycle.
 *
 * Lazy creation: a `new` session is merely *pending* — no Matrix
 * traffic until the first user message, which posts the thread root FIRST
 * (ordering invariant threads-and-summaries.md) and only then posts the user's message as an
 * in-thread reply. All later outgoing traffic routes into the active
 * thread via the Outbox seam (`src/outbox.ts`).
 *
 * State persists in `state/thread-map.json` (gitignored, extension-local),
 * keyed per room so `/matrix-switch` preserves each room's threads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MatrixHttpResult } from "./outbox.js";
import type { MatrixLogger } from "./logger.js";
import { createConsoleLogger } from "./logger.js";
import { filterThreadDelta, type ThreadDeltaMessage } from "./summarize.js";

export interface ThreadSubThread {
  eventId: string;
  name: string;
  role: string;
}

export interface ThreadRootState {
  eventId: string;
  topic: string;
  msgCount: number;
  lastMilestone?: string;
  /** Most recent milestone payloads (newest last, capped at 5). */
  milestones: string[];
  /** Last LLM-authored summary markdown (the baseline for the next run). */
  lastSummary?: string;
  /** Ledger msgCount of the last completed LLM summary run. */
  lastSummaryAtMsg?: number;
  /** Ledger msgCount at which the last LLM run was requested. */
  summaryRequestedAtMsg?: number;
  /**
   * Outgoing posts since the last completed summary that are bookkeeping
   * rather than content (a wake-answer final, see `suppressOnFinalOnce`). A
   * pass whose whole delta is such posts re-summarises its own output — a
   * no-op that still costs an LLM run plus a parent wake
   * (BUG-SUMMARIZER-ONFINAL-LOOP B).
   */
  bookkeepingSinceSummary?: number;
  /**
   * Per-root event-id watermark: the eventId of the newest thread message
   * folded into the last LLM summary (threads-and-summaries.md gap 3). The
   * delta is by event, not by ledger `msgCount` (the ledger counts outgoing
   * sends only; the room also carries the user's own phone messages).
   */
  lastSummarizedEventId?: string;
  openDecisions: number;
  lastActivity: number;
  subThreads: ThreadSubThread[];
}

interface ThreadMapEntry {
  roots: ThreadRootState[];
  /** sessionHint (a stable session id) → root event id, for re-attach. */
  sessions: Record<string, string>;
}

/** Persisted shape: roomKey → entry. */
export type ThreadMapState = Record<string, ThreadMapEntry>;

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * The thread-write surface the composition root injects :
 * ThreadManager computes route + ledger and delegates the actual writes
 * to the MessageHandler pipeline (format + dedupe live there; markdown.ts
 * is the single formatter). The manager holds no transport reference —
 * writes soft-fail (`{ success: false }`) when the delegate is absent.
 * Structurally a subset of the Outbox seam; the production delegate routes
 * `postThread*`/`editMessage` through the handler, and `setRoomTopic` /
 * `readTimeline` straight at the seam.
 */
export interface ThreadSend {
  postThreadRoot(body: string, html?: string): Promise<MatrixHttpResult>;
  postThreadReply(body: string, rootId: string, nestedRoot?: boolean, html?: string): Promise<MatrixHttpResult>;
  editMessage(targetEventId: string, text: string, opts?: { threadRoot?: boolean; html?: string }): Promise<MatrixHttpResult>;
  setRoomTopic(topic: string): Promise<MatrixHttpResult>;
  readTimeline(limit?: number): Promise<{ success: boolean; messages: ThreadDeltaMessage[]; error?: string }>;
}

export interface ThreadManagerOptions {
  /** `config.threads` master gate. */
  enabled: boolean;
  /** Room-key for the state map (e.g. `#pi-updates:domain` or env-qualified). */
  roomKey: string;
  /**
   * Thread-write delegate (threads-and-summaries.md: routing + ledger only — no
   * transport reference in the manager; the composition root wires this
   * to the MessageHandler pipeline). Absent → all thread writes
   * soft-fail (threads-and-summaries.md degradation).
   */
  threadSend?: ThreadSend;
  /** `state/thread-map.json` path; undefined disables persistence. */
  statePath?: string;
  /** Short stable session label (e.g. session id) for re-attach on resume/fork. */
  sessionHint?: string;
  threadIcon?: string;
  threadSummaryEvery?: number;
  /**
   * Fibonacci-capped summary cadence: the
   * trigger interval starts 1, 1, 2, 3, 5, 8… and caps at
   * `threadSummaryEvery` (whichever is lower). Default **on**;
   * `false` restores the fixed modulo cadence.
   */
  threadSummaryFib?: boolean;
  /**
   * Report-out trigger (default **on**): a `"final"` post — the turn's
   * report-out to the user (the `sendFinalMessages` turn_end broadcast)
   * — runs a summary pass right after it lands. No-op-ish in LLM mode
   * when nothing new since the last completed run.
   */
  threadSummaryOnFinal?: boolean;
  /** LLM-driven summarization runs (agent rewrites the root summary). */
  threadSummaryByLlm?: boolean;
  /** Max thread messages kept in the summarizer prompt delta. Default 40. */
  threadSummarizeLimit?: number;
  /**
   * Hard cap on the posted summary body, in lines (fir-tree size limit).
   * 0/undefined = no cap. Enforcement is a line-boundary truncate + warn;
   * the prompt carries the same cap as its primary control.
   */
  threadSummaryMaxLines?: number;
  /** Firing the agent into a summarization run (threads-and-summaries.md). */
  onSummarizeRequest?: (root: ThreadRootState) => void | Promise<void>;
  roomTopicUpdates?: boolean;
  subThreads?: boolean;
  rolePrefixes?: boolean;
  /**
   * Where non-user sends from a PENDING session (no root yet) go — threads-and-summaries.md
   * extension. "flat" (default) keeps today's behavior: they fall through
   * to the flat main-conversation send. "latest" soft-attaches them to the
   * most recent root (the session stays pending, so the first user message
   * still opens a NEW root). Fixes headless / sub-agent sessions, which
   * never deliver a user message and would otherwise stay flat forever.
   */
  pendingRoute?: "flat" | "latest";
  logger?: MatrixLogger;
}

/** Result of a routed thread send (matches the MatrixSendResult shape callers use). */
export interface ThreadSendResult {
  eventId: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

/** A kind of outgoing message, used to update the root ledger . */
export type SendKind = "milestone" | "final" | "user" | "decision" | "other";

/**
 * Thread lifecycle + routing + summarizer + state persistence.
 *
 * One instance per room. `canRoute()` is the choke point: false → callers
 * fall back to the flat `mtx` send path, so threading is always a
 * non-blocking enhancement.
 */
/**
 * Summary-cadence gate . Fixed mode: the
 * original modulo check. Fibonacci mode (default): the trigger points are
 * absolute per root — intervals 1, 1, 2, 3, 5, 8, 13… capped at `cap`
 * (whichever is lower) — so a busy thread settles onto the
 * `threadSummaryEvery` cadence; `cap` of 1 degenerates to every-message
 * either way. Stateless — the points are a pure function of the message
 * count (persisted per root), so a resumed session recomputes the same
 * schedule. Each point triggers on the send that reaches it — the gate
 * runs on every in-thread send, so no point is skipped.
 */
export function summaryDue(msgCount: number, cap: number, useFib: boolean): boolean {
  if (!useFib) return msgCount % cap === 0;
  let a = 1;
  let b = 1;
  let next = 0;
  for (;;) {
    const point = next + Math.min(a, cap);
    if (point >= msgCount) return point === msgCount;
    next = point;
    const t = a + b;
    a = b;
    b = t;
  }
}

export class ThreadManager {
  private opts: Required<Pick<ThreadManagerOptions, "enabled" | "roomKey">> & ThreadManagerOptions;
  private threadSend?: ThreadSend;
  private state: ThreadMapState;
  private entry: ThreadMapEntry;
  /** The root the active session is routing to, or undefined (pending/flat). */
  private activeRootId: string | undefined;
  private sessionState: "pending" | "active" | "flat" = "flat";
  private logger: MatrixLogger;
  /** Set once when the matrix-http transport fails; stops repeat logging . */
  private flatModeLogged = false;
  private topicWarnLogged = false;
  /**
   * Single-flight guard: cadence points can
   * be one message apart while a run takes seconds — a second dispatch would
   * spawn a 2nd subagent over the same (stale-baseline) delta and double-edit
   * the root. Set when a run is dispatched, cleared when its promise settles.
   */
  private summaryInFlight = false;
  /**
   * One-shot: the next `"final"` post answers a summarizer wake absorbed into
   * the live run (lifecycle sets it right before that broadcast). It is
   * bookkeeping, not new thread content, so it must not re-arm the report-out
   * trigger (BUG-SUMMARIZER-ONFINAL-LOOP A). Consumed by the post, cleared by
   * the lifecycle at the next run start.
   */
  private suppressOnFinalOnce = false;

  constructor(opts: ThreadManagerOptions) {
    this.opts = opts;
    this.threadSend = opts.threadSend;
    this.logger = opts.logger ?? createConsoleLogger();
    this.state = this.load();
    this.entry = this.state[opts.roomKey] ?? { roots: [], sessions: {} };
    this.state[opts.roomKey] = this.entry;
  }

  // ==========================================================================
  // Session lifecycle 
  // ==========================================================================

  /**
   * `session_start` hook. `new` and `startup` (a fresh Pi session from the
   * terminal) → pending: no traffic yet, the "Pi session started" milestone
   * lands flat in the room, and the first user message opens a new thread
   * root. `resume`/`fork` re-attach from the state map when the
   * sessionHint is known; otherwise they behave as `new`. `reload` keeps the
   * same session, so it re-attaches to the root mapped to this session id —
   * never to another session's root (a `/new` then `/reload` must open a
   * fresh thread on the first message). Falls back to the latest root only
   * when the session id is unknown.
   */
  beginSession(reason: SessionStartReason, sessionHint?: string): void {
    if (sessionHint !== undefined) this.opts.sessionHint = sessionHint;
    const hint = this.opts.sessionHint;

    if (reason === "new" || reason === "startup") {
      this.activeRootId = undefined;
      this.sessionState = "pending";
    } else if (reason === "resume" || reason === "fork") {
      const rootId = hint ? this.entry.sessions[hint] : undefined;
      if (rootId && this.entry.roots.some((r) => r.eventId === rootId)) {
        this.activeRootId = rootId;
        this.sessionState = "active";
      } else {
        this.activeRootId = undefined;
        this.sessionState = "pending";
      }
    } else {
      // reload: same session → re-attach to THIS session's mapped root.
      // A known hint with no mapping means the session has not opened a
      // thread yet (`/new` then `/reload`): the latest root belongs to the
      // previous session, and attaching to it hijacks that older thread
      // instead of opening a fresh one — so stay pending and let the first
      // message create a new root. Only when the session id is unknown can
      // the latest root be ours.
      const mapped = hint ? this.entry.sessions[hint] : undefined;
      const latest = this.latestRoot();
      if (mapped && this.entry.roots.some((r) => r.eventId === mapped)) {
        this.activeRootId = mapped;
        this.sessionState = "active";
      } else if (!hint && latest) {
        this.activeRootId = latest.eventId;
        this.sessionState = "active";
      } else {
        this.activeRootId = undefined;
        this.sessionState = "pending";
      }
    }
    this.traceSession(reason);
  }

  /** One-line session-transition trace (diagnosis: who reset the session to pending?). */
  private traceSession(reason: SessionStartReason): void {
    this.logger.debug(
      `[matrix] session ${reason} → ${this.sessionState}${this.activeRootId ? ` · root ${this.activeRootId}` : ""}`,
    );
  }

  pending(): boolean {
    return this.sessionState === "pending";
  }

  enabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * Runtime toggle for the master gate (`/matrix-thread-toggle`). Off →
   * `canRoute()` is false and every send falls back to the flat path; the
   * session/root tracking is kept, so re-enabling resumes routing to the
   * same thread root. No state on disk is touched.
   */
  setEnabled(enabled: boolean): void {
    if (this.opts.enabled === enabled) return;
    this.opts.enabled = enabled;
    this.logger.debug(`[matrix] threading ${enabled ? "enabled" : "disabled"} (runtime toggle)`);
  }

  /** The configured thread icon (default 🧵) — used by the footer indicator. */
  threadIcon(): string {
    return this.opts.threadIcon ?? "🧵";
  }

  // ==========================================================================
  // Thread root + routing
  // ==========================================================================

  private root(id: string | undefined): ThreadRootState | undefined {
    if (!id) return undefined;
    return this.entry.roots.find((r) => r.eventId === id);
  }

  activeRoot(): ThreadRootState | undefined {
    return this.root(this.activeRootId);
  }

  /** True when outgoing traffic should route into the active thread.
   *  transport-and-state.md: one transport, all ops soft-fail — no transport-presence
   *  gate; routing degrades to the flat path. */
  canRoute(): boolean {
    return this.opts.enabled && this.activeRoot() !== undefined;
  }

  /**
   * Post the thread root (`🧵 New Conversation[: topic]`), record it, and
   * switch the session to routing into it. Idempotent: a second call in the
   * same session returns the existing root without another `mtx`/matrix-http call.
   * Returns undefined in flat mode (no thread-write delegate) or on failure — the caller then
   * falls back to a flat send.
   */
  async ensureThreadRoot(topic?: string): Promise<ThreadRootState | undefined> {
    if (!this.opts.enabled || !this.threadSend) return undefined;
    if (this.activeRoot()) return this.activeRoot();

    const icon = this.opts.threadIcon ?? "🧵";
    // No topic yet → bare label (no "New Conversation: New Conversation");
    // the summarizer fills in the topic line as the conversation develops.
    const res = await this.threadSend.postThreadRoot(topic ? `${icon} New Conversation: ${topic}` : `${icon} New Conversation`);
    if (!res.success || !res.eventId) {
      this.warnFlat(`thread root send failed: ${res.error ?? "no event id"}`);
      this.sessionState = "flat";
      return undefined;
    }
    const now = Date.now();
    const root: ThreadRootState = {
      eventId: res.eventId,
      topic: topic ?? "New Conversation",
      msgCount: 0,
      openDecisions: 0,
      lastActivity: now,
      milestones: [],
      subThreads: [],
    };
    this.entry.roots.push(root);
    if (this.opts.sessionHint !== undefined) {
      this.entry.sessions[this.opts.sessionHint] = res.eventId;
    }
    this.activeRootId = res.eventId;
    this.sessionState = "active";
    this.save();
    this.logger.debug(`[matrix] thread root created ${res.eventId} (topic: ${topic ?? "New Conversation"})`);
    return this.activeRoot();
  }

  /** The most recently active root (by ledger `lastActivity`), or undefined. */
  private latestRoot(): ThreadRootState | undefined {
    const roots = this.entry.roots;
    return roots.length ? roots.reduce((a, b) => (a.lastActivity >= b.lastActivity ? a : b)) : undefined;
  }

  /**
   * Route an outgoing message into the active thread (or a sub-thread).
   * Updates the root ledger and triggers the summarizer at the configured
   * cadence. Returns a MatrixSendResult-shaped object; `success: false`
   * means the caller should fall back to a flat send.
   */
  async post(text: string, kind: SendKind = "other", subThreadName?: string, html?: string): Promise<ThreadSendResult> {
    if (!this.enabled() || !this.threadSend) {
      return { eventId: "", success: false, error: "no active thread", timestamp: Date.now() };
    }
    let root = this.activeRoot();
    let softAttached = false;
    if (!root && this.sessionState === "pending" && kind !== "user" && this.opts.pendingRoute === "latest") {
      // Soft-attach (threads-and-summaries.md extension, `threadPendingRoute: "latest"`): a
      // pending session (no root yet) borrows the most recent root for
      // non-user sends — session-start milestones and work milestones of
      // headless / sub-agent sessions land in the thread instead of the
      // flat main conversation. The session stays PENDING, so the first
      // user message still opens a new root. The default ("flat") skips
      // this branch and the caller falls back to a flat send.
      root = this.latestRoot();
      softAttached = root !== undefined;
    }
    if (!root) {
      this.logger.debug(
        `[matrix] thread post ${kind} dropped (no active thread, state: ${this.sessionState})`,
      );
      return { eventId: "", success: false, error: "no active thread", timestamp: Date.now() };
    }

    // Sub-thread routing: reply to the sub-thread's nested root, but the
    // *ledger* and summary still live on the parent root (threads-and-summaries.md counts from
    // the local send ledger, not thread reads).
    let targetRootId = root.eventId;
    if (subThreadName) {
      const sub = root.subThreads.find((s) => s.name === subThreadName);
      if (!sub) {
        return { eventId: "", success: false, error: `unknown sub-thread "${subThreadName}"`, timestamp: Date.now() };
      }
      targetRootId = sub.eventId; // a plain in-thread reply into the sub-thread
    }

    // The pipeline write step: route + sub-thread target
    // computed above; the actual outbox call + markdown conversion happen
    // in the MessageHandler's injected delegate.
    const res: MatrixHttpResult = await this.threadSend.postThreadReply(text, targetRootId, false, html);

    if (!res.success) {
      this.warnFlat(`in-thread reply failed: ${res.error ?? "no event id"}`);
      return { eventId: "", success: false, error: res.error, timestamp: Date.now() };
    }

    this.recordOnRoot(root, kind, text);
    // A wake-answer final (lifecycle set `suppressOnFinalOnce` before this
    // broadcast) is booked as non-content and never re-arms: the answer
    // ships, the summary pass does not. Classified before the cadence gate so
    // a pass triggered on this same message sees it as bookkeeping (B). The
    // flag is consumed by ANY final post, cadence or not, so it cannot leak
    // into the next turn.
    const wakeAnswer = kind === "final" && this.suppressOnFinalOnce;
    if (wakeAnswer) {
      this.suppressOnFinalOnce = false;
      root.bookkeepingSinceSummary = (root.bookkeepingSinceSummary ?? 0) + 1;
      this.save();
      this.logger.warn("[matrix] on-final summary trigger suppressed (wake-answer final)");
    }
    const cadenceRan = await this.maybeSummarize(root);
    // Report-out trigger: a `"final"` post is the turn's report-out to the
    // user — summarize right after it lands (gated; default on). Skipped
    // when the cadence just ran on this same message (no double edit).
    if (!wakeAnswer && kind === "final" && this.opts.threadSummaryOnFinal !== false && !cadenceRan) {
      // LLM mode: skip when a run is already queued — its room-sourced
      // delta read lands after this send, so it covers the report-out;
      // no duplicate request. Heuristic mode re-posts the ledger line so
      // the root reflects the just-finished turn.
      const dedupe = this.opts.threadSummaryByLlm && root.summaryRequestedAtMsg !== undefined;
      if (!dedupe) await this.runSummary(root);
    }
    this.logger.debug(
      `[matrix] thread post ${kind} → ${targetRootId}${softAttached ? " [soft-attach latest]" : ""}`,
    );
    return { eventId: res.eventId ?? "", success: true, timestamp: Date.now() };
  }

  /** Post a sub-thread root under the parent root (threads-and-summaries.md emulated nesting). */
  async spawnSubThread(name: string, role: string): Promise<ThreadSubThread | undefined> {
    if (!this.opts.subThreads || !this.canRoute() || !this.threadSend) return undefined;
    const root = this.activeRoot()!;
    if (root.subThreads.some((s) => s.name === name)) return root.subThreads.find((s) => s.name === name);

    const icon = this.opts.threadIcon ?? "🧵";
    const prefix = this.opts.rolePrefixes !== false ? `🤖 sub-agent-${role}: ` : "";
    const label = `${icon} Sub-agent: ${name} (${role})`;
    const res = await this.threadSend.postThreadReply(`${prefix}${label} started`, root.eventId, true);
    if (!res.success || !res.eventId) {
      this.warnFlat(`sub-thread root send failed: ${res.error ?? "no event id"}`);
      return undefined;
    }
    const sub: ThreadSubThread = { eventId: res.eventId, name, role };
    root.subThreads.push(sub);
    root.lastActivity = Date.now();
    this.save();
    return sub;
  }

  /** Post a completion marker into a sub-thread (the spawn tool's result). */
  async completeSubThread(name: string, ok: boolean, role: string): Promise<ThreadSubThread | undefined> {
    if (!this.opts.subThreads || !this.threadSend) return undefined;
    const root = this.activeRoot();
    if (!root) return undefined;
    const sub = root.subThreads.find((s) => s.name === name);
    if (!sub) return undefined;
    const icon = this.opts.threadIcon ?? "🧵";
    const prefix = this.opts.rolePrefixes !== false ? `🤖 sub-agent-${role}: ` : "";
    const label = `${icon} Sub-agent: ${name} finished (${ok ? "ok" : "error"}) (${role})`;
    const res = await this.threadSend.postThreadReply(`${prefix}${label}`, sub.eventId, false);
    if (!res.success) {
      this.warnFlat(`sub-thread completion marker failed: ${res.error ?? "no event id"}`);
    }
    return sub;
  }

  /**
   * Cross-instance sync: the main session and the summarizer
   * subagent each hold their own in-memory ThreadManager; the state file
   * is the only thing they share (last-writer-wins). Before a summary run
   * (or a room delta read) copy the persisted summary fields back into the
   * live root, so the baseline (`lastSummary`), its ledger position, and
   * the event watermark aren't stale relative to a summary another
   * instance already posted. Field copy only — the live root's object
   * identity is preserved (dispatchers and callers hold references).
   */
  private refreshFromDisk(): void {
    if (!this.opts.statePath || !this.activeRootId) return;
    const disk = this.load()[this.opts.roomKey]?.roots.find((r) => r.eventId === this.activeRootId);
    const mem = this.root(this.activeRootId);
    if (!disk || !mem) return;
    mem.lastSummary = disk.lastSummary;
    mem.lastSummaryAtMsg = disk.lastSummaryAtMsg;
    mem.lastSummarizedEventId = disk.lastSummarizedEventId;
  }

  // ==========================================================================
  // Ledger + summarizer 
  // ==========================================================================

  private recordOnRoot(root: ThreadRootState, kind: SendKind, body: string): void {
    root.msgCount += 1;
    root.lastActivity = Date.now();
    if (kind === "milestone") {
      // Strip the `🎯 Milestone: ` marker so the ledger holds the payload.
      const m = this.stripMarker(body);
      root.lastMilestone = m;
      // Keep the recent highlights (deduped, capped, truncated).
      if (m && root.milestones[root.milestones.length - 1] !== m) {
        root.milestones = [...root.milestones, m.slice(0, 80)].slice(-5);
      }
    }
    if (kind === "decision") root.openDecisions += 1;
    this.save();
  }

  /** A decision was answered (or timed out) → close it in the ledger. */
  noteDecisionClosed(): void {
    const root = this.activeRoot();
    if (!root) return;
    root.openDecisions = Math.max(0, root.openDecisions - 1);
    this.save();
  }

  /** Skip the on-final summary trigger for the next `"final"` post (see
   *  `suppressOnFinalOnce`). */
  suppressNextOnFinalTrigger(): void {
    this.suppressOnFinalOnce = true;
  }

  /** Drop an unconsumed suppression (a run started → the previous run's
   *  bookkeeping is done). */
  clearOnFinalSuppression(): void {
    this.suppressOnFinalOnce = false;
  }

  private stripMarker(body: string | undefined): string | undefined {
    if (!body) return body;
    return body.replace(/^🎯\s*Milestone:\s*/, "").trim() || body;
  }

  /**
   * Read the active thread's delta (threads-and-summaries.md gaps 1–3): the
   * newest thread messages the Outbox-seam timeline read returns, filtered to this
   * root, capped to `threadSummarizeLimit`, and trimmed to after
   * `lastSummarizedEventId`. The room is the source of truth — the Pi session
   * only triggers/hosts the run. No delegate / an empty read → `[]`
   * (the caller may fall back to the `mtx` read, or run on the baseline alone).
   */
  async readThreadDelta(limit = 100): Promise<ThreadDeltaMessage[]> {
    const root = this.activeRoot();
    if (!root || !this.threadSend) return [];
    // Cross-instance sync: another instance (the summarizer subagent) may
    // have advanced the watermark since this instance's memory was set.
    this.refreshFromDisk();
    const cap = this.opts.threadSummarizeLimit ?? 40;
    const res = await this.threadSend.readTimeline(limit);
    if (!res.success || res.messages.length === 0) return [];
    return filterThreadDelta(res.messages, root.eventId, cap, root.lastSummarizedEventId);
  }

  private async maybeSummarize(root: ThreadRootState): Promise<boolean> {
    const every = this.opts.threadSummaryEvery;
    if (!every || every <= 0) return false;
    if (!summaryDue(root.msgCount, every, this.opts.threadSummaryFib !== false)) return false;
    await this.runSummary(root);
    return true;
  }

  /**
   * One summary pass — the LLM directive or the heuristic root edit.
   * Shared by the cadence gate (`maybeSummarize`) and the report-out
   * trigger (`post()`, kind `"final"`). LLM runs skip when nothing new
   * has been sent since the last completed run; heuristic runs just
   * re-post the ledger line (cheap, and it folds the latest send in).
   */
  private async runSummary(root: ThreadRootState): Promise<void> {
    if (this.opts.threadSummaryByLlm) {
      // Single-flight: a run already dispatched is still reading/posting —
      // its room-sourced delta covers the newer sends, so this trigger is
      // redundant. Skipped before any bookkeeping bump (the in-flight run
      // stays the only one owning summaryRequestedAtMsg semantics).
      if (this.summaryInFlight) return;
      // Cross-instance sync: pick up a baseline/watermark a summarizer
      // subagent (its own ThreadManager instance) may have persisted.
      this.refreshFromDisk();
      // LLM run: nothing new since the last completed run → skip.
      if (root.msgCount <= (root.lastSummaryAtMsg ?? 0)) return;
      // Content gate: the only new posts are wake-answer bookkeeping → the
      // pass would summarise the previous pass's own output.
      if (root.msgCount - (root.lastSummaryAtMsg ?? 0) <= (root.bookkeepingSinceSummary ?? 0)) {
        this.logger.warn("[matrix] summary pass skipped: no new content since the last pass (bookkeeping only)");
        return;
      }
      root.summaryRequestedAtMsg = root.msgCount;
      this.save();
      this.fireLlmRun(root);
      return;
    }
    if (!this.threadSend) return;
    await this.editSummary(root, this.composeSummary(root));
  }

  /**
   * Dispatch one LLM summary pass through the injected dispatcher, holding
   * the single-flight flag for the dispatch's lifetime. The dispatcher
   * contract is never-reject; a synchronous throw still releases the flag.
   * The guard covers the DISPATCH phase (the expensive part: subagent spawn
   * + post). The in-session fallback's agent turn lands after injection and
   * is not covered — a duplicate there is a cheap directive re-run, accepted.
   */
  private fireLlmRun(root: ThreadRootState): boolean {
    if (!this.opts.onSummarizeRequest) return false;
    if (this.summaryInFlight) return false;
    this.summaryInFlight = true;
    try {
      Promise.resolve(this.opts.onSummarizeRequest(root)).finally(() => {
        this.summaryInFlight = false;
      });
    } catch (error) {
      this.summaryInFlight = false;
      throw error;
    }
    return true;
  }

  /**
   * Manual summarization run (`/matrix-thread-summarize`): LLM mode fires
   * the agent directive; without LLM mode it runs the heuristic edit
   * immediately. Returns whether a run was started.
   */
  async requestSummarizeNow(): Promise<boolean> {
    const root = this.activeRoot();
    if (!root) return false;
    if (this.opts.threadSummaryByLlm) {
      this.refreshFromDisk();
      root.summaryRequestedAtMsg = root.msgCount;
      this.save();
      // Manual = explicit user intent: fire when idle. When a run is
      // already in flight, that run IS the requested pass (its delta read
      // lands after this call) — so report wired, not double-fired.
      this.fireLlmRun(root);
      return this.opts.onSummarizeRequest !== undefined;
    }
    return this.updateSummary();
  }

  /**
   * Edit the root to the current summary (or the LLM's markdown body).
   * `customMd` (LLM path) is stored as the baseline for the next run; the
   * root text is `🧵 {topic}` + a lone code-span session line + `{markdown}`
   * (the session id is its own line, rendered grey by markdown.ts).
   */
  async updateSummary(customMd?: string, watermarkEventId?: string): Promise<boolean> {
    const root = this.activeRoot();
    if (!root || !this.threadSend) return false;
    // Teardown/persist path (threads-and-summaries.md): in LLM mode with a saved baseline,
    // a no-arg call means "restore the last good LLM summary", never re-derive
    // the heuristic — that re-derivation is the /reload clobber that erased
    // the LLM-written root. Safe: the recursive call has a customMd, so it
    // takes the LLM branch below and does not recurse. Refresh from disk
    // first: the last good summary may have been persisted by another
    // instance (the summarizer subagent), not this one's memory.
    if (customMd === undefined && this.opts.threadSummaryByLlm) {
      this.refreshFromDisk();
      if (root.lastSummary) {
        return this.updateSummary(root.lastSummary);
      }
    }
    if (customMd !== undefined) {
      // Size-cap backstop: the prompt carries the cap; this only catches
      // LLM drift. ponytail: line-boundary truncate (cheap, may cut a
      // section); upgrade to section-aware compaction only if a truncated
      // root is actually observed in the wild.
      const maxLines = this.opts.threadSummaryMaxLines ?? 0;
      if (maxLines > 0) {
        const lines = customMd.split("\n");
        if (lines.length > maxLines) {
          this.logger.warn(`[matrix] summary ${lines.length} lines exceeds cap ${maxLines} — truncated at line boundary`);
          customMd = lines.slice(0, maxLines).join("\n");
        }
      }
      const icon = this.opts.threadIcon ?? "🧵";
      // The session id rides its own line as a lone code span; markdown.ts
      // renders it as a de-emphasized (grey) code span.
      const span = this.sessionSpan();
      const text = span
        ? `${icon} ${root.topic}\n${span}\n${customMd}`
        : `${icon} ${root.topic}\n${customMd}`;
      // The pipeline's editInThread owns the always-html rule
      // (markdown.ts is the single formatter — the copy-pasted
      // formatter-call sites are gone).
      const ok = await this.editSummary(root, text);
      if (ok) {
        root.lastSummary = customMd;
        root.lastSummaryAtMsg = root.msgCount;
        root.summaryRequestedAtMsg = undefined;
        root.bookkeepingSinceSummary = 0;
        // Advance the per-root event watermark only when the caller says how
        // far the summary reached (the cadence subagent path). A manual run
        // without a delta leaves the watermark where it was.
        if (watermarkEventId !== undefined) root.lastSummarizedEventId = watermarkEventId;
        root.lastActivity = Date.now();
        this.save();
      }
      return ok;
    }
    const ok = await this.editSummary(root, this.composeSummary(root));
    if (ok) root.lastActivity = Date.now();
    return ok;
  }

  private async editSummary(root: ThreadRootState, text: string): Promise<boolean> {
    // Design rule: user-visible content sends always carry the html
    // formatter (the design doc “always-html”) — the pipeline’s `editInThread`
    // owns the conversion (markdown.ts is the single formatter).
    // `threadRoot: true`: keep the `m.thread` marker in the edit's new
    // content (root edits are the only edit target, threads-and-summaries.md).
    const res = await this.threadSend!.editMessage(root.eventId, text, { threadRoot: true });
    if (res.success) return true;
    // threads-and-summaries.md: an `m.replace` the server rejects falls back to a new
    // in-thread summary message — logged, never lost. The fallback rides
    // the same pipeline write (the delegate formats it).
    const fallbackText = `${this.opts.threadIcon ?? "🧵"} summary: ${text}`;
    const fallback = await this.threadSend!.postThreadReply(fallbackText, root.eventId);
    if (!fallback.success) {
      this.logger.warn(`[matrix] thread summary failed and fallback also failed: ${fallback.error ?? res.error}`);
    }
    return fallback.success;
  }

  /** The session id as a lone code span (`id`) for the summary root —
   * markdown.ts renders it grey. "" when the session id is unknown. */
  private sessionSpan(): string {
    return this.opts.sessionHint ? `\`${this.opts.sessionHint}\`` : "";
  }

  /** Heuristic root text  — zero LLM cost, plain English, no timestamp. */
  composeSummary(root?: ThreadRootState): string {
    const r = root ?? this.activeRoot();
    const icon = this.opts.threadIcon ?? "🧵";
    if (!r) return `${icon} (no active thread)`;
    const main = (r.milestones ?? []).slice(-3, -1); // recent highlights
    const now = r.milestones?.at(-1) ?? r.lastMilestone; // latest status
    const parts: string[] = [];
    if (main.length) parts.push(`main: ${main.join("; ")}`);
    if (now) parts.push(`now: ${now}`);
    const span = this.sessionSpan();
    const body = parts.length ? parts.join(" · ") : "in progress";
    return [`${icon} ${r.topic}`, span, body].filter((l) => l !== "").join("\n");
  }

  /** Update the room topic with a short status line (gated, threads-and-summaries.md). */
  async updateTopic(): Promise<void> {
    if (!this.opts.roomTopicUpdates || !this.threadSend) return;
    const root = this.activeRoot();
    if (!root) return;
    const lines = [root.topic];
    if (root.lastMilestone) lines.push(`latest: ${root.lastMilestone}`);
    if (root.openDecisions > 0) lines.push(`${root.openDecisions} open`);
    const res = await this.threadSend.setRoomTopic(lines.join(" · "));
    if (!res.success && !this.topicWarnLogged) {
      this.topicWarnLogged = true;
      this.logger.warn(`[matrix] room topic update failed (power level?): ${res.error ?? "unknown"}`);
    }
  }

  /**
   * Adopt an existing thread root as the active thread (threads-and-summaries.md /
   * threads-and-summaries.md): used when the user's in-room reply already carries a thread root
   * (they started the conversation in a thread, e.g. in Element). Creates
   * the state-map entry when the root is unknown to us.
   */
  adoptRoot(eventId: string): ThreadRootState | undefined {
    if (!this.opts.enabled || !eventId) return undefined;
    let root = this.root(eventId);
    if (!root) {
      root = {
        eventId,
        topic: "(user thread)",
        msgCount: 0,
        openDecisions: 0,
        lastActivity: Date.now(),
        milestones: [],
        subThreads: [],
      };
      this.entry.roots.push(root);
      if (this.opts.sessionHint !== undefined) this.entry.sessions[this.opts.sessionHint] = eventId;
      this.save();
    }
    this.activeRootId = eventId;
    this.sessionState = "active";
    this.logger.debug(`[matrix] thread root adopted ${eventId}`);
    return root;
  }

  /**
   * `session_shutdown` (threads-and-summaries.md): final summary into the root +
   * optional topic update. Non-blocking — a failed outbox call must not
   * hold shutdown up.
   */
  async shutdown(): Promise<void> {
    if (!this.threadSend || !this.activeRoot()) return;
    await this.updateSummary().catch(() => {});
    await this.updateTopic().catch(() => {});
  }

  // ==========================================================================
  // State persistence 
  // ==========================================================================

  private load(): ThreadMapState {
    if (!this.opts.statePath || !existsSync(this.opts.statePath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.opts.statePath, "utf-8")) as ThreadMapState;
      const state = parsed && typeof parsed === "object" ? parsed : {};
      // Migrate pre-milestones-list state: backfill the ledger array.
      for (const entry of Object.values(state)) for (const root of entry.roots) root.milestones ??= [];
      return state;
    } catch (error) {
      this.logger.warn(`[matrix] failed to load thread map: ${error}`);
      return {};
    }
  }

  private save(): void {
    if (!this.opts.statePath) return;
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      writeFileSync(this.opts.statePath, JSON.stringify(this.state, null, 2) + "\n", "utf-8");
    } catch (error) {
      this.logger.warn(`[matrix] failed to save thread map: ${error}`);
    }
  }

  /** Current state snapshot (for `/matrix-status` thread block). */
  status(): {
    enabled: boolean;
    sessionState: ThreadManager["sessionState"];
    activeRoot?: ThreadRootState;
  } {
    return {
      enabled: this.opts.enabled,
      sessionState: this.sessionState,
      activeRoot: this.activeRoot(),
    };
  }

  /** Persist any pending changes (cleanup hook). */
  cleanup(): void {
    this.save();
  }

  private warnFlat(msg: string): void {
    if (this.flatModeLogged) return;
    this.flatModeLogged = true;
    this.sessionState = "flat";
    this.logger.warn(`[matrix] threading degraded to flat mode (one-time): ${msg}`);
  }
}

/**
 * Create a thread manager. `roomKey` should be stable across `/matrix-switch`
 * for the same room (use the room alias/id), so threads survive switches.
 */
export function createThreadManager(opts: ThreadManagerOptions): ThreadManager {
  return new ThreadManager(opts);
}
