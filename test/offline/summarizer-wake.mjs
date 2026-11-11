/**
 * Summarizer-wake loop guard (INCIDENT-2026-10-22-SUMMARY-LOOP).
 *
 * The cadence spawns an isolated `pi-matrix-integration-thread-summarizer` run; pi-subagents 0.80.0 wakes
 * the parent session when that run completes (notify.js defaults
 * `triggerTurn` to true for async runs). The wake turn's report-out used to
 * land in the thread as a new message, which re-armed the cadence guard — a
 * self-sustaining spawn → wake → report-out → spawn loop.
 *
 * The guard: `Lifecycle.onBeforeAgentStart` flags a run started by a
 * summarizer-only completion notice, and `onTurnEnd` drops that turn's final
 * broadcast. Driven here directly against the class with a recording
 * messageHandler — no Matrix, no subagent package.
 */
import path from "node:path";
import { EXT_DIR, createPiJiti, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("SUMMARIZER-WAKE");

const classify = await jiti.import(path.join(EXT_DIR, "src", "classify.ts"));
const { Lifecycle } = await jiti.import(path.join(EXT_DIR, "src", "lifecycle.ts"));

// ---- detector --------------------------------------------------------------

/** A pi-subagents completion notice (notify.js message shape). */
const notice = (agents) => ({
  customType: "subagent-notify",
  content: "Background task completed",
  details: { runs: agents.map((agent) => ({ agent, status: "completed" })) },
});

check(
  "summarizer-only notice is a wake",
  classify.isSummarizerWakeNotice(notice(["pi-matrix-integration-thread-summarizer"])),
);
check(
  "grouped notice with other work is not a wake",
  classify.isSummarizerWakeNotice(notice(["pi-matrix-integration-thread-summarizer", "scout"])) === false,
);
check("other agent's notice is not a wake", classify.isSummarizerWakeNotice(notice(["scout"])) === false);
check(
  "notice without details.runs is not a wake",
  classify.isSummarizerWakeNotice({ customType: "subagent-notify" }) === false,
);
check("empty runs is not a wake", classify.isSummarizerWakeNotice(notice([])) === false);
check(
  "the extension's own injected message is not a wake",
  classify.isSummarizerWakeNotice({ customType: "matrix-message", content: "x" }) === false,
);
check("undefined message is not a wake", classify.isSummarizerWakeNotice(undefined) === false);

// ---- the turn guard --------------------------------------------------------

function makeLifecycle(cfgOverrides = {}) {
  const sent = [];
  const milestones = [];
  const logs = [];
  // PROP-001 P3 deleted the trigger-suppression and quiet-hint machinery; the
  // stubs stay so the tests can ASSERT nothing calls them (counters must
  // remain 0 / hints 0).
  const tm = { suppressed: 0, cleared: 0, humanTicks: 0 };
  const hints = [];
  const lc = new Lifecycle({
    cfg: { roomId: "!room:tst", sendFinalMessages: true, sendMilestones: false, maxFinalMessageLength: 2000, ...cfgOverrides },
    logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(m) },
    sessionIntegrator: {
      updateFooterStatus: () => {},
      injectQuietDirective: (content, details) => hints.push({ content, details }),
    },
    messageHandler: {
      sendFinalMessage: async (text) => {
        sent.push(text);
        return { success: true };
      },
      sendMilestone: async (text) => {
        milestones.push(text);
        return { success: true };
      },
    },
    threadManager: {
      suppressNextOnFinalTrigger: () => { tm.suppressed += 1; },
      clearOnFinalSuppression: () => { tm.cleared += 1; },
      recordHumanMessage: () => { tm.humanTicks += 1; return Promise.resolve(); },
    },
  });
  lc.setEnabled(true);
  return { lc, sent, milestones, logs, tm, hints };
}

const assistantTurn = (text) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

/** The extension's own summarize directive (Engine A, the fallback path). */
const directive = (details) => ({
  customType: "matrix-directive",
  content: "Run a Matrix thread-summary pass for this session now.",
  details,
});

