/**
 * test-polls.mjs — the decision polls (DESIGN-DECISIONS §5): single- and
 * multi-select questions ship as tappable m.poll.start events (MSC3381
 * extensible wire format, answers carry ids; multi-select polls carry
 * max_selections = number of options), a tap answers through the same
 * path as a room text reply (shared apply: buffer locally + ack/review;
 * ONE complete-set emission on confirm — the 2.13 answer channel refuses
 * partial sets), a multi-vote response (all selected ids in one response)
 * resolves to one multi entry, legacy label refs fall back to label
 * matching, and poll.end closes the polls when the decision closes.
 */
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createAskUserMirror, parseMirrorReply } = await jiti.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));

/** The living review chains its post/edit through promises — settle the
 *  microtask queue before asserting on review posts/edits. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const { check, finish } = makeCheck("polls");

/** Fake deps: capture posts/polls, record emissions. `answers` holds the
 *  Emitted payloads (each a complete set or a cancel) — with the 2.13
 *  channel the mirror emits once, on confirm, so most taps leave it empty
 *  by design. */
function makeDeps({
  pollsEnabled = true,
  pollPostFail = false,
  pollEventIdSeq = 1,
} = {}) {
  const state = {
    posts: [],
    postResults: [],
    edits: [],
    msgSeq: 0,
    polls: [], // { question, answers, eventId }
    endedPolls: [],
    votes: [], // pi's own poll votes (sendPollVote): { pollId, ids, labels }
    answers: [], // model-facing payloads (complete sets / cancels)
    partials: [], // display-sync payloads (patch A2.13-0001, per tap)
    warns: [],
  };
  const deps = {
    post: async (text) => {
      state.posts.push(text);
      return { success: true };
    },
    postResult: async (text) => {
      state.postResults.push(text);
      state.msgSeq += 1;
      return { success: true, eventId: `!msg-${state.msgSeq}` };
    },
    edit: async (targetEventId, text) => {
      state.edits.push({ targetEventId, text });
      return { success: true };
    },
    isEnabled: () => true,
    emitAnswer: (payload) => {
      if (payload.partial) state.partials.push(payload);
      else state.answers.push(payload);
    },
    postPoll: async (question, answers, maxSelections) => {
      if (pollPostFail) return { success: false, error: "boom" };
      const eventId = `!poll-${pollEventIdSeq++}`;
      state.polls.push({ question, answers, maxSelections, eventId });
      return { success: true, eventId };
    },
    endPoll: async (pollEventId) => {
      state.endedPolls.push(pollEventId);
      return {};
    },
    sendPollVote: async (pollEventId, answerIds, labels) => {
      state.votes.push({ pollId: pollEventId, ids: [...answerIds], labels: [...labels] });
      return { success: true };
    },
    pollsEnabled: () => pollsEnabled,
    warn: (m) => state.warns.push(m),
  };
  return { state, deps };
}

const QS_TWO = [
  {
    question: "Which library?",
    header: "Lib",
    multiSelect: false,
    options: [{ label: "lodash" }, { label: "ramda" }],
  },
  {
    question: "Which scopes?",
    header: "Scopes",
    multiSelect: true,
    options: [{ label: "read" }, { label: "write" }],
  },
];

