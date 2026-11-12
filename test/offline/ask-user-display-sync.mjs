/**
 * ask-user-display-sync.mjs — the display-sync safety gate.
 *
 * The room mirror pushes a snapshot of the buffered answers onto the answer
 * channel as a DISPLAY-ONLY set (`partial: true`) so the mounted terminal tab
 * follows the room. The answer channel's documented policy is to IGNORE
 * UNKNOWN FIELDS — so against a stock @juicesharp/rpiv-ask-user-question (no
 * pairing patch; the demo container ran 2.15.0 while these patches were cut
 * against 2.13.9) that snapshot is simply a complete answer set, and the
 * package settles the wait the moment the last room reply lands: the room is
 * still showing "confirm" while the session has already moved on.
 *
 * Contract under test: a display-sync snapshot that covers EVERY question
 * ships only after an earlier partial of the same questionnaire came back
 * `ok` (proof the receiver knows the flag), and a refusal is logged once.
 *
 *   node test/offline/ask-user-display-sync.mjs
 */
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createAskUserMirror } = await jiti.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));

const { check, finish } = makeCheck("ask-user-display-sync");

const QUESTIONS = [
  { question: "Which layout?", header: "Layout", options: [{ label: "a" }, { label: "b" }] },
  { question: "Commit plan?", header: "Commit", options: [{ label: "one" }, { label: "two" }] },
];
const N = QUESTIONS.length;
const settle = () => new Promise((r) => setTimeout(r, 5));

/** A questionnaire receiver: the answer channel's verdict side, plus the two
 *  observable outcomes (a display-sync set it registered, an answer that
 *  settled the wait).
 *
 *  `patched` = it knows the `partial` flag. `stock` = it does NOT: the flag is
 *  an unknown field that vanishes, and the payload is judged on its answers
 *  alone — exactly the published package's documented behaviour. */
function openReceiver({ patched }) {
  const seen = { partials: [], settled: null, refused: 0 };
  const warnings = [];
  const emit = (v) => mirror.onAnswerResult(v);
  const mirror = createAskUserMirror({
    post: async () => ({ success: true, eventId: "!m" }),
    isEnabled: () => true,
    emitAnswer: (payload) => {
      const verdict = (ok, code, reason) => ({
        ok,
        requestId: payload.requestId,
        ...(code ? { code, reason } : {}),
      });
      let v;
      if (payload.cancel) {
        seen.settled = { cancelled: true };
        v = verdict(true);
      } else if (payload.partial && patched) {
        seen.partials.push(payload);
        v = verdict(true);
      } else {
        // Stock path, both for a flagged display-sync set and for the confirm
        // emission: complete answers are an answer, anything short is refused.
        const answers = payload.answers ?? [];
        if (answers.length === N) {
          seen.settled = { answers, cancelled: false };
          v = verdict(true);
        } else {
          seen.refused += 1;
          v = verdict(false, "invalid_answer", `no answer for question ${answers.length}`);
        }
      }
      emit(v); // the real channel replies synchronously on `answer-result`
    },
    warn: (m) => warnings.push(m),
  });
  return { seen, warnings, mirror };
}

async function roomReplies(toolCallId, ...bodies) {
  const r = openReceiver({ patched: false });
  await r.mirror.onPrompt(QUESTIONS, toolCallId);
  for (const body of bodies) r.mirror.tryConsumeReply(body);
  await settle();
  return r;
}

// 1. Stock package, one question per reply: the pairing probe is refused, the
//    refused display-sync sets must NEVER turn into the answer, and the room
//    review stays the gate.
{
  const r = await roomReplies("tc-stock", "Q1: 2", "Q2: 1");
  check("stock: no display-sync set settles the questionnaire", r.seen.settled === null, JSON.stringify(r.seen.settled));
  // Two attempts reach the channel — the open-of-questionnaire probe and the
  // first (incomplete) snapshot. The completing one is never emitted: that is
  // the gate.
  check("stock: probe + first snapshot refused, completing snapshot never shipped", r.seen.refused === 2, String(r.seen.refused));
  check(
    "stock: the refusal is logged once, naming the patch check",
    r.warnings.filter((w) => /apply\.sh --check/.test(w)).length === 1,
    JSON.stringify(r.warnings),
  );
  r.mirror.tryConsumeReply("confirm");
  await settle();
  check("stock: confirm still ships the complete answer", r.seen.settled?.cancelled === false, JSON.stringify(r.seen.settled));
}

// 2. Stock package, BOTH questions in one combined reply: the very first
//    answer-bearing emission is already a complete set, so it must not ship —
//    the refused probe at open time is what withholds it.
{
  const r = await roomReplies("tc-combined", "1: 1; 2: 2");
  check("stock: a combined reply cannot answer on the user's behalf", r.seen.settled === null, JSON.stringify(r.seen.settled));
  check("stock: only the probe reached the channel", r.seen.refused === 1, String(r.seen.refused));
}

// 3. Patched package: the probe is accepted, so the display sync — including
//    the completing snapshot — reaches the terminal.
{
  const r = openReceiver({ patched: true });
  await r.mirror.onPrompt(QUESTIONS, "tc-patched");
  await settle();
  r.mirror.tryConsumeReply("Q1: 2");
  await settle();
  r.mirror.tryConsumeReply("Q2: 1");
  await settle();
  check(
    "patched: probe accepted, then one snapshot per reply, the last complete",
    r.seen.partials.length === 3 &&
      r.seen.partials[0].answers.length === 0 &&
      r.seen.partials[2].answers.length === N,
    JSON.stringify(r.seen.partials),
  );
  check("patched: a partial never settles the wait", r.seen.settled === null);
  check("patched: nothing to warn about", r.warnings.length === 0, JSON.stringify(r.warnings));
  r.mirror.tryConsumeReply("confirm");
  await settle();
  check("patched: confirm resolves the wait", r.seen.settled?.cancelled === false);
}

finish();
