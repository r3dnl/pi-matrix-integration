import { escapeHtml } from "./markdown.js";

/**
 * AskUserMirror — the Matrix half of the dual-surface RPIV decision bridge.
 *
 * @juicesharp/rpiv-ask-user-question (>= 2.13, native answer channel) emits
 * `rpiv:ask-user:prompt` (the questionnaire) and `rpiv:ask-user:blocked`
 * (wait open/closed) on Pi's shared event bus while its `ask_user_question`
 * tool is parked on TUI input. This module mirrors the prompt into the
 * Matrix room so the user can answer from the phone, and turns room replies
 * back into ONE `rpiv:ask-user:answer` emission — the upstream channel is
 * all-or-nothing (a partial set is refused with an `invalid_answer` verdict),
 * so answers are BUFFERED here and shipped as a single complete set when the
 * room confirms. Whichever surface completes first wins; every attempt gets
 * a verdict on `rpiv:ask-user:answer-result`. The terminal stays fully
 * usable throughout (a room answer no longer moves the terminal's tab —
 * the upstream channel bypasses the TUI).
 *
 * Reply grammar (documented in the posted questionnaire):
 * - "2"              → option 2 for the first unanswered question
 * - "Q2: 3"          → option 3 for question 2 (1-based `Q` prefix optional:
 *                      "2: 3" works too)
 * - "2 3" / "2,3"    → multi-select: options 2 and 3 (multi-select question);
 *                      single-select questions get one number per remaining
 *                      unanswered question instead ("2 3" → Q1=2, Q2=3) when
 *                      the count matches exactly — regardless of whether each
 *                      number is in range for the current question
 * - "A label"        → exact option label (case-insensitive)
 * - "👍"/"✅"/"✔"   → the single option with a yes-ish label ("Yes", "Approve",
 *                      "Accept", …); "👎"/"❌"/"✖" → the single option with a
 *                      no-ish label ("No", "Reject", "Decline", …). A question
 *                      whose options carry no yes/no-ish label (or whose label
 *                      matches more than one option) gets the grammar nudge.
 *                      Emoji-picker variants are accepted: U+FE0F/
 *                      U+FE0E variation selectors are stripped before any
 *                      alias or confirm-word match.
 * - Reactions (m.reaction): a room reaction by the user is parsed exactly
 *                      like the reaction key typed into the room (the
 *                      client dispatches it to the same consume path; the
 *                      FE0F keys Element inserts in reactions are
 *                      normalized too). The one difference: a room reply
 *                      that fails the grammar may fall through to chat
 *                      injection; a reaction that fails it just drops.
 * - "Custom: text"   → custom answer (`Custom:`/`Text:` prefix required, so
 *                      ordinary chat while the mirror is open still falls
 *                      through to normal injection)
 * - Poll taps (MSC3381 responses, extensible wire format, configuration-and-room-behaviour.md in
 *          configuration-and-room-behaviour.md): each eligible single-select question ALSO
 *          ships as a native poll whose answers carry ids ("1", "2", …);
 *          a tap is resolved through the poll's own answer list (id →
 *          label; legacy label refs fall back to label matching) and
 *          parsed exactly like a room reply of that label (same shared
 *          apply path, same acks/review). Both single- and multi-select
 *          questions ship as polls (a multi-select poll allows one vote
 *          per option; the client sends all selected answer ids in one
 *          response); custom answers stay on the text grammar. A poll
 *          tap never becomes chat.
 * Segments separate questions: newlines or ";".
 * A reply that looks like an intended answer but fails the grammar (an
 * out-of-range "Q1: 4", a bare "5", …) gets a 📝 grammar nudge posted to
 * the room and is consumed — it is not injected as chat. Genuine chat
 * (free prose) keeps falling through to normal injection.
 *
 * Emissions are per-questionnaire for the MODEL, per-reply for the
 * TERMINAL DISPLAY: the mirror buffers every parsed room reply locally
 * (acks 📝 N/M are room-side progress) and ships each buffer change to the
 * mounted terminal as a display-only PARTIAL set (patch A2.13-0001, requestId
 * `matrix-partial-*`) so the TUI tab follows the room question by question.
 * Nothing reaches the model until confirm emits the ONE complete set — the
 * upstream channel is all-or-nothing for real answers. Emissions after the
 * wait ends get a `not_found` verdict, which the mirror ignores (the terminal
 * surface won the race; `onBlocked(false)` closes it right after).
 *
 * Review step (room-owned, replaces the TUI review tab for the room flow):
 * when the buffered answers complete the set, the mirror posts a review of
 * everything buffered — nothing has been sent yet. "confirm" (also
 * "done"/"submit"/"✓"/"✔"/"☑"/"👍"/"✅") emits the complete answer set
 * (`rpiv:ask-user:answer`, option indexes) — the package resolves the wait
 * immediately. "Qn: x" / "Custom: text" corrects the buffer and edits the
 * review in place. A bare "👎"/"❌"/"✖" at the review step EMITS
 * `cancel: true` — the upstream channel's decline path (what Esc does in the
 * TUI): the model is told the user declined. If the terminal answers first,
 * `onBlocked(false)` closes the mirror and the buffered review is dropped;
 * a late confirm's emission is refused (`not_found`) and ignored. Each
 * question's table also offers the TUI's "Type something." row — answered
 * in the room as "Custom: free text".
 */

/** One authored question, mirroring the package's `AskUserPromptQuestion`
 *  (loosely typed: payloads are append-only per the rpiv event contract). */
export interface MirrorQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; hasPreview?: boolean }[];
}

/** One entry in a room-parsed answer set (the mirror's internal shape —
 *  label-based, so parsing and the review render without re-lookup). */
export interface MirrorAnswerEntry {
  questionIndex: number;
  kind: "option" | "custom" | "multi";
  answer?: string | null;
  selected?: string[];
}

/** One entry of the upstream `rpiv:ask-user:answer` payload (2.13+):
 *  option INDEXES (not labels) and/or custom text. */
export interface UpstreamAnswerEntry {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
}

/** The `rpiv:ask-user:answer` payload the mirror emits. */
export interface MirrorAnswerPayload {
  toolCallId: string;
  /** Echoed on the verdict (`answer-result`) so the mirror can pair it. */
  requestId: string;
  /** Omitted (or empty) only with `cancel`. */
  answers?: UpstreamAnswerEntry[];
  /** Decline the questionnaire, as Esc does in the TUI. */
  cancel?: boolean;
  /** Patch A2.13-0001: display-only — registers into the mounted terminal
   *  dialog (tab follows the room) without resolving the wait. Emitted per
   *  room reply; the authoritative answer is the complete flagless set on
   *  confirm. */
  partial?: boolean;
}

/** Answer-result verdict (`AskUserAnswerResultEventPayload`, loosely typed —
 *  payloads are append-only per the rpiv event contract). */
