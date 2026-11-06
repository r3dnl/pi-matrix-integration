/**
 * Pi Matrix Integration — the single room-event dispatch point
 *
 * One funnel for every room event (replacing the index.ts onMessage +
 * onReaction bodies, 1:1): threading adoption → ask-user mirror
 * consume → slash relay → @@ artifact attach → @ file attach →
 * decision/inject. Each leg that consumes the message stops the funnel;
 * the tail injects into the session as an attributed custom message.
 *
 * State-free orchestrator (the closure-factory + deps shape of
 * ask-user-mirror.ts): the picker state lives in the factory-scope
 * PickerState, the mirror's open/close state lives in the mirror, thread
 * routing in the ThreadManager. Rebuilt with the stack on /matrix-switch
 * (the object-stable rebind discipline — index.ts registrations dispatch
 * through the CURRENT inbound at call time; nothing re-registers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findCommand, fuzzyCommandCandidates, parseCommandLine } from "./command-relay.js";
import { escapeHtml } from "./markdown.js";
import { isAgentHelp } from "./matrix-help.js";
import { isPiMachineTraffic, localpartOf } from "./classify.js";
import type { RoomUx } from "./room-ux.js";
import type { MessageHandler } from "./message-handler.js";
import type { ThreadManager } from "./threading.js";
import type { AskUserMirror } from "./ask-user-mirror.js";
import type { SessionIntegrator } from "./session-integration.js";
import type { MatrixConfig, MatrixMessage } from "./types.js";
import type { MatrixLogger } from "./logger.js";
import type { VoiceTranscriber } from "./voice.js";

/** One room notice per stale-drop burst, not one per message. */
const STALE_REPORT_DEBOUNCE_MS = 3_000;

export interface InboundDeps {
  /** The stack's config — the instance is rebuilt with the stack on
   *  /matrix-switch, so a captured cfg is always the current one. */
  cfg: MatrixConfig;
  logger: MatrixLogger;
  /** The stable entry-point API (`pi.sendUserMessage` dispatch,
   *  `pi.getCommands` relay lookups). Registration never moves — only
   *  the funnel itself is rebuilt. */
  pi: ExtensionAPI;
  threadManager: ThreadManager;
  /** The RPIV ask-user mirror (dual-surface decision bridge). */
  mirror: AskUserMirror;
  /** The room-UX aggregation (pickers + auto-replies). */
  roomUx: RoomUx;
  messageHandler: MessageHandler;
  sessionIntegrator: SessionIntegrator;
  /** Voice-message transcription — the `m.audio`/`m.voice`
   *  leg hands the message here and stops the funnel. */
  voiceTranscriber: VoiceTranscriber;
}

export interface Inbound {
  /** `m.reaction` events — mirror consume only; a miss just drops
   *  (reactions are never chat). */
  dispatchReaction(reaction: { reactionKey?: string; isFromPi: boolean }): void;
  /** The single room-event dispatch point (the funnel legs above). */
  dispatch(message: MatrixMessage): void;
}