// 1) A wake turn reports out nowhere.
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("Pass done. No new facts."));
  check("wake turn posts nothing to the room", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  check(
    "the skip is observable in the log",
    logs.some((l) => /summarizer pass turn, final broadcast held/.test(l)),
  );
}

// 2) Every turn of the muted run reports out nowhere; the NEXT run does.
//    (BUG-thread-summary-bleed: the flag used to be consumed by the first
//    turn_end, so a pass's closing sentence leaked into the room.)
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("wake reply"));
  await lc.onTurnEnd(assistantTurn("still the same pass"));
  check("the whole muted run posts nothing", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  lc.onAgentSettled();
  lc.onBeforeAgentStart({ messageType: "user", prompt: "next question" });
  await lc.onTurnEnd(assistantTurn("real answer"));
  check("the next run broadcasts after settle", sent.length === 1 && sent[0] === "real answer", `sent=${JSON.stringify(sent)}`);
}

// 3) A run that dies before settle cannot leave a stale mute behind: the
//    next run's start re-decides the flag.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd({ message: { role: "assistant", content: [{ type: "thinking" }] } });
  lc.onBeforeAgentStart({ messageType: "user", prompt: "hello" });
  await lc.onTurnEnd(assistantTurn("real answer"));
  check("a new run clears a mute left by a dead one", sent.length === 1 && sent[0] === "real answer", `sent=${JSON.stringify(sent)}`);
}

// 3b) THE BLEED: the in-session fallback pass — turn 1 is the tool call (no
//     text), turn 2 the closing sentence. Zero room events, both turns.
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onTurnEnd({ message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "matrix_update_thread_summary", arguments: {} }] } });
  await lc.onTurnEnd(assistantTurn("Root unchanged."));
  await lc.onTurnEnd(assistantTurn("Summary pass done."));
  check("a multi-turn pass leaks no closing line", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  check(
    "every filtered turn is observable",
    logs.filter((l) => /summarizer pass turn, final broadcast held/.test(l)).length === 3,
    JSON.stringify(logs),
  );
}

// 3b2) THE SWALLOWED ANSWER (2026-11-10 incident): the question was queued
//     BEFORE the directive opened the run — its message_end fired before
//     any run flag existed, so the old mid-pass lift never saw it and the
//     answer died at turn_end. The shipping gate reads the pending flag
//     live: no lift machinery, no arrival-order dependency (PROP-001).
{
  const { lc, sent, logs } = makeLifecycle();
  await lc.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: "the queued question" }] } });
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onTurnEnd(assistantTurn("answer to the queued question"));
  check(
    "a question queued before the directive gets answered in the room",
    sent.length === 1 && sent[0] === "answer to the queued question",
    `sent=${JSON.stringify(sent)}`,
  );
  check(
    "the summary trigger is named at run start (declared, logged)",
    logs.some((l) => /summary-run-filter=true/.test(l)),
    JSON.stringify(logs),
  );
  await lc.onTurnEnd(assistantTurn("Root unchanged."));
  check(
    "the pass leftover stays filtered once the answer shipped (pending cleared)",
    sent.length === 1,
    `sent=${JSON.stringify(sent)}`,
  );
}

// 3c) A TODO-progress milestone inside a pass stays out of the room too.
{
  const { lc, milestones } = makeLifecycle({ sendMilestones: true });
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onTurnEnd(assistantTurn("TODO progress: 2 completed, 1 in progress"));
  check("a pass cannot post a milestone", milestones.length === 0, JSON.stringify(milestones));
}

// 3d) A human message folded into a live summary pass answers in the room:
//     the pending flag flips the gate for the next final — no mute to lift.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: "actual question" }] } });
  await lc.onTurnEnd(assistantTurn("answer to the human"));
  check("user input mid-pass ships the next final", sent.length === 1 && sent[0] === "answer to the human", `sent=${JSON.stringify(sent)}`);
}