export interface MirrorAnswerVerdict {
  ok: boolean;
  code?: string;
  reason?: string;
  /** Echoed from the request — `matrix-partial-*` marks display-sync
   *  emissions, whose verdicts carry no consequence for the room flow. */
  requestId?: string;
}

/** One entry of `rpiv:ask-user:answers-state` (`AskUserAnswersStateEntry`,
 *  the package's `QuestionAnswer` shape — same fields the mirror buffers). */
export interface MirrorAnswersStateEntry {
  questionIndex: number;
  kind: "option" | "custom" | "multi";
  answer?: string | null;
  selected?: string[];
}

/** `rpiv:ask-user:answers-state` payload (patch A2.13-0002, loosely typed). */
export interface MirrorAnswersStatePayload {
  toolCallId?: string;
  answers?: readonly MirrorAnswersStateEntry[];
}

export interface AskUserMirrorDeps {
  /** Post a message to the active thread/room through the outgoing
   *  pipeline (MessageHandler): markdown only — the pipeline converts it
   *  (`convertMarkdown` under the global `sendFormatted` gate) and
   *  dedupes per its own window. Failure is non-fatal. */
  post: (text: string) => Promise<{ success: boolean; error?: string }>;
  /** Post and return the sent event id (the living review post tracks it
   *  for in-place edits). Optional — the mirror falls back to `post` (no
   *  event id, so the review re-posts instead of editing). */
  postResult?: (text: string) => Promise<{ success: boolean; eventId?: string; error?: string }>;
  /** Edit one of the mirror's own messages in place (m.replace). Optional —
   *  without it the review re-posts instead of editing. */
  edit?: (targetEventId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** Matrix connection live (isEnabled). Prompt mirrors only when true. */
  isEnabled: () => boolean;
  /** Emit one answer payload onto the shared bus (`rpiv:ask-user:answer`,
   *  upstream 2.13+ contract + patch A2.13-0001): a display-sync partial set
   *  per room reply (`partial: true`, terminal tab follows), ONE complete
   *  answer set on confirm, or `cancel: true` on a review-step decline. The
   *  package validates and answers every attempt on `answer-result`. */
  emitAnswer: (payload: MirrorAnswerPayload) => void;
  /** Post a native Matrix poll (MSC3381 poll.start, extensible format)
   *  for one question — the tappable sugar alongside the text
   *  questionnaire. `answers` carry stable ids (the tap votes by id);
   *  returns the poll event id on success. Thread routing is the
   *  caller's concern (active thread root read at call time). */
  postPoll?: (
    question: string,
    answers: { id: string; label: string }[],
    maxSelections?: number,
  ) => Promise<{ success: boolean; eventId?: string; error?: string }>;
  /** Close one posted poll (MSC1767 poll.end) — best effort, fire-and-
   *  forget (the room stops accepting taps pi will ignore). */
  endPoll?: (pollEventId: string) => Promise<unknown>;
  /** Cast/replace PI's own vote on one of pi's polls (MSC3381
   *  poll.response — clients count each voter's latest response, so a
   *  re-vote replaces and empty `answerIds` retracts). This is how a
   *  TERMINAL-side answer becomes visible in the poll: it has no room
   *  event of its own for a tap/reaction to sit on. Optional — without
   *  it pi never votes (the living message stays the only record).
   *  `labels` are for the timeline fallback text only (ids vote). */
  sendPollVote?: (
    pollEventId: string,
    answerIds: string[],
    labels: string[],
  ) => Promise<{ success: boolean; error?: string }>;
  /** The polls switch (config `mirrorAskUserPolls`), call-time read —
   *  switch-current like `isEnabled` (a /matrix-switch rebuild must not
   *  leave a stale captured flag). */
  pollsEnabled?: () => boolean;
  warn?: (message: string) => void;
}

export interface AskUserMirror {
  /** `rpiv:ask-user:prompt` handler: open the mirror + post the questionnaire.
   *  `toolCallId` names the questionnaire on the answer channel — without it
   *  no emission can address the wait (upstream requires it). */
  onPrompt(questions: MirrorQuestion[], toolCallId?: string): Promise<void>;
  /** `rpiv:ask-user:blocked` handler: close the mirror when the wait ends. */
  onBlocked(active: boolean): void;
  /** `rpiv:ask-user:answer-result` handler: a rejected emission re-arms the
   *  review with the reason posted to the room; ok/not_found are ignored
   *  (ok → blocked(false) closes the mirror; not_found → the terminal
   *  surface already resolved the wait). */
  onAnswerResult(verdict: MirrorAnswerVerdict): void;
  /** `rpiv:ask-user:answers-state` handler (patch A2.13-0002): merge the
   *  dialog's registered answers — terminal keystrokes AND echoes of the
   *  mirror's own partials — into the room buffer, so a terminal-side
   *  answer ARMS the room review instead of silently completing the set.
   *  Full map, per-question idempotent; the map never shrinks, so absence
   *  is never a clear. */
  onAnswersState(payload: MirrorAnswersStatePayload): void;
  /** Poll tap handler (MSC3381 response): answer the question the poll
   *  was posted for through the same path a parsed room reply takes.
   *  `refs` are the tapped answer ids (or labels for legacy MSC1767
   *  voters — the mirror resolves both). Returns true when the tap
   *  consumed a live mirror. */
  onPollResponse(pollEventId: string, refs: string[]): boolean;
  /** True when `body` consumed a live mirror (do not inject it into Pi). */
  tryConsumeReply(body: string): boolean;
  isOpen(): boolean;
}

export function createAskUserMirror(deps: AskUserMirrorDeps): AskUserMirror {
  let questions: MirrorQuestion[] = [];
  let open = false;
  /** The open questionnaire's tool-call id — required to address it on the
   *  answer channel. Empty until a prompt event carries one. */
  let toolCallId = "";
  /** True between emitting the answer set and the mirror closing: an
   *  `invalid_*` verdict in that window re-arms the review. */
  let awaitingVerdict = false;
  /** Answers buffered per question index — the mirror's own progress view
   *  for the room acks (📝 N/M / ✅). Nothing reaches the package until
   *  confirm ships the complete set (the channel refuses partial sets). */
  let buffer = new Map<number, MirrorAnswerEntry>();
  /** All N answers buffered via the room; the review step is armed when
   *  the completing reply lands — the room owns the review from there:
   *  "confirm" emits the complete set, "👎" emits cancel. */
  let reviewPending = false;
  /** The LIVING message's event id (the in-place edit target): ONE room
   *  message carries the in-flight flow — the status line ("Answer noted
   *  1/2…"), the ⌨️ terminal-progress ack, and the review — each update
   *  EDITS the same message instead of stacking a new one. Reset on
   *  close/re-prompt; a failed edit falls back to a fresh post (the old
   *  text stays, cosmetic). */
  let liveMsgId: string | null = null;
  /** The living message's first post's settled promise — concurrent
   *  changes chain onto it (edit after settle) instead of creating a
   *  second message. Null when no post is in flight / none has been made. */
  let liveFirstPost: Promise<{ success: boolean; eventId?: string; error?: string } | null> | null = null;
  /** Poll event id per question index (one poll per eligible question, configuration-and-room-behaviour.md). */
  let pollByQuestion = new Map<number, string>();
  /** Question index per poll event id — the reverse map a tap routes
   *  through (the response carries the poll's event id, not the index). */
  let questionByPoll = new Map<string, number>();
  /** The poll's own answer list (id → label) per poll event id — the tap
   *  votes by answer id, so the label comes from the poll we posted,
   *  not from re-matching the room text. */
  let answersByPoll = new Map<string, { id: string; label: string }[]>();

  function close(): void {
    open = false;
    questions = [];
    toolCallId = "";
    awaitingVerdict = false;
    buffer = new Map();
    reviewPending = false;
    liveMsgId = null;
    // Close the polls (poll.end): the room stops accepting taps the mirror
    // would drop anyway — the phone UI shows the poll as ended instead of
    // silently dead. Best effort: a failed end is a cosmetic gap.
    for (const pollEventId of pollByQuestion.values()) {
      void deps.endPoll?.(pollEventId).catch(() => undefined);
    }
    pollByQuestion = new Map();
    questionByPoll = new Map();
    answersByPoll = new Map();
  }

  async function onPrompt(newQuestions: MirrorQuestion[], newToolCallId?: string): Promise<void> {
    if (!deps.isEnabled() || !Array.isArray(newQuestions) || newQuestions.length === 0) {
      close();
      return;
    }
    // A re-prompt supersedes the old one: close() ends the superseded polls
    // (they would stay votable in the room but route nowhere) and resets
    // the state; a first prompt runs it on empty maps (no-ops).
    close();
    questions = newQuestions;
    toolCallId = typeof newToolCallId === "string" ? newToolCallId : "";
    buffer = new Map();
    reviewPending = false;
    liveMsgId = null;
    pollByQuestion = new Map();
    questionByPoll = new Map();
    answersByPoll = new Map();
    open = true;
    // configuration-and-room-behaviour.md: the mirror ships GFM pipe-table markdown only — no
    // pre-computed HTML (the third copy-pasted conversion site is gone).
    // The pipeline converts markdown → `formatted_body` under the
    // `sendFormatted` gate; plain clients render the pipe table.
    const result = await deps.post(formatQuestionnaireMd(questions));
    if (!result.success) {
      deps.warn?.(`[matrix] ask-user mirror post failed: ${result.error || "unknown error"}`);
      // Stay open: the terminal surface still works, and a later prompt
      // event (or /matrix-connect) re-posts.
    }
    // Polls: each eligible question ALSO ships as a
    // tappable poll — the tap is a third answer surface for the same
    // reducer (onPollResponse → applyEntries). Multi-select questions
    // post multi-vote polls (max_selections = number of options); the
    // client collects the selection and sends all answer ids in one
    // response. The text questionnaire stays in full: it carries the
    // grammar, the custom-answer row, and the fallback when a poll post
    // fails (polls are additive, never a replacement). Sequential (one
    // poll per question, room order stays tidy); `open` re-checked per
    // post — a decision answered in the terminal during the loop stops
    // the loop.
    if (deps.pollsEnabled?.() && deps.postPoll) {
      void (async () => {
        for (let i = 0; i < questions.length; i++) {
          if (!open) break; // the decision resolved mid-loop
          const q = questions[i];
          const options = (q.options ?? []).map((o) => o.label);
          if (options.length < 2 || options.length > 10) continue; // MSC3381 caps
          // Answer ids are the option numbers ("1", "2", …) — self-
          // documenting in the raw event, and the tap resolves through
          // answersByPoll, never against the room text. Multi-select
          // polls allow one vote per option.
          const maxSelections = q.multiSelect === true ? options.length : 1;
          const answers = (q.options ?? []).map((o, j) => ({ id: String(j + 1), label: o.label }));
          const res = await deps.postPoll!(q.question, answers, maxSelections);
          if (!res.success) {
            deps.warn?.(`[matrix] decision poll post failed: ${res.error || "unknown error"}`);
            continue; // the text grammar still covers this question
          }
          if (res.eventId) {
            pollByQuestion.set(i, res.eventId);
            questionByPoll.set(res.eventId, i);
            answersByPoll.set(res.eventId, answers);
          }
        }
      })();
    }
  }

  function onBlocked(active: boolean): void {
    if (!active) {
      close();
    }
  }

  function onAnswerResult(verdict: MirrorAnswerVerdict): void {
    // Display-sync verdicts (patch A2.13-0001) carry no consequence: a
    // refused partial is a cosmetic desync, the complete set is the gate.
    if (typeof verdict.requestId === "string" && verdict.requestId.startsWith("matrix-partial-")) return;
    // After the wait ends the mirror closes via blocked(false); verdicts for
    // a closed mirror (and ok verdicts) need nothing.
    if (!open || verdict.ok) return;
    // not_found: the terminal surface resolved the wait between our emission
    // and this verdict (or the emission raced the close) — the decision is
    // made, stay quiet. invalid_*/unsupported_host: OUR emission was refused
    // while the wait is still open — recover loudly.
    if (verdict.code === "not_found") return;
    void deps
      .post(`⚠️ Pi refused the answers: ${verdict.reason || verdict.code || "unknown"}. Correct with "Qn: x" and confirm again.`)
      .catch(() => undefined);
    if (awaitingVerdict) {
      awaitingVerdict = false;
      reviewPending = true;
      postReview();
    }
  }

  function tryConsumeReply(body: string): boolean {
    if (!open) return false;
    // Strip variation selectors (\uFE0E/\uFE0F): emoji pickers and mobile
    // clients send ✅/✔ with a trailing U+FE0F — normalized, the variants
    // match the same aliases as bare codepoints.
    const text = normalizeDecisionReply((body ?? "").trim());
    if (text.length === 0) return false;
    // Review step: an armed review sends on "confirm"/"done"/"👍"/"✅" —
    // ONE complete-set emission on the answer channel; the package resolves
    // the wait. Corrections edit the buffer + review without emitting.
    if (reviewPending && /^(?:confirm|done|submit|✓|✔|☑|👍|✅)$/i.test(text)) {
      if (!emitComplete()) return true; // guard posted the failure; review stays armed
      reviewPending = false;
      void deps
        .post(`✅ Answer received (${buffer.size}/${questions.length}) — proceeding.`)
        .catch(() => undefined);
      return true;
    }
    // Review step: a bare reject emoji (👎/❌) declines the questionnaire —
    // the upstream channel's cancel path (what Esc does in the TUI): the
    // model is told the user declined.
    if (reviewPending && /^(?:👎|❌|✖|✗)$/.test(text)) {
      if (toolCallId.length === 0) {
        void deps
          .post(`👎 Not confirmed — no questionnaire id to decline. Correct with "Qn: x", or confirm with "confirm" / "👍".`)
          .catch(() => undefined);
        return true;
      }
      awaitingVerdict = true;
      deps.emitAnswer({ toolCallId, requestId: `matrix-${toolCallId}`, cancel: true });
      reviewPending = false;
      void deps
        .post(`👎 Declined — Pi was told you declined the questionnaire.`)
        .catch(() => undefined);
      return true;
    }
    const entries = parseMirrorReply(text, questions, new Set(buffer.keys()));
    if (entries.length === 0) {
      // An intended answer that failed the grammar gets a room nudge and is
      // consumed (it must not be injected as ordinary chat); genuine chat
      // keeps falling through to normal injection.
      if (looksLikeReplyAttempt(text)) {
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 80);
        const grammar =
          `📝 "${preview}${text.length > 80 ? "…" : ""}" didn't parse as an answer. ` +
          'Reply grammar: "2" or "2 3" (multi), "Q2: 3", or "Custom: free text"; ' +
          'yes/no options: "👍"/"👎" (or "✅"/"❌"). ' +
          'several questions: one number each ("2 3") or "1: 2; 2: 3". ' +
          (reviewPending ? 'Review is pending: "confirm"/"👍" to proceed, or ' : '') +
          `${[...questions.keys()].map((i) => `Q${i + 1} has ${questions[i].options?.length ?? 0} option${questions[i].options?.length === 1 ? "" : "s"}${questions[i].multiSelect ? " (multi)" : ""}`).join(", ")}.`;
        void deps.post(grammar).catch(() => undefined);
        return true;
      }
      return false; // not an answer — normal injection
    }
    applyEntries(entries);
    return true;
  }