// --- posting: one poll per eligible question (single- AND multi-select) ---
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-1");
  // The poll loop is fire-and-forget — wait for BOTH polls (Q1 single,
  // Q2 multi).
  await waitUntil(() => state.polls.length === 2, { label: "poll posts" });
  check(
    "one poll per eligible question (single- and multi-select)",
    state.polls.length === 2 && state.polls[0].question === "Which library?" &&
      state.polls[0].answers.length === 2 && state.polls[0].answers[1].id === "2" &&
      state.polls[1].question === "Which scopes?",
    JSON.stringify(state.polls),
  );
  check(
    "single-select poll: maxSelections 1; multi-select poll: one vote per option",
    state.polls[0].maxSelections === 1 && state.polls[1].maxSelections === 2,
    JSON.stringify(state.polls.map((p) => p.maxSelections)),
  );
  check(
    "text questionnaire still posts in full",
    state.posts.length === 1 && state.posts[0].includes("Which scopes?"),
  );

  // --- tap: answers through the shared path --------------------------------
  const pollId = state.polls[0].eventId;
  const consumed = mirror.onPollResponse(pollId, ["2"]);
  check("tap (answer id) consumed by the mirror", consumed === true);
  check(
    "tap is buffered + display-synced (partial emitted, model-facing zero)",
    state.answers.length === 0 && state.partials.length === 1 &&
      state.partials[0].requestId === "matrix-partial-$tc-1" &&
      state.partials[0].answers?.[0]?.questionIndex === 0 &&
      state.partials[0].answers?.[0]?.optionIndexes?.join(",") === "1",
    JSON.stringify({ answers: state.answers, partials: state.partials }),
  );
  check(
    "ack posted (the other surface sees the answer)",
    state.postResults.some((p) => p.includes("Answer noted (1/2 questions answered)")),
    JSON.stringify(state.postResults),
  );
  check("no emission yet (Q2 still open)", state.answers.length === 0);

  // --- guard rails ----------------------------------------------------------
  check("closed-mirror guard: unknown poll id drops", mirror.onPollResponse("!nope", ["2"]) === false);
  check("no-ref tap drops", mirror.onPollResponse(pollId, []) === false);
  check(
    "ref matching neither an id nor a label drops (foreign/tampered tap)",
    mirror.onPollResponse(pollId, ["not-a-ref"]) === false,
  );

  // --- completion via the MULTI poll tap + review step -----------------------
  // Q2 (multi-select): the client sends ALL selected answer ids in one
  // response — the tap resolves both to one multi entry, then review.
  mirror.onPollResponse(state.polls[1].eventId, ["1", "2"]);
  await settle();
  check(
    "multi-vote tap completes the buffer → review armed, still nothing emitted",
    state.answers.length === 0 && state.edits.some((e) => e.text.includes("🔍 Review")),
    JSON.stringify({ answers: state.answers, edits: state.edits.length }),
  );
  mirror.tryConsumeReply("confirm");
  check(
    "confirm emits ONE complete set (indexed: Q1=[1] ramda, Q2=[0,1] read+write)",
    state.answers.length === 1 &&
      state.answers[0].toolCallId === "$tc-1" &&
      state.answers[0].answers?.length === 2 &&
      state.answers[0].answers[0].questionIndex === 0 &&
      state.answers[0].answers[0].optionIndexes?.join(",") === "1" &&
      state.answers[0].answers[1].questionIndex === 1 &&
      state.answers[0].answers[1].optionIndexes?.join(",") === "0,1",
    JSON.stringify(state.answers),
  );

  // --- close ends the polls ---------------------------------------------------
  mirror.onBlocked(false);
  check(
    "close ends every posted poll (poll.end)",
    state.endedPolls.length === 2 && state.endedPolls[0] === pollId,
    JSON.stringify(state.endedPolls),
  );
  check(
    "late tap after close drops (guard)",
    mirror.onPollResponse(pollId, ["lodash"]) === false,
  );
  check("no new emissions after close", state.answers.length === 1);
}