// 3e) The pass's own injected directive must NOT lift the mute — and neither
//     may a wake notice: the lift must never be self-triggered by anything
//     the summary machinery injects (BUG-summary-pass-mute guard).
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onMessageEnd({ message: { role: "user", ...directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }) } });
  await lc.onMessageEnd({ message: { role: "custom", ...notice(["pi-matrix-integration-thread-summarizer"]) } });
  await lc.onTurnEnd(assistantTurn("Root unchanged."));
  check("the pass's own directive does not lift the mute", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  check(
    "no lift fired for injected messages",
    !logs.some((l) => /broadcast mute lifted/.test(l)),
    JSON.stringify(logs),
  );
}

// 3f) BUG-summary-pass-mute: a RELAYED ROOM MESSAGE is human input too — the
//     room is this integration's primary input channel. Absorbed mid-pass it
//     must lift the mute and the answer turn must broadcast.
const roomRelay = (text) => ({
  role: "custom",
  customType: "matrix-message",
  content: `[Matrix] vincent: ${text}`,
  details: { sender: "@vincent:tst", senderName: "vincent", eventId: "$ev", roomId: "!room:tst" },
});
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onMessageEnd({ message: roomRelay("Show me the code of serve.mjs") });
  check(
    "no lift machinery left: the shipping gate reads the pending flag",
    !logs.some((l) => /mute lifted/.test(l)),
    JSON.stringify(logs),
  );
  await lc.onTurnEnd(assistantTurn("Here is serve.mjs …"));
  check("the answer to the room reaches the room", sent.length === 1 && sent[0] === "Here is serve.mjs …", `sent=${JSON.stringify(sent)}`);
}

// 3g) A relay while NOT muted changes nothing — normal broadcast on a later
//     run must not double-send or trip the lift path.
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "user", prompt: "hello" });
  await lc.onMessageEnd({ message: roomRelay("follow-up from the room") });
  check(
    "a plain relay ships normally (nothing held, nothing lifted)",
    !logs.some((l) => /mute lifted|final broadcast held/.test(l)),
    JSON.stringify(logs),
  );
  await lc.onTurnEnd(assistantTurn("answer with the follow-up"));
  check("unmuted run broadcasts once", sent.length === 1 && sent[0] === "answer with the follow-up", `sent=${JSON.stringify(sent)}`);
}

// 3h) After a relay lifts the mute, the ask_user_question context flush (same
//     flag, message_end path) runs again — a questionnaire cannot land in the
//     room without its preceding context.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onMessageEnd({ message: roomRelay("which option?") });
  await lc.onMessageEnd({
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Context for the decision." },
        { type: "toolCall", id: "c", name: "ask_user_question", arguments: {} },
      ],
    },
  });
  check(
    "post-lift ask_user context flushes",
    sent.length === 1 && sent[0] === "Context for the decision.",
    `sent=${JSON.stringify(sent)}`,
  );
}

// 3i) PROP-001 P3: a summary pass that answers a human question ships the
//     answer and nothing else. No trigger-suppression exists anymore — a
//     posted final cannot dispatch a pass, because the on-final cadence gate
//     reads the human meter (test/summarize-cadence.mjs pins that).
{
  const { lc, sent, tm } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  // root edit lands first — the relay and the answer come AFTER it.
  await lc.onTurnEnd({ message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "matrix_update_thread_summary", arguments: {} }] } });
  await lc.onMessageEnd({ message: roomRelay("Show me the code of serve.mjs") });
  await lc.onTurnEnd(assistantTurn("Here is serve.mjs …"));
  check("the answer emitted after the edit ships", sent.length === 1 && sent[0] === "Here is serve.mjs …", `sent=${JSON.stringify(sent)}`);
  check("no suppression machinery is called", tm.suppressed === 0, JSON.stringify(tm));
  await lc.onTurnEnd(assistantTurn("Root unchanged."));
  check("the pass leftover stays filtered once the answer shipped", sent.length === 1, `sent=${JSON.stringify(sent)}`);
  // The next run ships normally — the filter died with its run boundary.
  lc.onAgentSettled();
  lc.onBeforeAgentStart({ messageType: "user", prompt: "next question" });
  await lc.onTurnEnd(assistantTurn("later answer"));
  check(
    "the next run ships its report-out normally",
    sent.length === 2 && sent[1] === "later answer" && tm.suppressed === 0,
    `sent=${JSON.stringify(sent)} tm=${JSON.stringify(tm)}`,
  );
}