  /** Emit the buffered answers as ONE complete set on the answer channel.
   *  Returns false (with a room post explaining) when emission is
   *  impossible: no tool-call id, or a buffered entry no longer maps to an
   *  option (a stale prompt — the room must re-read the questionnaire). */
  function emitComplete(): boolean {
    if (toolCallId.length === 0) {
      void deps
        .post(`⚠️ This Pi build's questionnaire carries no tool-call id — the room cannot relay answers. Answer in the terminal.`)
        .catch(() => undefined);
      return false;
    }
    const answers = toUpstreamEntries(
      [...buffer.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e),
      questions,
    );
    if (answers.length !== questions.length) {
      void deps
        .post(`⚠️ An answer no longer matches the questionnaire's options — re-read the posted questions and correct with "Qn: x".`)
        .catch(() => undefined);
      return false;
    }
    awaitingVerdict = true;
    deps.emitAnswer({ toolCallId, requestId: `matrix-${toolCallId}`, answers });
    return true;
  }

  /** Patch A2.13-0001: push the current buffer onto the answer channel as a
   *  DISPLAY-ONLY partial set — the mounted terminal dialog registers it and
   *  its tab follows the room (next unanswered question; review tab when
   *  complete). Never resolves the wait. Best effort: no tool-call id, an
   *  unmounted dialog (channel drops it), or a refused set (verdict ignored)
   *  all leave the room flow untouched — the authoritative answer is the
   *  complete set confirm ships. `clearedIndexes` ride as empty entries
   *  (the patch's clear marker: a question with neither indexes nor text).
   *  Full-snapshot per reply: the dialog replaces per question, so the
   *  display converges on the buffer no matter which replies landed. */
  function emitPartial(clearedIndexes: number[]): void {
    if (toolCallId.length === 0) return;
    const answers = toUpstreamEntries(
      [...buffer.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e),
      questions,
    );
    for (const i of clearedIndexes) {
      if (!answers.some((a) => a.questionIndex === i)) answers.push({ questionIndex: i });
    }
    if (answers.length === 0) return;
    deps.emitAnswer({ toolCallId, requestId: `matrix-partial-${toolCallId}`, partial: true, answers });
  }

