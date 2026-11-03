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
import { EXT_DIR, createPiJiti, makeCheck } from "./_harness.mjs";

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

function makeLifecycle() {
  const sent = [];
  const logs = [];
  // BUG-SUMMARIZER-ONFINAL-LOOP A: the wake-answer final must tell the thread
  // manager to skip the report-out trigger.
  const tm = { suppressed: 0, cleared: 0 };
  // Leak guard: an absorbed notice must be followed by a quiet hint.
  const hints = [];
  const lc = new Lifecycle({
    cfg: { roomId: "!room:tst", sendFinalMessages: true, sendMilestones: false, maxFinalMessageLength: 2000 },
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
      sendMilestone: async () => ({ success: true }),
    },
    threadManager: {
      suppressNextOnFinalTrigger: () => { tm.suppressed += 1; },
      clearOnFinalSuppression: () => { tm.cleared += 1; },
    },
  });
  lc.setEnabled(true);
  return { lc, sent, logs, tm, hints };
}

const assistantTurn = (text) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

// 1) A wake turn reports out nowhere.
{
  const { lc, sent, logs } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("Pass done. No new facts."));
  check("wake turn posts nothing to the room", sent.length === 0, `sent=${JSON.stringify(sent)}`);
  check(
    "the skip is observable in the log",
    logs.some((l) => /summarizer wake turn, skipping final broadcast/.test(l)),
  );
}

// 2) The very next real turn still reports out (the flag is one-shot).
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd(assistantTurn("wake reply"));
  await lc.onTurnEnd(assistantTurn("real answer"));
  check("the next real turn broadcasts", sent.length === 1 && sent[0] === "real answer", `sent=${JSON.stringify(sent)}`);
}

// 3) A wake turn that never reaches the broadcast (tool-only turn) must not
//    mute the following real turn.
{
  const { lc, sent } = makeLifecycle();
  lc.onBeforeAgentStart({ messageType: "custom", message: notice(["pi-matrix-integration-thread-summarizer"]) });
  await lc.onTurnEnd({ message: { role: "assistant", content: [{ type: "thinking" }] } });
  await lc.onTurnEnd(assistantTurn("real answer"));
  check("a text-less wake turn does not leak the mute", sent.length === 1 && sent[0] === "real answer", `sent=${JSON.stringify(sent)}`);
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

// ---- Engine A: the in-session summarize directive ----------------------------

const directive = (details) => ({
  customType: "matrix-directive",
  content: "Run a Matrix thread-summary pass for this session now.",
  details,
});

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

// 7) Absorbed notice: real-work report survives, the event is logged, and the
//    report-out trigger is disarmed for that one final.
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
  check("its final does not re-arm the summary trigger", tm.suppressed === 1, JSON.stringify(tm));
  check(
    "a quiet do-not-surface hint rides after the absorbed notice",
    hints.length === 1 && hints[0].details?.kind === "absorbed-notice-hint",
    JSON.stringify(hints),
  );
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

// 7c) The wake-fuel flag lives one run: the next run's start clears it, so a
//     later real report-out still re-arms.
{
  const { lc, sent, tm } = makeLifecycle();
  await lc.onMessageEnd({ message: { role: "custom", ...notice(["pi-matrix-integration-thread-summarizer"]) } });
  lc.onBeforeAgentStart({ messageType: "user", prompt: "next question" });
  await lc.onTurnEnd(assistantTurn("later answer"));
  check("a stale wake flag does not silence the next run", sent.length === 1 && tm.suppressed === 0 && tm.cleared === 1, JSON.stringify(tm));
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