// 3j) A muted run with NO relay: nothing posts and nothing is booked as
//     bookkeeping either — the summary machinery is untouched (the root edit
//     itself goes through the tool, not through the broadcast path).
{
  const { lc, sent, tm } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onTurnEnd(assistantTurn("Root unchanged."));
  check("unlifted pass posts nothing", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  check("unlifted pass books no suppression", tm.suppressed === 0, JSON.stringify(tm));
}

// 3k) Echo-isolated cadence wiring (PROP-001 P2): the human meter ticks
//     for human input on both channels — terminal (bare user message) and
//     room relay (matrix-message) — and never for the extension's own
//     channels (a summary directive carries matrix-directive; Matrix
//     echoes of own sends are dropped upstream by sender id, so they never
//     reach this handler at all).
{
  const { lc, tm } = makeLifecycle();
  await lc.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: "a question" }] } });
  await lc.onMessageEnd({ message: { role: "user", customType: "matrix-message", content: [{ type: "text", text: "room question" }] } });
  await lc.onMessageEnd({ message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }) });
  check("3k: ticks for the two human channels, none for the directive",
    tm.humanTicks === 2, String(tm.humanTicks));
}

// 4) A notice carrying real work is NOT muted — that report belongs in the room.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer", "scout"]) });
  await lc.onTurnEnd(assistantTurn("mixed work answer"));
  check("mixed notice still broadcasts", sent.length === 1 && sent[0] === "mixed work answer", `sent=${JSON.stringify(sent)}`);
}

// 5) A user-prompted run is never flagged.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "user", prompt: "hello" });
  await lc.onTurnEnd(assistantTurn("hi"));
  check("user-prompted turn broadcasts", sent.length === 1 && sent[0] === "hi", `sent=${JSON.stringify(sent)}`);
}

// ---- Engine A: the in-session summarize directive ---------------------------

check(
  "the room relay is not summary fuel (lift and mute never share a type)",
  classify.isSummarizeDirectiveNotice({ customType: classify.MATRIX_MESSAGE_CUSTOM_TYPE, details: { kind: classify.SUMMARIZE_DIRECTIVE_KIND } }) === false,
);
check(
  "summarize-kind directive is summary fuel",
  classify.isSummarizeDirectiveNotice(directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND })),
);
check("kindless directive (tour prompt) is not", classify.isSummarizeDirectiveNotice(directive(undefined)) === false);
check(
  "other-kind directive is not",
  classify.isSummarizeDirectiveNotice(directive({ kind: "tour" })) === false,
);
check(
  "prose marker without details is not (identity is structural, never prose)",
  classify.isSummarizeDirectiveNotice({ customType: "other", content: "Run a Matrix thread-summary pass" }) === false,
);

// 6) A directive-started pass reports out nowhere (Engine A mute).
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({
    messageType: "custom",
    message: directive({ kind: classify.SUMMARIZE_DIRECTIVE_KIND }),
  });
  await lc.onTurnEnd(assistantTurn("Pass done. No new facts."));
  check("directive turn posts nothing to the room", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

// ---- Busy-parent absorption: logged, never muted -----------------------------
// A notice steered into a LIVE run never fires before_agent_start (pi queues
// it into that run — pi agent-session.js sendCustomMessage streaming path).
// Its report answers real work → it must still broadcast; the extension only
// makes the event observable.

// 7) Absorbed notice: real-work report survives, the event is logged. The
//    trigger-disarm and the quiet do-not-surface hint are gone with the loop
//    they guarded: the cadence cannot self-arm (P2) and the folded notice
//    adds no fuel — an echoed notice line costs one room message at worst,
//    never another pass.
{
  const { lc, sent, logs, tm, hints } = makeLifecycle();
  await lc.onMessageEnd({ message: { role: "custom", ...notice(["pi-matrix-integration-thread-summarizer"]) } });
  await lc.onTurnEnd(assistantTurn("real work report"));
  check("absorbed wake does not mute the real report", sent.length === 1 && sent[0] === "real work report", `sent=${JSON.stringify(sent)}`);
  check(
    "the absorption is observable in the log",
    logs.some((l) => /summary fuel notice absorbed by live run/.test(l)),
    JSON.stringify(logs),
  );
  check("no suppression machinery is called", tm.suppressed === 0, JSON.stringify(tm));
  check("the quiet-hint machinery is deleted", hints.length === 0, JSON.stringify(hints));
}

// 7b) A run with no absorbed wake keeps today's report-out trigger.
{
  const { lc, sent, tm } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "user", prompt: "hello" });
  await lc.onTurnEnd(assistantTurn("hi"));
  check("a plain user turn keeps the trigger", sent.length === 1 && tm.suppressed === 0, JSON.stringify(tm));
}