// --- multi-select re-vote MERGE (phone client: one response per tap) -----
// The phone client (observed 2026-10-13, despite max_selections = N) emits
// one poll.response PER tap instead of a single multi-id response. Each
// tap must MERGE into the buffered selection, not replace it — a replace
// drops the earlier taps and the question ends up single-answered.
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-merge");
  await waitUntil(() => state.polls.length === 2, { label: "poll posts" });
  const multiPollId = state.polls[1].eventId;
  mirror.onPollResponse(multiPollId, ["1"]);
  await settle();
  check(
    "first tap buffers the first label (no emission)",
    state.answers.length === 0 && state.postResults.some((p) => p.includes("Answer noted")),
    JSON.stringify({ answers: state.answers, postResults: state.postResults.length }),
  );
  mirror.onPollResponse(multiPollId, ["2"]);
  await settle();
  check(
    "second tap MERGES into the buffered selection (union, not replace — verified at emission)",
    state.answers.length === 0 && state.edits.some((e) => e.text.includes("Answer noted (1/2")),
    JSON.stringify({ answers: state.answers, edits: state.edits.map((e) => e.text.slice(0, 24)) }),
  );
  // Q1 (single-select) still open: answer it so the completing buffer arms review.
  mirror.onPollResponse(state.polls[0].eventId, ["1"]);
  await settle();
  check(
    "completing buffer armed the review step",
    state.edits.some((e) => e.text.includes("🔍 Review")),
    JSON.stringify({ postResults: state.postResults.length, edits: state.edits.map((e) => e.text.slice(0, 24)) }),
  );
  mirror.tryConsumeReply("confirm");
  check(
    "confirm emits once — merged multi survives to the emission (Q2 optionIndexes 0,1)",
    state.answers.length === 1 &&
      state.answers[0].answers?.find((a) => a.questionIndex === 1)?.optionIndexes?.join(",") === "0,1",
    JSON.stringify(state.answers),
  );
}

// --- tap toggle-off: a single-ref re-vote of a selected option unselects it --
// (the Matrix poll protocol has no un-vote; the reduction is LOCAL — the
// buffer is the source of truth until confirm emits.)
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-toggle");
  await waitUntil(() => state.polls.length === 2, { label: "toggle polls" });
  const multiPollId = state.polls[1].eventId;
  mirror.onPollResponse(multiPollId, ["1"]); // read
  mirror.onPollResponse(multiPollId, ["2"]); // read + write
  mirror.onPollResponse(multiPollId, ["2"]); // re-tap write → TOGGLE OFF → [read]
  await settle();
  check(
    "single-ref re-vote of a selected option reduces the buffer (toggle-off, no emission)",
    state.answers.length === 0 &&
      (state.posts.some((p) => p.includes("Answer noted")) || state.postResults.some((p) => p.includes("Answer noted"))),
    JSON.stringify({ answers: state.answers, postResults: state.postResults.length }),
  );
  // Complete the buffer so the living review exists, then toggle the last one off.
  mirror.onPollResponse(state.polls[0].eventId, ["1"]);
  await settle();
  check(
    "completing buffer armed the review (one living message, only 'read' checked — review EDITS the status)",
    state.postResults.length === 1 &&
      state.edits.at(-1)?.text.includes("🔍 Review") &&
      state.edits.at(-1)?.text.includes("✅ read") && state.edits.at(-1)?.text.includes("⬜ write"),
    JSON.stringify({ postResults: state.postResults.length, last: state.edits.at(-1)?.text?.slice(0, 80) ?? "" }),
  );
  mirror.onPollResponse(multiPollId, ["1"]); // re-tap read (the only one left) → CLEAR
  await settle();
  check(
    "re-vote of the last selected option clears the buffer (clear marker rides the partial)",
    state.answers.length === 0 &&
      state.partials.at(-1)?.answers?.some((a) => a.questionIndex === 1 && a.optionIndexes === undefined),
    JSON.stringify(state.partials.at(-1)),
  );
  check(
    "clear posts the 'selection cleared' ack (not 'Answer noted')",
    state.edits.some((e) => e.text.includes("selection cleared")),
    JSON.stringify(state.edits.map((e) => e.text.slice(0, 24))),
  );
  check(
    "the living review message is swapped IN PLACE for the cleared status (one message, no trail)",
    state.postResults.length === 1 && state.edits.length > 0 &&
      state.edits.at(-1).text.includes("selection cleared"),
    JSON.stringify({ postResults: state.postResults.length, last: state.edits.at(-1)?.text ?? "" }),
  );
  // Re-select and re-arm, then confirm.
  mirror.onPollResponse(multiPollId, ["2"]); // write again
  mirror.tryConsumeReply("confirm");
  check(
    "confirm after re-select emits once (the cleared question answered again, Q2=[1])",
    state.answers.length === 1 &&
      state.answers[0].answers?.find((a) => a.questionIndex === 1)?.optionIndexes?.join(",") === "1",
    JSON.stringify(state.answers),
  );
}