  /** The shared answer-apply path (room text replies AND poll taps):
   *  buffer, then run the ack/review step. Nothing is emitted per reply —
   *  the upstream channel refuses partial sets, so the complete set ships
   *  once, on confirm. A poll tap is identical in semantics to a parsed
   *  room reply (last write wins, review arms on completion, N=1 skips it). */
  function applyEntries(entries: MirrorAnswerEntry[]): void {
    // An empty multi entry CLEARS the question's answer (the tap toggle-off
    // of the last selection — the Matrix poll protocol has no un-vote, so
    // the mirror reduces the buffered selection locally; nothing was sent
    // yet, so a clear never touches the package).
    const clears = entries.filter((e) => e.kind === "multi" && (e.selected ?? []).length === 0);
    for (const entry of entries) {
      if (entry.kind === "multi" && (entry.selected ?? []).length === 0) buffer.delete(entry.questionIndex);
      else buffer.set(entry.questionIndex, entry);
    }
    // pi's poll vote tracks what pi has ON RECORD for the changed
    // questions — taps and replies already show as the user's own events;
    // the vote keeps the poll agreeing with the buffer on every surface.
    syncPollVotes([...new Set(entries.map((e) => e.questionIndex))]);
    if (buffer.size === questions.length && !reviewPending) {
      // Single SINGLE-SELECT question: the one answer IS the decision —
      // emit the complete set immediately, no review step (a second
      // confirm for a single answer reads as a hang from the room).
      // Multi-select is excluded: a single tap is NOT the final decision —
      // the user may add options (clients emit one response per tap, they
      // merge), so the review step stays the completion gate.
      if (questions.length === 1 && !questions[0]?.multiSelect) {
        if (!emitComplete()) return;
        void deps
          .post(`✅ Answered (${buffer.size}/${questions.length}) — proceeding.`)
          .catch(() => undefined);
        return;
      }
      // Several questions: arm the room-side review step — post the review
      // of the buffer; "confirm" emits, "👎" declines. The partial lands the
      // terminal on its own review tab (display parity).
      reviewPending = true;
      postReview();
      emitPartial(clears.map((e) => e.questionIndex));
      return;
    }
    if (reviewPending && buffer.size < questions.length) {
      // A correction cleared a question (toggle-off of the last selection):
      // the TUI moved back to the question tab — disarm the room-side review
      // step; it re-arms when the set is complete again. The live review
      // (when posted) is swapped IN PLACE for a neutral status — it must not
      // keep showing a confirm hint that no longer works.
      reviewPending = false;
      awaitingVerdict = false;
      const cleared = clears.map((e) => `Q${e.questionIndex + 1}`).join(", ");
      // The living message IS the review right now — editing it back to a
      // status line both closes the review and keeps the trail in one place.
      postLive(
        `📝 ${cleared} selection cleared — tap an option to select. The review re-arms when the set is complete again.`,
      );
      emitPartial(clears.map((e) => e.questionIndex));
      return;
    }
    if (reviewPending) {
      // Correction after the review was posted: edit the review IN PLACE
      // (the room keeps one living review message, not a trail). The buffer
      // change is display-synced to the terminal via a partial set; nothing
      // reaches the model until confirm.
      postReview();
      emitPartial(clears.map((e) => e.questionIndex));
    } else if (clears.length > 0 && entries.length === clears.length) {
      // A pure toggle-off (the last selection unselected before the review
      // armed): say "selection cleared", not "Answer noted (0/N" — the
      // question is now EMPTY, not answered.
      const cleared = clears.map((e) => `Q${e.questionIndex + 1}`).join(", ");
      postLive(`📝 ${cleared} selection cleared — tap an option to select.`);
      emitPartial(clears.map((e) => e.questionIndex));
    } else {
      postLive(
        `📝 Answer noted (${buffer.size}/${questions.length} questions answered) — still waiting: ${[...questions.keys()].filter((i) => !buffer.has(i) && i >= 0).map((i) => `Q${i + 1}`).join(", ")}`,
      );
      emitPartial(clears.map((e) => e.questionIndex));
    }
  }

