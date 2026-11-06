/**
 * Pi Matrix Integration — Lifecycle.
 *
 * The session/connect state the entry point used to hold in closures
 * (index.ts): the `enabled` flag, the shared connect + start sequence,
 * the session hook bodies, and the teardown order. The "constants →
 * module, state → class" rule: this class owns the state; index.ts keeps
 * only the hook REGISTRATIONS (the object-stable rebind discipline, stated
 * in the index.ts header — nothing re-registers or deregisters on
 * /matrix-switch;
 * the registrations dispatch through the current stack at call time).
 *
 * `ConnectionStatus` ownership: this class owns the
 * snapshot — fed by the connect() outcomes and the sdk transport's
 * `onSyncError` delivery callback. The footer's `() => ConnectionStatus` callback
 * reads this snapshot via the session-integration provider (the
 * transport is the SdkOutbox).
 */

import type {
  BeforeAgentStartEvent,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
// Three pi event types the package root .d.ts does not re-export
// (`ModelSelectEvent`, `ThinkingLevelSelectEvent`,
// `SessionCompactFailedEvent` live in dist/core/extensions/types.d.ts
// and are absent from the root re-export list; the package exports map
// bars the dist subpath) — these bodies take structural shapes instead
// (type-only imports are stripped at runtime; no tsconfig gate in this
// extension; the real events are structurally compatible at the
// registration adapters in index.ts).
type ModelSelectEvent = {
  model: { provider?: string; id?: string; name?: string };
  previousModel?: { provider?: string; id?: string; name?: string };
  source: string;
};
type ThinkingLevelSelectEvent = {
  level: string;
  previousLevel: string;
};
type SessionCompactFailedEvent = {
  reason: string;
  errorMessage?: string;
  aborted: boolean;
};
import type { SdkOutbox, SdkDeliveryCallbacks } from "./sdk-client.js";
import type { MessageHandler } from "./message-handler.js";
import type { ThreadManager } from "./threading.js";
import type { SessionIntegrator } from "./session-integration.js";
import { extractMilestone, extractTodoUpdate, isSummarizerWakeNotice, isSummarizeDirectiveNotice, messageText, truncateFinalMessage } from "./classify.js";
import { encryptionNotice } from "./encryption-status.js";
import type { SubagentBusImpl, SubagentPostIdentity } from "./subagent-bus.js";
import type { ConnectionStatus, MatrixConfig } from "./types.js";
import type { MatrixLogger } from "./logger.js";

/** True when the assistant message carries an `ask_user_question` tool call
 *  (the call that parks the turn on user input — see `onMessageEnd`). */
export function hasAskUserCall(message: { content?: unknown }): boolean {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.some(
    (b) => (b as { type?: string; name?: string })?.type === "toolCall" &&
      (b as { name?: string })?.name === "ask_user_question",
  );
}

/** A side-chain session's own identity. */
interface SubagentSelf {
  sessionId: string;
  sessionName: string;
  bound: SubagentPostIdentity | null;
  lastAssistant: string | null;
}

/**
 * Side-chain (sub-agent) session detection:
 * the session header carries `parentSession` for fork/branch/sub-agent
 * lineages; `fork`/`resume` are MAIN-line replacements, so only the other
 * reasons with a parent header are side chains.
 */
export function isSidechainSession(
  sessionManager:
    | { getHeader?: () => { parentSession?: string } | null | undefined }
    | undefined,
  reason: string,
): boolean {
  if (reason === "fork" || reason === "resume") return false;
  try {
    return Boolean(sessionManager?.getHeader?.()?.parentSession);
  } catch {
    return false;
  }
}

/**
 * True when THIS process is a subagent child/runner host. The launcher
 * exports `PI_SUBAGENT_CHILD=1` into every detached child (the package's
 * own doctor reads the same marker), so this extension's copies inside
 * runner children detect themselves without provider cooperation.
 *
 * Runner posture: inside a child process,
 * EVERY session is treated as a side chain — a background child must
 * never open a second Matrix client, even if the `parentSession` header
 * convention breaks, and this extension's shutdown paths must never act
 * as process exit (the runner hosts many children and survives each
 * one's `session_shutdown`).
 */
export function isSubagentRunner(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

export interface LifecycleDeps {
  /** The stack's config — the instance is rebuilt with the stack on
   *  /matrix-switch, so a captured cfg is always the current one. */
  cfg: MatrixConfig;
  logger: MatrixLogger;
  outbox: SdkOutbox;
  deliveryCallbacks: SdkDeliveryCallbacks;
  messageHandler: MessageHandler;
  threadManager: ThreadManager;
  sessionIntegrator: SessionIntegrator;
  /** Call-time owner-bus lookup (the globalThis publish; undefined → the
   *  stack has no sub-agent reporting wiring). */
  subagentBus?: () => SubagentBusImpl | null;
  /** First-run login (configuration-and-room-behaviour.md transport-and-state.md): runs the dialogue
   *  when no loadable credentials exist; returns true when it handled the
   *  connect itself (the caller must not run connectAndStart). */
  onFirstRun?: (
    ctx: ExtensionContext,
    milestone?: { text: string; flat?: boolean },
  ) => Promise<boolean>;
}

/**
 * The connect-announcement room link (matrix.to). matrix.to is the standard
 * HTTPS deep-link that opens the installed Matrix app on phones/tablets via
 * Universal Links / App Links, and falls back to the web client when no app
  * is installed. There is no standard `matrix://` custom URI scheme — the
 * spec only defines `mxc://` (media) — so matrix.to is the open-in-app
 * vehicle. Format: `https://matrix.to/#/<roomId>` where roomId is a room
 * alias (`#name:domain`) or a room ID (`!id:domain`). Returns "" when roomId
 * is absent (the announcement then is the bare status line). The link carries a
 * leading space because its only caller appends it straight after the status
 * text; drop the space here if it ever feeds a markdown link.
 */
export function buildMatrixToLink(roomId: string | undefined): string {
  return roomId ? ` https://matrix.to/#/${roomId}` : "";
}

export class Lifecycle {
  private readonly deps: LifecycleDeps;
  // Ephemeral by design — no state/ persistence: the
  // snapshot lives in memory per stack build; /matrix-switch rebuilds it.
  private enabled = false;
  private snapshot: ConnectionStatus;
  /** Set when THIS session is a side chain (sub-agent) — the hooks then
   *  route through the owner bus and never touch the connection. */
  private subagent: SubagentSelf | null = null;
  /** The RUN currently live is a thread-summary pass — started by a
   *  summarizer completion notice (Engine B) or the in-session summarize
   *  directive (Engine A); its report-out stays out of the room (see
   *  `onBeforeAgentStart` + the 2026-10 summary-loop incident).
   *  Run-scoped on purpose: a pass is ≥2 turns (tool call, then a closing
   *  line) and pi fires `before_agent_start` once per run, so a flag released
   *  on the first `turn_end` un-muted the closing line and leaked it into the
   *  room (the 2026-11 repeat of the summary-loop incident). Released at
   *  `agent_settled`, at the next run's start, or when a human message lands
   *  mid-pass. */
  private summaryPassRun = false;
  /** A summarizer wake notice was absorbed into the run currently live (see
   *  `onMessageEnd`). Its report-out must still reach the room, but it must
   *  not re-arm the on-final summary trigger — that answer is the wake's own
   *  bookkeeping (the 2026-10 summary loop, fix A). Cleared at the next
   *  `before_agent_start`. */
  private wakeFuelTurn = false;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
    this.snapshot = {
      connected: false,
      connecting: false,
      roomId: deps.cfg.roomId,
      userId: deps.cfg.userId ?? "",
    };
  }

  // ==========================================================================
  // The enabled flag (the old `isEnabled` closure — state → class)
  // ==========================================================================

  /** The integration-enabled predicate (mirror gate + command/tool gates). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Set the flag (the connect/disconnect/toggle paths). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // ==========================================================================
  // ConnectionStatus snapshot (transport-and-state.md ownership)
  // ==========================================================================

  /** A copy of the current snapshot (the footer's `() => ConnectionStatus`
   *  callback shape — the consumer re-pointing lands in the terminal slice). */
  status(): ConnectionStatus {
    return { ...this.snapshot };
  }

  /**
   * The sync-error feed (SdkOutbox's sync handler calls this through the
   * delivery callbacks): the sdk sync-loop failure marks the snapshot
   * degraded. Not logged here — the source (sdk-client) already logged.
   */
  noteSyncError(error: Error): void {
    this.snapshot = {
      ...this.snapshot,
      lastError: `sdk sync error: ${error.message ?? error}`,
      lastErrorTime: Date.now(),
    };
  }

  // ==========================================================================
  // Connect + start / teardown
  // ==========================================================================

  /**
   * The shared connect + start sequence for `/matrix-connect` and (when
   * `autoConnect`) `session_start`. Errors are swallowed — a missing
   * credential or unreachable homeserver must never break session start;
   * the failure surfaces as a notify + the footer's `lastError`. When
   * `sessionMilestone` is provided (the `session_start` path) and the
   * connection succeeds, a short "Pi did X" line is pushed to the room
   * so the user sees Pi come online on their phone. Gated by
   * `config.sendSessionStartStopMilestones`.
   */
  async connectAndStart(
    ctx: ExtensionContext,
    sessionMilestone?: { text: string; flat?: boolean },
  ): Promise<void> {
    try {
      const success = await this.deps.outbox.connect();
      if (success) {
        this.enabled = true;
        this.deps.outbox.startDelivery(this.deps.deliveryCallbacks);
        // Clear lastError on success so /matrix-status'
        // "Last Error" line doesn't go stale
        // after a successful reconnect.
        this.snapshot = {
          ...this.snapshot,
          connected: true,
          connecting: false,
          lastActivity: Date.now(),
          lastError: undefined,
          lastErrorTime: undefined,
        };
        // The announcement carries a matrix.to deep-link — the standard
        // link that opens the installed Matrix app on phones/tablets
        // (Universal/App Links), falling back to the web client.
        const roomUri = buildMatrixToLink(this.deps.cfg.roomId);
        ctx.ui.notify(`Connected to Matrix!${roomUri}`, "info");
        // Startup encryption notice: tell the user the room's
        // REAL E2EE state with the same lock language as the footer. The
        // state rides the first sync, so poll briefly (non-blocking) rather
        // than guess; the footer stays the persistent indicator.
        void this.announceRoomEncryption(ctx);
        if (sessionMilestone) {
          try {
            await this.deps.messageHandler.sendMilestone(sessionMilestone.text, undefined, {
              // `flat` skips thread routing (the /new announcement must not
              // soft-attach into the previous session's thread).
              flat: sessionMilestone.flat,
            });
          } catch (error) {
            this.deps.logger.warn(`[matrix] session milestone failed: ${error}`);
          }
        }
      } else {
        this.snapshot = {
          ...this.snapshot,
          connected: false,
          connecting: false,
          lastError: "sdk transport could not start",
          lastErrorTime: Date.now(),
        };
        ctx.ui.notify("Failed to connect to Matrix (see /matrix-status)", "error");
      }
    } catch (error) {
      this.deps.logger.warn(`[matrix] connect failed: ${error}`);
    }
    this.deps.sessionIntegrator.updateFooterStatus(ctx);
  }

  /**
   * Inform the user of the room's encryption state once known.
   * The `m.room.encryption` state event arrives with the first sync, so the
   * transport reports `undefined` until then — poll a few seconds, notify once,
   * then give up silently (the footer keeps refreshing and shows the lock as
   * soon as state lands). Fire-and-forget; never holds connect open.
   */
  private async announceRoomEncryption(ctx: ExtensionContext): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const enc = this.deps.outbox.isRoomEncrypted?.();
      if (enc !== undefined) {
        // kind drives the line style: plain when encrypted, orange "Warning"
        // when plaintext. ("error" was wrong severity — a plaintext room is a
        // warning, not a failure. The host has no "success" kind; plain is
        // the success style.)
        ctx.ui.notify(`Matrix ${this.matrixTarget()} · ${encryptionNotice(enc)}`, enc ? "info" : "warning");
        // Repaint the footer the instant state is known: the footer only
        // re-renders on events, so without this the lock can stay hidden until
        // the next activity (the flaky "sometimes I see it" symptom).
        this.deps.sessionIntegrator.updateFooterStatus(ctx);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Short "domain/#room" label for the startup notice (matches the footer's
   *  domain-before-room convention). Falls back to the bare room id, then the
   *  domain, when one part is missing. */
  private matrixTarget(): string {
    const roomId = this.deps.cfg.roomId ?? "";
    const lastColon = (s: string): string => (s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : "");
    const domain = lastColon(this.deps.cfg.userId ?? "") || lastColon(roomId);
    const room = roomId.includes(":") ? roomId.slice(0, roomId.lastIndexOf(":")) : roomId;
    if (domain && room) return `${domain}/${room}`;
    return domain || room;
  }

  /**
   * The teardown order (the decision): stopDelivery → disconnect — the
   * delivery pipeline detaches BEFORE the sync loop stops (the facade's
   * stopPolling stops the sdk delivery; `SdkOutbox.disconnect` calls
   * `stopDelivery` itself). Used by
   * `session_shutdown`; the disconnect/toggle commands keep their
   * lighter 4-line variant until the terminal slice unifies them.
   */
  teardown(): void {
    this.deps.outbox.stopDelivery();
    void this.deps.outbox.disconnect();
    this.deps.messageHandler.cleanup();
    // Final summary into the active thread root + optional topic update
    // (transport-and-state.md) — fire-and-forget; a failed outbox call never holds
    // shutdown up.
    void this.deps.threadManager.shutdown();
    this.enabled = false;
  }

  // ==========================================================================
  // Session hook bodies (the registrations stay in index.ts)
  // ==========================================================================

  /**
   * session_start (transport-and-state.md): `new` and `startup` mark the
   * session pending (no Matrix traffic until the first user message opens
   * the thread — the "Pi session started" milestone lands flat in the
   * room); `resume`/`fork` re-attach to their thread from the state map
   * when the session id is known; `reload` keeps the same session, so it
   * re-attaches to the most recent root. No-op when `threads` is off.
   */
  async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    // Side-chain session: no connect, no
    // thread root, no milestones — the owner instance owns all of that.
    // The runner guard joins the test: a
    // header-less background child inside the runner still never claims
    // main line.
    if (
      isSubagentRunner() ||
      isSidechainSession(
        ctx.sessionManager as { getHeader?: () => { parentSession?: string } | null | undefined },
        event.reason,
      )
    ) {
      const sm = ctx.sessionManager as { getSessionId?: () => string; getSessionName?: () => string | undefined };
      const sessionId = sm?.getSessionId?.() ?? "";
      const sessionName = sm?.getSessionName?.() ?? "";
      this.subagent = { sessionId, sessionName, bound: null, lastAssistant: null };
      this.deps.logger.debug(
        `[matrix] side-chain session ${sessionId} (${sessionName || "unnamed"}) — sub-agent mode; the owner keeps the Matrix connection`,
      );
      return;
    }
    this.deps.threadManager.beginSession(event.reason, ctx.sessionManager?.getSessionId?.());
    if (this.deps.cfg.autoConnect) {
      // Default: connect at session start. Opt out with
      // autoConnect: false and use /matrix-connect manually.
      //
      // When the `sendSessionStartStopMilestones` toggle is on, push a short
      // "Pi did X" line to the room once we're connected. The reason
      // distinguishes startup, /reload, /new, /resume, and /fork.
      let milestone: { text: string; flat?: boolean } | undefined;
      if (this.deps.cfg.sendSessionStartStopMilestones) {
        switch (event.reason) {
          case "startup":
            // A fresh process starts a new session: announce it flat in the
            // room, not in the previous session's thread ("latest" mode).
            milestone = { text: `Pi session started`, flat: true };
            break;
          case "reload":
            milestone = { text: `Pi reloaded (extensions + config)` };
            break;
          case "new":
            milestone = { text: `Pi started a new session (/new)`, flat: true };
            break;
          case "resume":
            milestone = { text: `Pi resumed a session` };
            break;
          case "fork":
            milestone = { text: `Pi forked a session` };
            break;
        }
      }
      // First run (configuration-and-room-behaviour.md transport-and-state.md): no loadable
      // credentials → the login dialogue before the connect attempt.
      // Cancel/decline falls through to today's warn-and-degrade; the
      // hook owns the connect on success.
      if (await this.deps.onFirstRun?.(ctx, milestone)) return;
      await this.connectAndStart(ctx, milestone);
    } else {
      this.deps.sessionIntegrator.updateFooterStatus(ctx);
    }
  }

  /** session_shutdown — the full teardown (see `teardown()`). */
  /** session_shutdown — the full teardown (see `teardown()`). */
  onSessionShutdown(_event: SessionShutdownEvent): void {
    if (this.subagent) {
      // Side chain: the OWNER keeps the connection — no teardown here
      this.subagent = null;
      return;
    }
    this.teardown();
  }

  /** Context compaction (/compact, auto-compact on threshold or overflow). */
  async onSessionCompact(event: SessionCompactEvent): Promise<void> {
    if (this.subagent) return;
    if (!this.isEnabled() || !this.deps.cfg.sendCompactionMilestones) return;
    try {
      const reason = event.reason;
      let text: string;
      switch (reason) {
        case "manual":
          text = `Pi compacted context (/compact)`;
          break;
        case "threshold":
          text = `Pi auto-compacted context (threshold)`;
          break;
        case "overflow":
          text = `Pi auto-compacted context (overflow recovery)`;
          break;
        default:
          text = `Pi compacted context`;
      }
      if (event.willRetry) {
        text += ` — retrying the aborted turn`;
      }
      // `reason` is already spelled out in `text`; nothing else to attach.
      await this.deps.messageHandler.sendMilestone(text);
    } catch (error) {
      this.deps.logger.warn(`[matrix] compact milestone failed: ${error}`);
    }
  }

  /**
   * Compaction failure/abort — surface it so the user knows the context
   * wasn't compacted.
   */
  async onSessionCompactFailed(event: SessionCompactFailedEvent): Promise<void> {
    if (this.subagent) return;
    if (!this.isEnabled() || !this.deps.cfg.sendCompactionMilestones) return;
    try {
      const suffix = event.aborted
        ? "(aborted)"
        : event.errorMessage
          ? `(error: ${event.errorMessage})`
          : "";
      await this.deps.messageHandler.sendMilestone(`Pi failed to compact context ${suffix}`);
    } catch (error) {
      this.deps.logger.warn(`[matrix] compact-failed milestone failed: ${error}`);
    }
  }

  /** Model switch via /model, Ctrl+P cycling, or session restore. */
  async onModelSelect(event: ModelSelectEvent): Promise<void> {
    if (this.subagent) return;
    if (!this.isEnabled() || !this.deps.cfg.sendModelChangeMilestones) return;
    try {
      const model = event.model;
      const prev = event.previousModel;
      const name = (m?: { provider?: string; id?: string; name?: string }) =>
        m ? `${m.provider ?? "?"}/${m.name ?? m.id ?? "?"}` : "none";
      const text = `Pi model: ${name(prev)} → ${name(model)} (${event.source})`;
      // `text` already carries prev → new (source); no payload to attach.
      await this.deps.messageHandler.sendMilestone(text);
    } catch (error) {
      this.deps.logger.warn(`[matrix] model milestone failed: ${error}`);
    }
  }

  /** Thinking level changes (settings, keybinding, pi.setThinkingLevel()). */
  async onThinkingLevelSelect(event: ThinkingLevelSelectEvent): Promise<void> {
    if (this.subagent) return;
    if (!this.isEnabled() || !this.deps.cfg.sendModelChangeMilestones) return;
    try {
      const text = `Pi thinking level: ${event.previousLevel} → ${event.level}`;
      await this.deps.messageHandler.sendMilestone(text);
    } catch (error) {
      this.deps.logger.warn(`[matrix] thinking-level milestone failed: ${error}`);
    }
  }

  /**
   * message_end — broadcast milestones found in assistant messages
   * (gated by `sendMilestones` — the heuristic auto-broadcasts; the LLM
   * tool `matrix_send_milestone` is not gated).
   */
  async onMessageEnd(event: MessageEndEvent): Promise<void> {
    if (this.subagent) return this.onSubagentMessageEnd(event);
    if (!this.isEnabled()) return;
    // A human message folded into a live pass ends the mute: swallowing a
    // real question is worse than one leaked line. Every message this
    // extension injects (room relay, directive, wake notice) carries a
    // `customType`, so a bare user message here is terminal-typed input.
    const incoming = event.message as { role?: string; customType?: unknown };
    if (
      this.summaryPassRun &&
      incoming.role === "user" &&
      incoming.customType === undefined
    ) {
      this.summaryPassRun = false;
      this.deps.logger.warn(
        "[matrix] message_end: user input during a summary pass, broadcast mute lifted",
      );
    }
    // Busy-parent observability (the 2026-10 summary-loop incident):
    // a wake notice / summarize directive delivered WHILE a run is live is
    // queued INTO that run — before_agent_start never fires for it, so it
    // cannot be muted. Muting is also wrong here: the run's report answers
    // real work the user asked for. The loop still dies: once the parent
    // goes idle, the next notice starts its own run and IS muted, so an
    // absorbed notice adds at most one legitimate content-driven pass.
    // Logged, never muted. Detection is structural (details), not prose.
    if (
      !this.summaryPassRun &&
      (isSummarizerWakeNotice(event.message) || isSummarizeDirectiveNotice(event.message))
    ) {
      this.wakeFuelTurn = true;
      this.deps.logger.warn(
        "[matrix] summary fuel notice absorbed by live run: broadcast kept, on-final trigger suppressed",
      );
      // Leak guard (wake lands mid-turn): the notice content is already in
      // this run's context and cannot be unsent — ride a hidden quiet
      // directive after it so the model keeps it out of the user-facing
      // reply. triggerTurn:false → no-ops when the run is already over.
      this.deps.sessionIntegrator?.injectQuietDirective(
        "The completion notice just added to this conversation is internal bookkeeping (a background summary run finishing). Do not quote it, summarize it, or hint at its content in user-visible output; continue the current turn as if it had not appeared.",
        { kind: "absorbed-notice-hint" },
      );
    }
    // Decision-context flush (ask_user_question ordering): pi fires
    // turn_end only AFTER the turn's tool calls finish, and the
    // ask_user_question call blocks on terminal input — so the turn_end
    // final broadcast would land in the room only after the answer,
    // BEHIND the questionnaire the mirror posts at tool-start. message_end
    // fires before tools run: send the message's text here when it carries
    // an ask_user_question call. The later turn_end send of the same text
    // is content-key-deduped by the MessageHandler (10 min window).
    const askText = event.message.role === "assistant" && hasAskUserCall(event.message)
      ? messageText(event.message)
      : null;
    if (askText) {
      // Same loop guard as the turn_end broadcast (one flag for the whole
      // pass, read — never consumed — by both).
      if (this.summaryPassRun) {
        this.deps.logger.debug(
          "[matrix] message_end: wake-turn ask_user context flush skipped (loop guard)",
        );
      } else if (!this.deps.cfg.sendFinalMessages) {
        this.deps.logger.debug(
          "[matrix] message_end: sendFinalMessages off, skipping ask_user context flush",
        );
      } else {
        try {
          await this.deps.messageHandler.sendFinalMessage(
            truncateFinalMessage(askText, this.deps.cfg.maxFinalMessageLength),
          );
        } catch (error) {
          this.deps.logger.warn(`[matrix] ask_user context flush failed: ${error}`);
        }
      }
    }
    if (!this.deps.cfg.sendMilestones) return;
    try {
      const message = event.message;
      if (message.role === "assistant") {
        const milestone = extractMilestone(message);
        if (milestone) {
          await this.deps.messageHandler.sendMilestone(milestone);
        }
      }
    } catch (error) {
      this.deps.logger.warn(`[matrix] milestone broadcast failed: ${error}`);
    }
  }

  /**
   * before_agent_start — flag a run started by a summarizer completion
   * notice (Engine B) or by the extension's own thread-summary directive
   * (Engine A, the subagent-unavailable fallback). Pi hands the starting
   * custom message to the hook (`messageType: "custom"` + `message`);
   * pi-subagents carries the finished runs in `message.details.runs` and
   * the directive carries `details.kind` — the only reliable identities,
   * since the model-visible text is prose. The flag makes `onTurnEnd` skip
   * that turn's final broadcast: no thread message, so the cadence guard
   * (`msgCount <= lastSummaryAtMsg`) stops spawning. The wake itself still
   * happens (pi-subagents 0.80.0 queues it for every async run); only its
   * room echo is muted — for every turn of that run, not only the first.
   */
  onBeforeAgentStart(event: BeforeAgentStartEvent): void {
    if (this.subagent) return;
    // A new run begins: a wake-fuel flag or a summary-pass mute left over from
    // the previous run (a run that died before `agent_settled`) must not
    // silence this run's report-out. A wake absorbed mid-run never fires this
    // hook, so clearing here cannot drop the flag it set.
    this.wakeFuelTurn = false;
    this.summaryPassRun = false;
    this.deps.threadManager?.clearOnFinalSuppression();
    if (event.messageType !== "custom") return;
    const muted = isSummarizerWakeNotice(event.message) || isSummarizeDirectiveNotice(event.message);
    // warn (not debug): the live default logLevel is INFO, and the debug-only
    // guard lines made the wake loop unverifiable during the incident (and
    // this verification). A notice observed here is rare (one per summary
    // pass) and load-bearing — the mismatch case (customType/runs shape)
    // names exactly why a notice did NOT match.
    const customType = (event.message as { customType?: string } | undefined)?.customType ?? "?";
    if (customType === "subagent-notify" || customType === "matrix-directive" || muted) {
      const runs = (event.message as { details?: { runs?: { agent?: string }[] } } | undefined)?.details?.runs;
      const agents = Array.isArray(runs) ? runs.map((r) => r?.agent ?? "?").join(",") : "-";
      this.deps.logger.warn(`[matrix] before_agent_start custom=${customType} runs=[${agents}] summary-turn-muted=${muted}`);
    }
    if (muted) {
      this.summaryPassRun = true;
    }
  }

  /**
   * turn_end — broadcast TODO progress updates, and (optionally) the
   * turn's final assistant message (the "final answer" the user last saw
   * in the terminal).
   */
  async onTurnEnd(event: TurnEndEvent): Promise<void> {
    if (this.subagent) return this.onSubagentTurnEnd(event);
    // Read, never consumed here: the mute covers the whole summary-pass run
    // and is released at `agent_settled`, at the next run's start, or by a
    // human message landing mid-pass. The side-chain branch above cannot mute
    // a real run: a side-chain instance never sets the flag, because
    // `onBeforeAgentStart` exits as soon as `subagent` is bound.
    const mutedRun = this.summaryPassRun;
    if (!this.isEnabled()) {
      // Observable (not silent): a dropped final answer here was invisible
      // for a whole session because no turn_end log line ever appeared.
      this.deps.logger.debug("[matrix] turn_end: integration not enabled, skipping broadcast");
      return;
    }
    try {
      // The loop guard, ahead of every room write this turn can make — a
      // TODO-progress milestone from inside a pass would re-arm the cadence
      // exactly like the leaked final answer did.
      if (mutedRun) {
        // warn (not debug): this is the line the live verification greps for
        // at the default INFO level (wording kept from the 2026-10 incident).
        this.deps.logger.warn(
          "[matrix] turn_end: summarizer wake turn, skipping final broadcast (loop guard)",
        );
        return;
      }
      const todoUpdate = this.deps.cfg.sendMilestones ? extractTodoUpdate(event.message) : null;
      if (todoUpdate) {
        await this.deps.messageHandler.sendMilestone(`TODO progress: ${todoUpdate}`);
      }

      const role = event.message?.role;
      if (!this.deps.cfg.sendFinalMessages) {
        this.deps.logger.debug("[matrix] turn_end: sendFinalMessages off, skipping final broadcast");
        return;
      }
      if (role !== "assistant") {
        // Tool-call turns (and any non-assistant turn_end) carry no text to
        // broadcast. Log the actual role so a genuinely unexpected value is
        // visible instead of silently dropping the final answer.
        this.deps.logger.debug(
          `[matrix] turn_end: message role "${role ?? "undefined"}" is not assistant, skipping final broadcast`,
        );
        return;
      }
      const finalText = messageText(event.message);
      if (!finalText) {
        const types = (event.message?.content ?? []).map((c) => c.type).join(",") || "none";
        this.deps.logger.debug(
          `[matrix] turn_end: assistant message has no text blocks (content types: ${types}), skipping final broadcast`,
        );
        return;
      }
      // Wake-fuel report-out: the answer ships, the summary re-arm does not.
      if (this.wakeFuelTurn) this.deps.threadManager?.suppressNextOnFinalTrigger();
      const result = await this.deps.messageHandler.sendFinalMessage(
        truncateFinalMessage(finalText, this.deps.cfg.maxFinalMessageLength),
      );
      if (!result.success && !result.deduped) {
        this.deps.logger.warn(`[matrix] final message broadcast failed: ${result.error}`);
      }
    } catch (error) {
      this.deps.logger.warn(`[matrix] turn_end broadcast failed: ${error}`);
    }
  }

  /**
   * input — broadcast the user's own terminal-typed prompt as a
   * "🧑 User: …" line, so a phone-only user sees what they (or a
   * colleague at the terminal) asked. The `input` event fires for every
   * user prompt, but only when `event.source === "interactive"` was the
   * user typing in the Pi terminal. Matrix-relayed messages either arrive
   * as `source === "extension"` (via `pi.sendUserMessage`) or don't fire
   * the `input` event at all (via custom-message injection), so they
   * never reach this broadcast — no echo loop back into the room. Gated
   * by `sendUserMessages`.
   */
  async onInput(event: InputEvent): Promise<void> {
    if (this.subagent) return this.onSubagentInput(event);
    if (!this.isEnabled() || !this.deps.cfg.sendUserMessages) return;
    // Only genuine terminal-typed input; Matrix-relayed messages are
    // source === "extension" (sendUserMessage) or never fire this event at
    // all (custom injection).
    if (event.source !== "interactive") return;
    try {
      const text = (event.text ?? "").trim();
      if (!text) return;
      const result = await this.deps.messageHandler.sendUserMessage(text);
      if (!result.success && !result.deduped) {
        this.deps.logger.warn(`[matrix] user-message broadcast failed: ${result.error}`);
      }
    } catch (error) {
      this.deps.logger.warn(`[matrix] user-message broadcast failed: ${error}`);
    }
  }

  // ==========================================================================
  // Side-chain (sub-agent) session hooks 
  // ==========================================================================

  /** The first `input` of a side-chain session is the spawn prompt — bind
   *  it to the owner's spawn record (prompt match). Steered/extra inputs
   *  never re-bind (bound is one-shot). */
  private onSubagentInput(event: InputEvent): void {
    const sa = this.subagent;
    if (!sa || sa.bound) return;
    const bus = this.deps.subagentBus?.() ?? null;
    if (!bus) return;
    const prompt = (event.text ?? "").trim();
    if (!prompt) return;
    sa.bound = bus.bind(sa.sessionId, sa.sessionName, prompt, true);
    this.deps.logger.debug(
      sa.bound
        ? `[matrix] side-chain ${sa.sessionId} bound → ${sa.bound.name} (depth ${sa.bound.depth})`
        : `[matrix] side-chain ${sa.sessionId} unbound (no matching spawn record — traffic stays silent)`,
    );
  }

  /** message_end — capture the last assistant message (the settle result
   *  text) and, in `all` mode, post every assistant message. */
  private onSubagentMessageEnd(event: MessageEndEvent): void {
    const sa = this.subagent;
    if (!sa) return;
    const text = event.message.role === "assistant" ? messageText(event.message) : null;
    if (text) sa.lastAssistant = text;
    if (!text || !sa.bound) return;
    const bus = this.deps.subagentBus?.();
    const s = this.deps.cfg.subagents;
    if (!bus || !s?.enabled || s.postMode !== "all") return;
    bus.post(sa.sessionId, truncateFinalMessage(text, this.deps.cfg.maxFinalMessageLength), "message");
  }

  /** turn_end — `turn-end` mode: post the turn's final assistant message. */
  private onSubagentTurnEnd(event: TurnEndEvent): void {
    const sa = this.subagent;
    if (!sa || !sa.bound) return;
    const text = event.message?.role === "assistant" ? messageText(event.message) : null;
    if (!text) return;
    const bus = this.deps.subagentBus?.();
    const s = this.deps.cfg.subagents;
    if (!bus || !s?.enabled || s.postMode !== "turn-end") return;
    bus.post(sa.sessionId, truncateFinalMessage(text, this.deps.cfg.maxFinalMessageLength), "turn");
  }

  /** agent_settled — the single settle source (transport-and-state.md Q4, PO: agreed). */
  onAgentSettled(): void {
    // The summary-pass mute ends with its run. Before the side-chain
    // early-return below, which the flag-owning (main) session always hits.
    this.summaryPassRun = false;
    const sa = this.subagent;
    if (!sa || !sa.bound) return;
    const bus = this.deps.subagentBus?.();
    const s = this.deps.cfg.subagents;
    if (!bus || !s?.enabled) return;
    bus.settle(sa.sessionId, sa.lastAssistant ?? "");
    this.deps.logger.debug(`[matrix] side-chain ${sa.sessionId} settled → ${sa.bound.name}`);
  }

  /** True when THIS session is a side chain (sub-agent) — used by the
   *  tool watchers to route `Agent` tool_calls (spawn vs nested spawn). */
  isSubagentMode(): boolean {
    return this.subagent !== null;
  }

  /** The bound name of this side chain (nested-spawn attribution; the
   *  spawn name while still unbound). */
  subagentSelfName(): string | undefined {
    return this.subagent?.bound?.name;
  }
}

/**
 * Build the lifecycle owner (one-line factory, the `createMessageHandler`
 * shape).
 */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  return new Lifecycle(deps);
}