export function createInbound(deps: InboundDeps): Inbound {
  const { cfg, logger, pi, threadManager, mirror, roomUx, messageHandler, sessionIntegrator, voiceTranscriber } = deps;

  // Stale-message guard (2026-10-25: hours-old room messages streamed into a
  // fresh session as if the user had said them now). matrix-js-sdk reports an
  // event as live when it lands on the live timeline
  // (event-timeline-set.js: `liveEvent: !toStartOfTimeline && timeline ==
  // this.liveTimeline && !fromCache`), which is true for the first sync's
  // backfill chunk and for every limited-timeline gap filled after a
  // disconnect — so the seed-baseline pass cannot catch them, and the seen-id
  // dedupe only knows events THIS client processed. Anything older than
  // `maxMessageAgeMinutes` drops here (before thread adoption, so a stale
  // message cannot re-route the session), gets one warn line each, and is
  // reported to the room as a single notice per burst.
  const staleAgeMs = (cfg.maxMessageAgeMinutes ?? 30) * 60_000;
  const staleDrops: MatrixMessage[] = [];
  let staleFlush: ReturnType<typeof setTimeout> | null = null;
  const flushStaleDrops = () => {
    staleFlush = null;
    const dropped = staleDrops.splice(0);
    if (dropped.length === 0) return;
    const listed = dropped.slice(0, 10);
    const perLine = (m: MatrixMessage, anchor: (m: MatrixMessage) => string) =>
      `${new Date(m.timestamp).toISOString().slice(11, 19)} UTC ${m.body.replace(/\s+/g, " ").trim().slice(0, 80)}${m.threadRoot ? ` (thread ${m.threadRoot})` : ""} ${anchor(m)}`;
    const plain = listed
      .map((m) => perLine(m, (x) => `[${x.eventId}](https://matrix.to/#/${x.roomId}/${x.eventId})`))
      .join(", ");
    // Clickable in Matrix clients: the plain markdown above only renders as
    // a link when sendFormatted is on; the explicit html always ships.
    const html = listed
      .map((m) =>
        perLine(
          m,
          (x) =>
            `<a href="https://matrix.to/#/${encodeURIComponent(x.roomId)}/${encodeURIComponent(x.eventId)}">${escapeHtml(x.eventId)}</a>`,
        ),
      )
      .join("<br>");
    const more = dropped.length > listed.length ? ` +${dropped.length - listed.length} more` : "";
    const header = `⚠️ Dropped ${dropped.length} message(s) that were pending in this room but older than ${Math.round(staleAgeMs / 60_000)} min${more}. They were never delivered to Pi — resend if they still matter:`;
    void messageHandler
      .post(`${header} ${plain}`, "other", { html: `${header}<br>${html}`, flat: true })
      .catch(() => undefined);
  };

  // Flood guard (story 6 trust boundary): the stale guard bounds a message's
  // AGE; this bounds the RATE. A room flooding events must not enqueue
  // unbounded work in the session — beyond FLOOD_CAP human messages per
  // window they are dropped, once visibly. The cap is deliberately not a
  // config key: it is a safety limit, not a preference.
  const FLOOD_WINDOW_MS = 60_000;
  const FLOOD_CAP = 30;
  let recentHuman: number[] = [];
  const floodDrops: MatrixMessage[] = [];
  let floodFlush: ReturnType<typeof setTimeout> | null = null;
  const flushFloodDrops = () => {
    floodFlush = null;
    if (!floodDrops.length) return;
    const n = floodDrops.length;
    floodDrops.length = 0;
    const header = `⚠️ Dropped ${n} message(s) beyond the room rate limit (${FLOOD_CAP} per minute). They were never delivered to Pi — resend if they still matter.`;
    void messageHandler.post(header, "other", { flat: true }).catch(() => undefined);
  };

  // The file-attach injection helper: same normal-injection
  // path as the fallthrough below — keeps attribution, decision-response
  // detection, and the renderer.
  const injectExpanded = (matrixMessage: MatrixMessage, expanded: string) => {
    openThreadForRoomTurn(matrixMessage.body ?? "");
    const expandedMessage: MatrixMessage = {
      ...matrixMessage,
      body: expanded,
      formattedBody: undefined, // plain expansion, not the original HTML
    };
    const piMessage = messageHandler.handleIncomingMessage(expandedMessage);
    if (piMessage) {
      sessionIntegrator.injectMatrixMessage(expandedMessage, piMessage);
    }
  };

  // Thread root opened FROM the room (roadmap 0.9.1): when the session has
  // no root yet and the conversation starts here (flat message in the room,
  // not inside a thread — adoption above handled the threaded case), the
  // thread opens with the ask as its topic. Without this the first outgoing
  // send creates the bare `🧵 New Conversation` root and the ask stays
  // outside the thread. Fire-and-forget: the root write lands long before
  // an LLM answer can; a lost race degrades to the old bare-root behaviour
  // (ensureThreadRoot is idempotent on an existing root).
  const openThreadForRoomTurn = (body: string) => {
    if (threadManager.enabled() && threadManager.pending() && body.trim()) {
      void threadManager.ensureThreadRoot(body).catch(() => undefined);
    }
  };

  return {
    dispatchReaction(reaction) {
      // RPIV ask-user mirror: a room reaction behaves exactly like typing
      // that emoji into the room (same parse grammar, FE0F-normalized). The
      // one deliberate difference: room text that fails the grammar falls
      // through to normal chat injection, while a reaction that fails it
      // just drops (reactions are never chat). Closed mirror → no-op.
      if (
        cfg.mirrorAskUser !== false &&
        !reaction.isFromPi &&
        mirror.tryConsumeReply(reaction.reactionKey ?? "")
      ) {
        // consumed by the mirror — nothing left to do (reactions never
        // become chat).
      }
    },

    dispatch(matrixMessage) {
      // Machine traffic FIRST, before thread adoption: a sibling pi session's
      // broadcast (shared account: the sender match can't filter it — every
      // surviving event is forced isFromPi=false) must neither re-route this
      // session into the sibling's thread nor become a prompt. The body
      // prefix is the only reliable marker. A genuine human reply never opens
      // with one of pi's own broadcast prefixes.
      if (isPiMachineTraffic(matrixMessage.body ?? "", cfg)) {
        logger.debug(
          `[matrix] ${matrixMessage.eventId} dropped: pi machine traffic (sibling session broadcast)`,
        );
        return;
      }
      // Staleness BEFORE anything else acts on the message (see the guard
      // setup above). A missing timestamp (0) is not judged — deliver it.
      if (
        staleAgeMs > 0 &&
        !matrixMessage.isFromPi &&
        matrixMessage.timestamp > 0 &&
        Date.now() - matrixMessage.timestamp > staleAgeMs
      ) {
        staleDrops.push(matrixMessage);
        logger.warn(
          `[matrix] ${matrixMessage.eventId} dropped as stale: ${Math.round((Date.now() - matrixMessage.timestamp) / 60_000)} min old (limit ${Math.round(staleAgeMs / 60_000)} min)`,
        );
        if (staleFlush !== null) clearTimeout(staleFlush);
        staleFlush = setTimeout(flushStaleDrops, STALE_REPORT_DEBOUNCE_MS);
        return;
      }
      // Flood guard: rate, not age (see the guard setup above). Pi's own
      // broadcasts never count — the limit protects the session from the
      // room, never from itself.
      if (!matrixMessage.isFromPi) {
        const now = Date.now();
        recentHuman = recentHuman.filter((t) => now - t < FLOOD_WINDOW_MS);
        if (recentHuman.length >= FLOOD_CAP) {
          floodDrops.push(matrixMessage);
          logger.warn(
            `[matrix] ${matrixMessage.eventId} dropped: room rate limit (${FLOOD_CAP}/min) exceeded`,
          );
          if (floodFlush !== null) clearTimeout(floodFlush);
          floodFlush = setTimeout(flushFloodDrops, STALE_REPORT_DEBOUNCE_MS);
          return;
        }
        recentHuman.push(now);
      }
      // Threading adoption (threads-and-summaries.md): the user's reply carries a
      // thread root (it happened in a thread, e.g. in Element) → that thread
      // becomes this session's thread. Adoption is NOT gated on `pending()`:
      // a user reply in a thread different from the active one re-routes the
      // session there (follow the user, not just the first thread), so the
      // session stays with whichever thread the user is in. No effect when
      // the message is already in the active thread (threads-and-summaries.md: one Pi session
      // per instance).
      if (
        threadManager.enabled() && !matrixMessage.isFromPi && matrixMessage.threadRoot &&
        matrixMessage.threadRoot !== threadManager.activeRoot()?.eventId
      ) {
        threadManager.adoptRoot(matrixMessage.threadRoot);
      }

      // Voice message (m.audio/m.voice, Element): transcribe async →
      // inject the transcript as the sender's text. Same
      // leg shape as the file-attach expansion below: the normal
      // injection path keeps attribution, decision-response detection,
      // and the renderer. The async work owns the message — the funnel
      // stops. SSS-encrypted media (E2EE rooms) cannot be decrypted on
      // this device: one room notice instead of a silently dropped msg.
      if (
        cfg.voiceTranscription !== false &&
        !matrixMessage.isFromPi &&
        (matrixMessage.msgtype === "m.audio" || matrixMessage.msgtype === "m.voice")
      ) {
        void voiceTranscriber
          .transcribe(matrixMessage)
          .then((r) => {
            if (r.text) {
              injectExpanded(matrixMessage, `[voice] ${r.text}`);
              return;
            }
            if (r.sss) {
              void messageHandler
                .post(
                  "⚠️ Voice message received, but this device cannot decrypt its media (E2EE SSS). Send it from a non-E2EE room, or enable encrypted attachments (MSC4125) in the sending client.",
                  "other",
                  { flat: true },
                )
                .catch(() => undefined);
              return;
            }
            logger.warn(`[matrix] ${matrixMessage.eventId} voice transcription produced no transcript (dropped)`);
          })
          .catch((error) =>
            logger.warn(`[matrix] ${matrixMessage.eventId} voice transcription error: ${error}`),
          );
        return;
      }

      // RPIV ask-user mirror: while a RPIV questionnaire is blocked on
      // input, a reply in option format answers it (emits
      // `rpiv:ask-user:answer`) and is consumed, NOT injected into the
      // session. Non-matching text falls through to normal injection (the
      // user may still chat).
      if (
        cfg.mirrorAskUser !== false &&
        !matrixMessage.isFromPi &&
        mirror.tryConsumeReply(matrixMessage.body ?? "")
      ) {
        logger.debug(`[matrix] ${matrixMessage.eventId} consumed by ask-user mirror (not injected)`);
        return;
      }

      // Slash relay: a room-typed /command dispatches exactly as
      // if typed in the composer. Unknown names with fuzzy candidates get
      // a plain-text suggestion reply in the room (a Matrix poll is
      // the later transport); names with no candidates fall through to
      // normal injection so the LLM sees them as plain text.
      if (cfg.slashRelay && !matrixMessage.isFromPi) {
        // Agent-directed help ("help" or "@pi_agent: help") routes to the
        // help command under the hood — same effect as typing /pi-help in
        // the room.
        if (isAgentHelp((matrixMessage.body ?? "").trim(), [localpartOf(cfg.userId ?? "")])) {
          pi.sendUserMessage("/matrix-help", {
            deliverAs: "followUp",
            expandPromptTemplates: true,
          });
          return; // the dispatch owns the turn; do not double-inject
        }
        const cmd = parseCommandLine(matrixMessage.body, cfg.slashCommandPrefix ?? "/");
        if (cmd) {
          const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
          if (findCommand(cmd.name, commands)) {
            pi.sendUserMessage((matrixMessage.body ?? "").trim(), {
              deliverAs: "followUp",
              expandPromptTemplates: true,
            });
            return; // the dispatch owns the turn; do not double-inject
          }
          const candidates = fuzzyCommandCandidates(cmd.name, commands);
          if (candidates.length > 0) {
            roomUx.replySuggestion(cmd.name, candidates);
            return;
          }
        }
      }

      // @@ artifact attach  + @ file attach: the RoomUx
      // aggregation owns the picker logic + auto-replies ;
      // a consumed message stops the funnel.
      if (roomUx.handleArtifactAttach(matrixMessage)) {
        return;
      }
      if (
        roomUx.handleFileAttach(matrixMessage, (expanded) => injectExpanded(matrixMessage, expanded))
      ) {
        return;
      }

      // Decision responses resolve the matching tool call; everything else
      // is injected into the session as an attributed custom message.
      const piMessage = messageHandler.handleIncomingMessage(matrixMessage);
      if (piMessage) {
        openThreadForRoomTurn(matrixMessage.body ?? "");
        sessionIntegrator.injectMatrixMessage(matrixMessage, piMessage);
        logger.debug(
          `[matrix] injected into session: ${matrixMessage.eventId} (${(matrixMessage.body ?? "").length} chars, followUp, triggerTurn)`,
        );
      } else {
        logger.debug(`[matrix] ${matrixMessage.eventId} not injected (handleIncomingMessage returned null)`);
      }
    },
  };
}