  /** Poll tap (MSC3381 response): route to the question the poll was
   *  posted for, resolve the tapped answer (by id from the poll's own
   *  answer list; a ref that matches no id is tried as a label — legacy
   *  MSC1767 clients vote by label), apply through the shared path.
   *  Multi-select polls merge each response into the buffered selection
   *  (clients emit one response per tap, see the merge note below).
   *  Guards (all silent drops — a tap never becomes chat): closed mirror,
   *  unknown poll (not ours, or cleared/superseded already), no ref,
   *  a ref matching neither an id nor an option label. */
  function onPollResponse(pollEventId: string, refs: string[]): boolean {
    if (!open) return false;
    const qIdx = questionByPoll.get(pollEventId);
    if (qIdx === undefined) return false;
    const q = questions[qIdx];
    const byId = answersByPoll.get(pollEventId) ?? [];
    // A response can carry MULTIPLE answer refs (multi-vote polls: a
    // client MAY send every selected answer id in one response). Resolve
    // each ref — answer id first (extensible format), legacy label
    // second (MSC1767 voters send the label as the selection) — and
    // apply them as ONE entry for the question: a multi entry when the
    // question is multi-select or more than one ref resolved (a
    // single-select re-vote replaces the buffered entry, it never doubles
    // it; a multi-select re-vote MERGES into it — see below), an option
    // entry for a single-select single-ref response.
    const selected: string[] = [];
    for (const raw of refs) {
      const ref = (raw ?? "").trim();
      if (ref.length === 0) continue;
      const idMatch = byId.find((a) => a.id === ref);
      const option =
        (idMatch ? (q.options ?? []).find((o) => o.label === idMatch.label) : undefined) ??
        (q.options ?? []).find((o) => o.label === ref);
      if (option && !selected.includes(option.label)) selected.push(option.label);
    }
    if (selected.length === 0) return false;
    // Multi-select polls: clients (observed on the phone client 2026-10-13)
    // emit ONE response PER tap instead of a single multi-id response —
    // the MSC3381 max_selections field does not make the phone client
    // collect selections into one response. A re-vote must therefore MERGE
    // into the buffered selection, not replace it (a replace drops the
    // earlier taps and the question ends up single-answered). The merged
    // union is re-emitted; the package reducer's per-question replace then
    // converges to the union.
    if (q.multiSelect === true) {
      const prev = buffer.get(qIdx);
      const prevLabels =
        prev?.kind === "multi" ? prev.selected ?? [] : prev?.kind === "option" && prev.answer ? [prev.answer] : [];
      // A single-ref re-vote of an ALREADY-SELECTED option is a toggle-off
      // (the Matrix poll protocol has no un-vote — a client re-sending the
      // same single answer id is the only re-tap signal). The reduced set
      // is emitted as a replacement; the cleared question (no remainder)
      // goes through as an empty multi entry. A multi-ref response is an
      // exact-set replace (a client collecting selections), never a toggle.
      if (selected.length === 1 && refs.length === 1 && prevLabels.length > 0 && prevLabels.includes(selected[0])) {
        const remaining = prevLabels.filter((l) => l !== selected[0]);
        if (remaining.length > 0) {
          selected.length = 0;
          for (const label of remaining) selected.push(label);
        } else {
          applyEntries([{ questionIndex: qIdx, kind: "multi", answer: null, selected: [] }]);
          return true;
        }
      } else {
        // Multi-select polls: clients (observed on the phone client
        // 2026-10-13) emit ONE response PER tap instead of a single
        // multi-id response — the MSC3381 max_selections field does not
        // make the phone client collect selections into one response. A
        // new tap must therefore MERGE into the buffered selection, not
        // replace it (a replace drops the earlier taps and the question
        // ends up single-answered). The merged union is re-emitted; the
        // package reducer's per-question replace then converges to the
        // union.
        for (const label of prevLabels) {
          if (!selected.includes(label)) selected.push(label);
        }
      }
    }
    applyEntries([
      q.multiSelect === true || selected.length > 1
        ? { questionIndex: qIdx, kind: "multi", answer: null, selected }
        : { questionIndex: qIdx, kind: "option", answer: selected[0] },
    ]);
    return true;
  }

  /** Update THE living message: the first update posts and captures the
   *  event id (`postResult`); every later one EDITS that same message
   *  (m.replace) — status line, ⌨️ terminal ack, and review are faces of
   *  ONE message, not a trail of posts. Concurrent updates chain onto the
   *  first post's promise (edit after settle) so no message is created
   *  twice; a failed first post leaves the id null and a later update
   *  re-posts. Without `postResult`/`edit` (plain-post hosts) every update
   *  posts fresh — degraded, never wrong. A failed edit is cosmetic: the
   *  terminal surface is authoritative. */
  function postLive(text: string): void {
    const send = (t: string): Promise<{ success: boolean; eventId?: string; error?: string }> =>
      (deps.postResult ?? deps.post)(t);
    if (liveMsgId && deps.edit) {
      // Living message exists: edit it in place (best effort — a failed
      // edit is cosmetic; the terminal surface is authoritative).
      const edit = deps.edit;
      void edit(liveMsgId, text)
        .then((r) => {
          if (!r.success) deps.warn?.(`[matrix] status edit failed: ${r.error || "unknown"}`);
        })
        .catch(() => undefined);
      return;
    }
    if (liveFirstPost) {
      // First post in flight: chain onto it — after it settles the id is
      // known, so this update edits the same message (or posts fresh when
      // the first post failed and left no target).
      void liveFirstPost
        .then((r) => {
          if (r?.success && r.eventId && deps.edit) {
            liveMsgId = r.eventId;
            return deps.edit(r.eventId, text);
          }
          // No edit capability (or a failed first post): the update must
          // still reach the room — post fresh, never drop it.
          return send(text).then((r2) => {
            if (r2.success && r2.eventId) liveMsgId = r2.eventId;
            return undefined;
          });
        })
        .catch(() => undefined);
      return;
    }
    // First post: make the send call synchronously (room order holds)
    // and settle the id from the result.
    const first = send(text);
    liveFirstPost = first
      .then((r) => {
        if (r.success && r.eventId) liveMsgId = r.eventId;
        return r;
      })
      .catch((e: unknown) => ({ success: false, error: String(e) }))
      .finally(() => {
        liveFirstPost = null;
      });
    void liveFirstPost.catch(() => undefined);
  }