// --- toggle-off BEFORE the review armed: the ack says "selection cleared",
// never the misleading "Answer noted (0/N" (the question is empty, not
// answered).
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-clear1");
  await waitUntil(() => state.polls.length === 2, { label: "clear polls" });
  const multiPollId = state.polls[1].eventId;
  mirror.onPollResponse(multiPollId, ["1"]); // Q2 = read (1/2)
  mirror.onPollResponse(multiPollId, ["1"]); // re-tap the ONLY selection → TOGGLE OFF → Q2 empty
  await settle();
  const lastAck = state.edits.at(-1)?.text ?? state.postResults.at(-1) ?? "";
  check(
    "toggle-off of the last selection (review not armed) acks 'selection cleared', not 'Answer noted (0/2'",
    lastAck.includes("Q2 selection cleared") &&
      !state.postResults.some((p) => p.includes("Answer noted (0/")),
    JSON.stringify(lastAck),
  );
  check(
    "the clear display-syncs to the terminal (partial with the clear marker)",
    state.partials.at(-1)?.answers?.some((a) => a.questionIndex === 1 && a.optionIndexes === undefined) === true,
    JSON.stringify(state.partials.at(-1)),
  );
  mirror.onBlocked(false);
}

// --- pi's own vote: the terminal answer's only room-visible mark ------
// A terminal-side answer has no Matrix event of its own — pi votes on its
// poll so the room SEES the answer land (latest response per voter wins:
// re-votes replace, a custom answer retracts with an empty ballot).
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-vote");
  await waitUntil(() => state.polls.length === 2, { label: "vote polls" });
  mirror.tryConsumeReply("2"); // Q1 = ramda (id "2") by ROOM TEXT (no tap exists)
  await settle();
  check(
    "room text answer casts pi's vote on the poll (visible ballot for a tap-less answer)",
    state.votes.some((v) => v.pollId === state.polls[0].eventId && v.ids.join(",") === "2" && v.labels.join(",") === "ramda"),
    JSON.stringify(state.votes),
  );
  mirror.onAnswersState({ toolCallId: "$tc-vote", answers: [
    { questionIndex: 0, question: "Which library?", kind: "option", answer: "ramda" },
    { questionIndex: 1, question: "Which scopes?", kind: "multi", answer: null, selected: ["read", "write"] },
  ] });
  await settle();
  check(
    "TERMINAL answer votes on its poll (multi mapped through the poll's ids)",
    state.votes.some((v) => v.pollId === state.polls[1].eventId && v.ids.join(",") === "1,2"),
    JSON.stringify(state.votes.at(-1) ?? null),
  );
  // Custom answer replaces the option → pi's option vote is retracted
  // (empty ballot replaces the previous one — a stale vote would lie).
  mirror.tryConsumeReply("Q1: Custom: emacs");
  await settle();
  check(
    "custom answer retracts pi's stale option vote (empty ballot)",
    state.votes.some((v) => v.pollId === state.polls[0].eventId && v.ids.length === 0),
    JSON.stringify(state.votes.slice(-2)),
  );
  // Toggle the multi back to exactly one → pi re-votes the reduced set.
  const multiPollId = state.polls[1].eventId;
  mirror.onPollResponse(multiPollId, ["2"]); // re-tap write → TOGGLE OFF → [read]
  await settle();
  check(
    "toggle-off re-votes the reduced selection (replace, not stack)",
    state.votes.at(-1)?.pollId === multiPollId && state.votes.at(-1)?.ids.join(",") === "1",
    JSON.stringify(state.votes.at(-1) ?? null),
  );
  mirror.onBlocked(false);
}