// 7b2) An assistant message_end (no notice) injects no hint.
{
  const { lc, hints } = makeLifecycle();
  await lc.onMessageEnd(assistantTurn("just an answer"));
  check("no notice, no hint", hints.length === 0, JSON.stringify(hints));
}

// 7c) Nothing survives the run boundary: a notice absorbed by one run
//     cannot filter a later run's report-out.
{
  const { lc, sent, tm } = makeLifecycle();
  await lc.onMessageEnd({ message: { role: "custom", ...notice(["pi-matrix-integration-thread-summarizer"]) } });
  lc.onBeforeAgentStart({ messageType: "user", prompt: "next question" });
  await lc.onTurnEnd(assistantTurn("later answer"));
  check("an absorbed notice cannot silence the next run", sent.length === 1 && tm.suppressed === 0 && tm.cleared === 0, JSON.stringify(tm));
}

// 8) Termination contract: absorbed wake during real work + idle wake after.
//    Only the idle wake mutes; after it, msgCount is flat → no new fuel.
{
  const { lc, sent } = makeLifecycle();
  // real run in progress, wake N absorbed → real report posts (legitimate content)
  await lc.onMessageEnd({ message: { role: "custom", ...notice(["pi-matrix-integration-thread-summarizer"]) } });
  await lc.onTurnEnd(assistantTurn("real work report"));
  // wake N+1 starts its own run on the now-idle parent → muted
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("wake reply"));
  // wake N+2 likewise (loop cannot ride through the busy turn)
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("wake reply 2"));
  check(
    "loop starves: only the real report reaches the room",
    sent.length === 1 && sent[0] === "real work report",
    `sent=${JSON.stringify(sent)}`,
  );
}

// ---- Decision-context flush (ask_user_question ordering) -------------------
// message_end fires BEFORE tool execution; the mirror posts the
// questionnaire at tool-start. The explanation text of an
// ask_user_question message must therefore go out at message_end (the
// duplicate turn_end send is deduped inside MessageHandler, not here).

const askTurn = (text) => ({
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id: "call_1", name: "ask_user_question", arguments: {} },
    ],
  },
});

// 1) The explanation flushes at message_end, ahead of the questionnaire.
{
  const { lc, sent } = makeLifecycle();
  await lc.onMessageEnd(askTurn("Here is the context for the decision."));
  check(
    "ask_user context flushes at message_end",
    sent.length === 1 && sent[0] === "Here is the context for the decision.",
    `sent=${JSON.stringify(sent)}`,
  );
}

// 2) A plain assistant message does NOT flush early (turn_end stays the only final).
{
  const { lc, sent } = makeLifecycle();
  await lc.onMessageEnd(assistantTurn("plain answer"));
  check("no flush without an ask_user_question call", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

// 3) Gated by sendFinalMessages (it IS the final broadcast, just earlier).
{
  const { lc, sent } = makeLifecycle();
  lc.deps.cfg.sendFinalMessages = false;
  await lc.onMessageEnd(askTurn("gated context"));
  check("sendFinalMessages off → no early flush", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

// 4) A wake turn never flushes the decision context into the room.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onMessageEnd(askTurn("wake context"));
  check("wake turn ask_user flush is muted", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

// 5) Tool-call-only message (no text) sends nothing.
{
  const { lc, sent } = makeLifecycle();
  await lc.onMessageEnd({
    message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "ask_user_question", arguments: {} }] },
  });
  check("textless ask_user message flushes nothing", sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

finish();