  /** The review is just the living message's current face: when a status
   *  line is already up, arming the review EDITS that message — the room
   *  never gets a separate review post while a status is live. */
  function postReview(): void {
    postLive(formatReview());
  }

  /** Format the review step: all buffered answers, correctable before submit.
   *  Multi-select questions render as a checkbox list (TUI parity: [x] =
   *  selected, [ ] = available) regardless of the entry kind — an
   *  exact-set correction lands as an option-kind entry but the question
   *  stays multi. Custom entries render the custom text. The hint carries
   *  the only unselect channel: Matrix polls have no un-vote, so "Q1: 1 3"
   *  re-sets the exact selection (drops the rest). */
  // Instruction lines (header, per-question hint, footer grammar) render
  // dark-green bold: Matrix's custom-HTML subset has no background color,
  // so <font color> + <strong> is the closest expressible treatment — the
  // same proven mechanism as the converter's inline-code font color.
  const INSTRUCTION_GREEN = "#1a7f37";
  const instruction = (t: string): string =>
    `<font color="${INSTRUCTION_GREEN}"><strong>${t}</strong></font>`;

  /** The review message ships as RAW HTML (not markdown): the md pipeline
   *  escapes all HTML, which would turn the <font>/<strong> styling into
   *  literal text. The integration wiring passes the result as a pre-built
   *  `html` payload — shipped verbatim as formatted_body, with the
   *  pipeline's stripHtmlTags building the plain body fallback. */
  function formatReview(): string {
    const parts: string[] = [
      `<p>${instruction(`🔍 Review — ${buffer.size}/${questions.length} answers ready to send. Nothing is sent yet — review, correct, then confirm:`)}</p>`,
    ];
    [...buffer.entries()]
      .sort((a, b) => a[0] - b[0])
      .forEach(([i, e]) => {
        const q = questions[i];
        const selectedLabels =
          e.kind === "multi" ? e.selected ?? [] : e.kind === "option" && e.answer ? [e.answer] : [];
        // Bold question title, truncated to 50 chars (TUI parity: the review
        // shows WHICH question, not just its index).
        const title = q.question.length > 50 ? `${q.question.slice(0, 50)}…` : q.question;
        if (q.multiSelect === true && e.kind !== "custom") {
          const opts = (q.options ?? []).map((o) =>
            `${selectedLabels.includes(o.label) ? "✅" : "⬜"} ${escapeHtml(o.label)}`,
          );
          parts.push(`<p><strong>Q${i + 1}: ${escapeHtml(title)}</strong></p>`);
          parts.push(`<p>${opts.join("<br>")}</p>`);
          parts.push(
            `<p>${instruction(`(re-tap a selected option to unselect it — "Q${i + 1}: 1 3" sets the exact selection, dropping the rest)`)}</p>`,
          );
          return;
        }
        const shown =
          e.kind === "custom"
            ? `"${escapeHtml(e.answer ?? "")}" (custom)`
            : escapeHtml(e.answer ?? "");
        parts.push(`<p><strong>Q${i + 1}: ${escapeHtml(title)}</strong> = ${shown}</p>`);
      });
    parts.push(
      `<p>${instruction('Reply "Qn: x" or "Custom: text" to correct a question, "confirm" / "👍" to send, "👎" to decline.')}</p>`,
    );
    return parts.join("");
  }

  /** Compare buffered entries for the answers-state merge. Multi-select
   *  selections compare as SETS — the terminal stores them in authored
   *  order, the room buffers them in tap order; a re-broadcast of the
   *  mirror's own answer must not read as a change. */
  function stateEntriesEqual(a: MirrorAnswerEntry | undefined, b: MirrorAnswerEntry): boolean {
    if (!a) return false;
    if (a.kind !== b.kind || (a.answer ?? null) !== (b.answer ?? null)) return false;
    if (a.kind !== "multi" && b.kind !== "multi") return true;
    const sa = [...(a.selected ?? [])].sort().join("\u0000");
    const sb = [...(b.selected ?? [])].sort().join("\u0000");
    return sa === sb;
  }

  /** pi's current vote for one polled question: the buffered selection
   *  mapped through the poll's own answer list (label → id). A custom
   *  answer has no option to vote — no vote. Returns null when the
   *  question has no poll (ineligible or post failed) or the host cannot
   *  vote at all. */
  function pollVoteFor(qIdx: number): { ids: string[]; labels: string[] } | null {
    if (!deps.sendPollVote) return null;
    const poll = pollByQuestion.get(qIdx);
    if (!poll) return null;
    const entry = buffer.get(qIdx);
    const labels: string[] = [];
    if (entry?.kind === "multi") labels.push(...(entry.selected ?? []));
    else if (entry?.kind === "option" && entry.answer) labels.push(entry.answer);
    const known = answersByPoll.get(poll) ?? [];
    const hits = labels
      .map((l) => known.find((a) => a.label === l))
      .filter((a): a is { id: string; label: string } => a !== undefined);
    return { ids: hits.map((h) => h.id), labels: hits.map((h) => h.label) };
  }

  /** Best-effort fire-and-forget (like endPoll): a failed vote is
   *  cosmetic — the living review message stays authoritative. */
  function syncPollVotes(changedIndexes: number[]): void {
    for (const idx of changedIndexes) {
      const poll = pollByQuestion.get(idx);
      const vote = pollVoteFor(idx);
      if (!poll || !vote) continue;
      void deps.sendPollVote?.(poll, vote.ids, vote.labels).catch(() => undefined);
    }
  }

  function onAnswersState(payload: MirrorAnswersStatePayload): void {
    if (!open || payload.toolCallId === undefined || payload.toolCallId !== toolCallId) return;
    if (!Array.isArray(payload.answers)) return;
    const changed: number[] = [];
    for (const a of payload.answers) {
      if (!a || typeof a.questionIndex !== "number" || a.questionIndex < 0 || a.questionIndex >= questions.length) continue;
      const entry: MirrorAnswerEntry = {
        questionIndex: a.questionIndex,
        kind: a.kind,
        answer: a.answer ?? null,
        ...(a.selected ? { selected: [...a.selected] } : {}),
      };
      if (stateEntriesEqual(buffer.get(a.questionIndex), entry)) continue; // echo of our own partial, or unchanged
      buffer.set(a.questionIndex, entry);
      changed.push(a.questionIndex);
    }
    if (changed.length === 0) return;
    syncPollVotes(changed); // the terminal answer's ONLY room-visible vote
    if (buffer.size === questions.length) {
      // The set is complete with terminal answers merged in: arm (or refresh)
      // the room review — the surface the old mixed-surface flow was
      // missing. No partial echo back: the terminal already holds the state.
      reviewPending = true;
      postReview();
      return;
    }
    // Partial terminal progress: tell the room, or a phone user waits on a
    // set that is already half answered elsewhere.
    postLive(
      `⌨️ ${changed.map((i) => `Q${i + 1}`).join(", ")} answered at the terminal (${buffer.size}/${questions.length} in) — answer the rest here or at the keyboard.`,
    );
  }