// --- polls disabled: no poll posted, text grammar alone --------------------
{
  const { state, deps } = makeDeps({ pollsEnabled: false });
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-off");
  await new Promise((r) => setTimeout(r, 20));
  check("polls off → no poll posted", state.polls.length === 0);
  check("polls off → no endPoll on close", (mirror.onBlocked(false), state.endedPolls.length === 0));
}

// --- poll post failure: warn, text fallback covers the question ------------
{
  const { state, deps } = makeDeps({ pollPostFail: true });
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-fail");
  await new Promise((r) => setTimeout(r, 20));
  check(
    "failed poll post warns (non-fatal)",
    state.warns.some((w) => w.includes("decision poll post failed")),
    JSON.stringify(state.warns),
  );
  check(
    "mirror stays usable via the text grammar",
    mirror.tryConsumeReply("2") === true && state.answers.length === 0 &&
      (state.posts.some((p) => p.includes("Answer noted")) || state.postResults.some((p) => p.includes("Answer noted"))),
  );}

// --- legacy MSC1767 voters: refs are labels, fall back to label match ----
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-legacy");
  // QS_TWO now posts TWO polls (Q1 single, Q2 multi) — the first posted
  // is Q1 (sequential loop); wait for at least the first.
  await waitUntil(() => state.polls.length >= 1, { label: "legacy poll post" });
  const pollId = state.polls[0].eventId;
  check(
    "legacy label ref resolves to the option (id match fails → label match, buffered)",
    mirror.onPollResponse(pollId, ["ramda"]) === true && state.answers.length === 0,
    JSON.stringify(state.answers),
  );
  mirror.onBlocked(false);
}

// --- single question: a tap alone completes + submits (no review step) ------
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt([{
    question: "Proceed?",
    options: [{ label: "Yes" }, { label: "No" }],
  }], "$tc-n1");
  await waitUntil(() => state.polls.length === 1, { label: "single poll post" });
  const pollId = state.polls[0].eventId;
  const consumed = mirror.onPollResponse(pollId, ["1"]);
  check("single-question tap consumed", consumed === true);
  check(
    "single-question tap emits the complete set immediately (N=1, no review step)",
    state.answers.length === 1 &&
      state.answers[0].answers?.[0]?.optionIndexes?.join(",") === "0" &&
      state.posts.some((p) => p.includes("Answered (1/1)")),
    JSON.stringify({ answers: state.answers, posts: state.posts }),
  );
  mirror.onBlocked(false);
  check("close ends the single poll", state.endedPolls.length === 1);
}

// --- N=1 MULTI-select: the first tap arms the review (no early submit),
// taps merge into the selection, and the review is ONE living message —
// edited in place, checkbox-formatted (✅ selected / ⬜ available),
// styled HTML (green instructions, bold truncated question title).
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt([
    { question: "Which scopes?", header: "Scopes", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
  ], "$tc-n1m");
  await waitUntil(() => state.polls.length === 1, { label: "poll post" });
  const pollId = state.polls[0].eventId;
  // The living review chains its post through promises — settle the
  // microtask queue before asserting on posts/edits.
  const settle = () => new Promise((r) => setTimeout(r, 0));
  mirror.onPollResponse(pollId, ["1"]);
  await settle();
  check(
    "N=1 multi-select: first tap arms the review gate (no emission — confirm ships)",
    state.answers.length === 0 &&
      state.postResults.filter((p) => p.includes("🔍 Review")).length === 1,
    JSON.stringify({ answers: state.answers, postResults: state.postResults.length }),
  );
  const reviewPosts = () => state.postResults.filter((p) => p.includes("🔍 Review"));
  check(
    "review posts ONCE as styled HTML (✅ selected / ⬜ available, green instructions, bold title)",
    reviewPosts().length === 1 &&
      reviewPosts()[0].includes("✅ read") &&
      reviewPosts()[0].includes("⬜ write") &&
      reviewPosts()[0].includes("<font color=\"#1a7f37\"><strong>🔍 Review") &&
      reviewPosts()[0].includes("<strong>Q1: Which scopes?</strong>"),
    JSON.stringify(reviewPosts()),
  );
  mirror.onPollResponse(pollId, ["2"]);
  await settle();
  check(
    "second tap merges into the buffered selection (no emission; review shows both)",
    state.answers.length === 0,
    JSON.stringify({ answers: state.answers }),
  );
  check(
    "the review is EDITED IN PLACE (one post, one edit — no message trail)",
    reviewPosts().length === 1 &&
      state.edits.length === 1 &&
      state.edits[0].targetEventId === "!msg-1" &&
      state.edits[0].text.includes("✅ read") &&
      state.edits[0].text.includes("✅ write"),
    JSON.stringify({ reviewPosts: reviewPosts().length, edits: state.edits }),
  );
  mirror.tryConsumeReply("1");
  await settle();
  check(
    "exact-set correction unselects ('1' keeps only 'read', review edited again, no emission)",
    state.answers.length === 0 &&
      state.edits.length === 2 &&
      state.edits[1].text.includes("✅ read") &&
      state.edits[1].text.includes("⬜ write"),
    JSON.stringify({ answers: state.answers, edits: state.edits }),
  );
  mirror.tryConsumeReply("confirm");
  await settle();
  check(
    "confirm emits the one complete set (Q1 optionIndexes [0]) after the review gate",
    state.answers.length === 1 &&
      state.answers[0].answers?.[0]?.optionIndexes?.join(",") === "0" &&
      state.posts.some((p) => p.includes("Answer received")),
    JSON.stringify({ answers: state.answers, posts: state.posts }),
  );
}

// --- N=1 MULTI-select: long question titles are truncated to 50 chars in
// the bold review header (the review shows WHICH question, readably).
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  const longQuestion =
    "Toggle-off retest: tap Alpha, then tap Beta, then RE-TAP Beta to verify it unchecks in the room review AND the terminal TUI";
  await mirror.onPrompt([
    { question: longQuestion, header: "Toggle", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
  ], "$tc-long");
  await waitUntil(() => state.polls.length === 1, { label: "poll post" });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  mirror.onPollResponse(state.polls[0].eventId, ["1"]);
  await settle();
  const review = state.postResults.find((p) => p.includes("🔍 Review")) ?? "";
  check(
    "long question title truncated to 50 chars + ellipsis in the bold review header",
    review.includes(`<strong>Q1: ${longQuestion.slice(0, 50)}…</strong>`),
    review,
  );
}

// --- N=1 MULTI-select: a custom answer during the review replaces the
// selection — the living review shows the custom text; confirm finalizes it.
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt([
    { question: "Which scopes?", header: "Scopes", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
  ], "$tc-custom");
  await waitUntil(() => state.polls.length === 1, { label: "poll post" });
  const pollId = state.polls[0].eventId;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  mirror.onPollResponse(pollId, ["1", "2"]);
  await settle();
  mirror.tryConsumeReply("Custom: read + audit");
  await settle();
  check(
    "custom answer replaces the selection (review shows the custom text, no emission)",
    state.answers.length === 0 &&
      state.postResults.filter((p) => p.includes("🔍 Review")).length === 1 &&
      state.edits.some((e) => e.text.includes('"read + audit" (custom)')),
    JSON.stringify({ answers: state.answers, edits: state.edits }),
  );
  mirror.tryConsumeReply("confirm");
  await settle();
  check(
    "confirm finalizes the custom answer (emitted as text)",
    state.answers.length === 1 && state.answers[0].answers?.[0]?.text === "read + audit",
    JSON.stringify(state.answers),
  );
}