  return {
    onPrompt,
    onBlocked,
    onAnswerResult,
    onAnswersState,
    onPollResponse,
    tryConsumeReply,
    isOpen: () => open,
  };
}

// ==========================================================================
// Pure helpers (exported for tests)
// ==========================================================================

/** Convert buffered (label-based) entries into the upstream 2.13+ payload
 *  shape: option labels → option indexes, custom text stays text. An entry
 *  whose label matches no option (a stale questionnaire) is DROPPED — the
 *  caller compares counts to detect the mismatch and refuses to emit. */
export function toUpstreamEntries(
  entries: readonly MirrorAnswerEntry[],
  questions: readonly MirrorQuestion[],
): UpstreamAnswerEntry[] {
  const out: UpstreamAnswerEntry[] = [];
  for (const e of entries) {
    const q = questions[e.questionIndex];
    if (!q) continue;
    if (e.kind === "custom") {
      const text = (e.answer ?? "").trim();
      if (text.length > 0) out.push({ questionIndex: e.questionIndex, text });
      continue;
    }
    const labels = e.kind === "multi" ? (e.selected ?? []) : e.answer ? [e.answer] : [];
    const optionIndexes: number[] = [];
    for (const label of labels) {
      const i = (q.options ?? []).findIndex((o) => o.label === label);
      if (i >= 0 && !optionIndexes.includes(i)) optionIndexes.push(i);
    }
    // Authored order (the TUI's own multi-select shape) — taps arrive in
    // pick order, the emission should not depend on that.
    optionIndexes.sort((a, b) => a - b);
    if (optionIndexes.length > 0) out.push({ questionIndex: e.questionIndex, optionIndexes });
  }
  return out;
}

/** Option-label shapes the emoji aliases map onto (case-insensitive,
 *  optional trailing period): 👍/✅ onto the yes-ish option, 👎/❌ onto the
 *  no-ish one. Each must match exactly one option to fire (ambiguous or no
 *  match → falls through to the caller's grammar nudge). */
const YES_OPTION_RE =
  /^(?:yes|yep|y|ok|okay|sure|approve|approved|accept|accepted|agree|agreed|proceed|confirm|confirmed|go ahead)\.?$/i;
const NO_OPTION_RE =
  /^(?:no|nope|n|reject|rejected|decline|declined|deny|denied|disagree|cancel|cancelled|stop)\.?$/i;
const EMOJI_ALIASES: Record<string, RegExp> = {
  "👍": YES_OPTION_RE,
  "✅": YES_OPTION_RE,
  "✔": YES_OPTION_RE,
  "☑": YES_OPTION_RE,
  "👎": NO_OPTION_RE,
  "❌": NO_OPTION_RE,
  "✖": NO_OPTION_RE,
  "✗": NO_OPTION_RE,
};

/** Strip emoji variation selectors (U+FE0E/U+FE0F) so picker-inserted
 *  variants ("✅\uFE0F", "✔\uFE0F") match the same aliases as bare codepoints. */
export function normalizeDecisionReply(text: string): string {
  return text.replace(/[\uFE0E\uFE0F]/g, "");
}

/**
 * A reply that *means* to answer: an explicit `Qn:`/`n:` or `Custom:`/
 * `Text:` prefix, or a bare number list — as opposed to ordinary chat,
 * which keeps the fall-through to injection while the mirror is open.
 * Documented false-positive: chat containing a `\d+:`-shaped token (a
 * "10:30" meeting time) while the mirror is open gets the nudge instead of
 * injection — the window is the brief RPIV wait, so that is acceptable.
 */
function looksLikeReplyAttempt(text: string): boolean {
  return (
    /[Qq]?\d+\s*[:：]/.test(text) ||
    /^(?:custom|text)\s*[:：]/i.test(text) ||
    /^\d[\d\s,;]*$/.test(text) ||
    // The decision-emoji vocabulary (a bare "👍" that matches no option
    // still means "I meant to answer", so it gets the nudge, not injection).
    // Text is already FE0E/FE0F-normalized by the caller.
    /^[\u{1F44D}\u{1F44E}\u{2705}\u{274C}\u{2713}\u{2714}\u{2611}\u{2716}\u{2717}\s]+$/u.test(text)
  );
}

/**
 * Format the questionnaire as GFM markdown — the single payload the
 * mirror ships: per-question pipe tables (`| # | Option |
 * Description |` + `---` separator + option rows + the "Type something."
 * sentinel row), plain lines for the question text and the reply-grammar
 * hint. The pipeline converts it to `formatted_body` HTML (markdown.ts
 * renders GFM pipe tables, `markdown.ts:159–171`); the semantic accent-color
 * palette is dropped by design — Element's GFM rendering carries the
 * structure.
 */
export function formatQuestionnaireMd(questions: MirrorQuestion[]): string {
  // GFM table cells break on raw pipes — escape them.
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const lines: string[] = [
    `🤖 Pi decision (RPIV) — ${questions.length} question${questions.length === 1 ? "" : "s"}. Answer here or in the terminal:`,
    "",
  ];
  questions.forEach((q, i) => {
    lines.push(`Q${i + 1}${q.header ? ` (${q.header})` : ""}${q.multiSelect ? " [multi]" : ""}: ${q.question}`);
    lines.push("| # | Option | Description |", "| --- | --- | --- |");
    (q.options ?? []).forEach((o, j) => {
      lines.push(`| ${j + 1} | ${cell(o.label)} | ${cell(o.description ?? "")} |`);
    });
    // The TUI's final "Type something." row, as a table sentinel row.
    lines.push(`| ${(q.options?.length ?? 0) + 1} | Type something. | reply "Custom: your answer" |`);
    lines.push("");
  });
  lines.push(
    'Reply: option number(s) or label(s) — "2", "2 3" (multi), "Q2: 3", or "Custom: free text" for a custom answer. ' +
      'Several questions: one number each ("2 3") or "1: 2; 2: 3". ' +
      'When all are answered: "Qn: x" / "Custom: text" to correct, "confirm" / "👍" to proceed.',
  );
  return lines.join("\n");
}

/**
 * Parse a room reply into answer entries. Returns [] when nothing parsed
 * (the message is not an answer). Unknown question numbers are skipped;
 * bare segments apply to the lowest-numbered still-unanswered question;
 * unrecognized free text yields no entry (falls through to normal
 * injection).
 */