// --- eligibility: <2 or >10 options skip the poll (MSC3381 caps) ------------
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `opt${i}` }));
  await mirror.onPrompt([
    { question: "one opt", options: [{ label: "only" }] },
    { question: "eleven opts", options: eleven },
    { question: "ten opts", options: eleven.slice(0, 10) },
  ], "$tc-caps");
  await waitUntil(() => state.polls.length === 1, { label: "ten-opt poll post" });
  check(
    "only the 10-option question got a poll (1 and 11 skipped)",
    state.polls.length === 1 && state.polls[0].question === "ten opts",
    JSON.stringify(state.polls.map((p) => p.question)),
  );
  mirror.onBlocked(false);
}

// --- a re-prompt resets + re-ends nothing stale -----------------------------
{
  const { state, deps } = makeDeps();
  const mirror = createAskUserMirror(deps);
  await mirror.onPrompt(QS_TWO, "$tc-re1");
  await waitUntil(() => state.polls.length === 2, { label: "first poll pair" });
  const firstPollId = state.polls[0].eventId;
  await mirror.onPrompt(QS_TWO, "$tc-re2"); // re-ask: fresh prompt supersedes
  await waitUntil(() => state.polls.length === 4, { label: "second poll pair" });
  const secondPollId = state.polls[2].eventId;
  check(
    "re-prompt issued a new poll id",
    firstPollId !== undefined && secondPollId !== undefined && firstPollId !== secondPollId,
  );
  check(
    "re-prompt ended the superseded poll (poll.end)",
    state.endedPolls.includes(firstPollId),
    JSON.stringify(state.endedPolls),
  );
  // A tap on the SUPERSEDED poll drops (its map entry was reset).
  check(
    "tap on the superseded poll drops",
    mirror.onPollResponse(firstPollId, ["2"]) === false && state.answers.length === 0,
  );
  check(
    "tap on the current poll works",
    mirror.onPollResponse(secondPollId, ["2"]) === true,
  );
}

// --- parseMirrorReply: multi-line custom answers --------------------------
// (a `Custom:`/`Text:`-prefixed reply is ONE custom answer — the text may
// span multiple lines; the segment split would shatter it on every newline)
{
  const qs = [QS_TWO[0]];
  const multiline = "Custom: better: the RPIV ask_userquestion dialogue now works again.\nItems selected in the matrix mirror are now also selected in the user dialogue\n- still broken: revoting on an item does not unselect it";
  const multi = parseMirrorReply(multiline, qs);
  check(
    "multi-line 'Custom:' reply parses as ONE custom entry (full text preserved)",
    multi.length === 1 && multi[0].kind === "custom" && multi[0].questionIndex === 0 &&
      multi[0].answer.startsWith("better: the RPIV") && multi[0].answer.includes("does not unselect it"),
    JSON.stringify(multi),
  );
  const targeted = parseMirrorReply("Q1: Text: line one\nline two", qs);
  check(
    "'Qn: Custom:' / 'Qn: Text:' targets the named question, multi-line intact",
    targeted.length === 1 && targeted[0].kind === "custom" && targeted[0].answer === "line one\nline two",
    JSON.stringify(targeted),
  );
  const bare = parseMirrorReply("custom:", qs);
  check("empty custom text falls through (no entry → caller nudges)", bare.length === 0, JSON.stringify(bare));
  const single = parseMirrorReply("Custom: plain single line", qs);
  check(
    "single-line 'Custom:' still parses (unchanged behavior)",
    single.length === 1 && single[0].kind === "custom" && single[0].answer === "plain single line",
    JSON.stringify(single),
  );
  const mixed = parseMirrorReply("2\nCustom: also custom", qs);
  check(
    "non-custom segments are unaffected (a bare number still parses as an option, alongside the custom line)",
    mixed.length === 2 && mixed[0].kind === "option" && mixed[0].answer === "ramda" &&
      mixed[1].kind === "custom" && mixed[1].answer === "also custom",
    JSON.stringify(mixed),
  );
}

finish();