export function parseMirrorReply(
  body: string,
  questions: MirrorQuestion[],
  alreadyAnswered: ReadonlySet<number> = new Set(),
): MirrorAnswerEntry[] {
  const entries: MirrorAnswerEntry[] = [];
  const pending = new Set(questions.map((_, i) => i).filter((i) => !alreadyAnswered.has(i)));
  // A `Custom:`/`Text:`-prefixed reply is ONE custom answer for the first
  // still-unanswered question (an optional `Qn:` prefix targets a specific
  // question) — the answer may span MULTIPLE LINES, so it is handled before
  // the segment split below (which would shatter it on every newline). An
  // optional `Qn:` prefix still targets a specific question. Empty custom
  // text falls through to the segment loop (the caller nudges the grammar).
  const customHead = body.trim().match(/^(?:[Qq](\d+)\s*[:：]\s*)?(?:custom|text)\s*[:：]\s*([\s\S]*)$/i);
  if (customHead) {
    const customText = (customHead[2] ?? "").trim();
    if (customText.length > 0) {
      const num = customHead[1] ? parseInt(customHead[1], 10) : null;
      const qIdx = num !== null ? num - 1 : ([...pending].sort((a, b) => a - b)[0] ?? 0);
      if (qIdx >= 0 && qIdx < questions.length) {
        return [{ questionIndex: qIdx, kind: "custom", answer: customText }];
      }
    }
  }
  const segmentRe = /^\s*[Qq]?(\d+)\s*[:：]\s*(.+)$/;

  for (const raw of body.split(/[;\n]+/)) {
    const segment = raw.trim();
    if (segment.length === 0) continue;
    // Snapshot before this segment may answer questions: the shorthand
    // distribution (2b) needs "remaining unanswered at segment start".
    const pendingBefore = new Set(pending);
    const m = segment.match(segmentRe);
    let qIdx: number | undefined;
    let choice: string;
    if (m) {
      const num = parseInt(m[1], 10);
      qIdx = num - 1;
      choice = m[2].trim();
    } else {
      choice = segment;
      // Lowest still-unanswered question — or question 1 when everything is
      // answered (review corrections via bare "Custom: text" / a bare number).
      qIdx = [...pending].sort((a, b) => a - b)[0] ?? 0;
    }
    if (qIdx === undefined || qIdx < 0 || qIdx >= questions.length) continue;
    const q = questions[qIdx];
    if (choice.length === 0) continue;
    pending.delete(qIdx);

    // 1. Exact option label (case-insensitive) wins.
    const labelMatch = (q.options ?? []).find(
      (o) => o.label.toLowerCase() === choice.toLowerCase(),
    );
    if (labelMatch) {
      entries.push({ questionIndex: qIdx, kind: "option", answer: labelMatch.label });
      continue;
    }
    // 1b. Emoji aliases (mobile-friendly yes/no): 👍/✅ → the single option
    //     with a yes-ish label ("Yes", "Approve", …); 👎/❌ → the single
    //     option with a no-ish label ("No", "Reject", …). Requires exactly
    //     one matching option — 0 or ambiguous falls through to the caller's
    //     grammar nudge.
    const aliasRe = EMOJI_ALIASES[normalizeDecisionReply(choice)];
    if (aliasRe && (q.options ?? []).length > 0) {
      const matches = (q.options ?? []).filter((o) => aliasRe.test(o.label.trim()));
      if (matches.length === 1) {
        entries.push(
          q.multiSelect
            ? { questionIndex: qIdx, kind: "multi", answer: null, selected: [matches[0].label] }
            : { questionIndex: qIdx, kind: "option", answer: matches[0].label },
        );
        continue;
      }
    }
    // 2. Option number(s): "3", "2 3", "2,3".
    const tokens = choice.split(/[\s,]+/).filter(Boolean);
    const numericTokens = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
    // 2a. Single-select questions: one-number-per-question wins when the
    //     count matches exactly (each number in range for ITS OWN question):
    //     "1 1" → Q1=1, Q2=1. Without this the numbers are absorbed by the
    //     current question ("1 1" → duplicated multi-select, de-duped to
    //     just option 1 — the next question never gets answered). Multi-
    //     select questions keep the current-question multi-read ("2 3" on a
    //     multi-select Q1 = options 2 AND 3).
    if (!m && numericTokens && q.multiSelect !== true && pendingBefore.size === tokens.length) {
      const idxs = [...pendingBefore].sort((a, b) => a - b);
      if (
        idxs.every((qi, j) => {
          const n = parseInt(tokens[j], 10);
          return n >= 1 && n <= (questions[qi].options?.length ?? 0);
        })
      ) {
        for (let j = 0; j < idxs.length; j++) {
          const qi = idxs[j];
          const label = questions[qi].options![parseInt(tokens[j], 10) - 1].label;
          entries.push(
            questions[qi].multiSelect
              ? { questionIndex: qi, kind: "multi", answer: null, selected: [label] }
              : { questionIndex: qi, kind: "option", answer: label },
          );
        }
        continue;
      }
    }
    const allNumbers =
      numericTokens &&
      tokens.every((t) => { const n = parseInt(t, 10); return n >= 1 && n <= (q.options?.length ?? 0); });
    if (allNumbers) {
      const selected = [...new Set(tokens.map((t) => q.options![parseInt(t, 10) - 1].label))];
      // A multi-kind entry is only meaningful for a multi-select question —
      // the package TUI does not register a multi answer on a single-select
      // question (the entry silently never lands). Single-select + several
      // numbers (the distribution above already took its turn) → the first
      // number.
      if (q.multiSelect === true && tokens.length > 1 && selected.length > 1) {
        entries.push({ questionIndex: qIdx, kind: "multi", answer: null, selected });
      } else {
        entries.push({ questionIndex: qIdx, kind: "option", answer: selected[0] ?? null });
      }
      continue;
    }
    // 2b. Multi-question shorthand: bare numbers the first unanswered
    //     question cannot take (one is out of range for it) → one number
    //     per remaining unanswered question, in question order ("2 3" →
    //     Q1=2, Q2=3). Fires only when the count matches exactly.
    if (!m && numericTokens && pendingBefore.size === tokens.length) {
      const idxs = [...pendingBefore].sort((a, b) => a - b);
      if (
        idxs.every((qi, j) => {
          const n = parseInt(tokens[j], 10);
          return n >= 1 && n <= (questions[qi].options?.length ?? 0);
        })
      ) {
        for (let j = 0; j < idxs.length; j++) {
          const qi = idxs[j];
          const label = questions[qi].options![parseInt(tokens[j], 10) - 1].label;
          entries.push(
            questions[qi].multiSelect
              ? { questionIndex: qi, kind: "multi", answer: null, selected: [label] }
              : { questionIndex: qi, kind: "option", answer: label },
          );
        }
        continue;
      }
    }
    // 3. Custom answer — requires the explicit `Custom:` prefix so ordinary
    //    chat while the mirror is open keeps injecting normally.
    const customRe = /^(?:custom|text)\s*[:：]\s*(.+)$/i;
    const cm = choice.match(customRe);
    if (cm && cm[1].trim().length > 0) {
      entries.push({ questionIndex: qIdx, kind: "custom", answer: cm[1].trim() });
      continue;
    }
    // Unrecognized text → no entry; the caller falls through to injection.
  }
  return entries;
}
