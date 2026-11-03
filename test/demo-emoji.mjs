/**
 * Demo: emoji responses in the ask-user mirror.
 *
 * Loads the real src/ask-user-mirror.ts (like pi does) with a mock
 * ExtensionAPI that prints each post to the room as a transcript, then
 * plays a phone user answering a yes/no decision with 👍/👎 — including
 * the review step ("Qn: x" corrects, "👍" sends the complete set, "👎"
 * declines via the upstream cancel path).
 *
 *   node test/demo-emoji.mjs
 */
import path from "node:path";
import { createPiJiti, EXT_DIR } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createAskUserMirror } = await jiti.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));

// ---- transcript capture ----------------------------------------------------
const room = [];
function show(label, text) {
  if (label === "room") {
    room.push(text);
    console.log(`🤖 Pi →`);
    text.split("\n").forEach((l) => console.log(`   ${l}`));
  } else if (label === "you") console.log(`\n🧑 you:   ${text}`);
  else if (label === "tui") console.log(`   ▸ TUI: ${text}`);
  else console.log(`\n${text}`);
}

const mirror = createAskUserMirror({
  post: async (text) => {
    show("room", text);
    return { success: true, eventId: "$demo" };
  },
  isEnabled: () => true,
  emitAnswer: (p) =>
    show("tui", p.cancel ? "CANCEL emitted → model is told the user declined" : `ANSWER emitted → ${JSON.stringify(p.answers)}`),
});

const reply = async (text, m = mirror) => {
  show("you", text);
  const consumed = m.tryConsumeReply(text);
  show("tui", consumed ? "room reply consumed by the mirror" : "ordinary chat → injected into the session");
};

console.log("════ RPIV decision: yes/no questions, answered with emoji ════\n");

// The RPIV package prompts: two yes/no-shaped questions.
await mirror.onPrompt([
  { question: "Proceed with the refactor?", header: "Decision", options: [{ label: "Yes" }, { label: "No" }] },
  { question: "Approve the plan as written?", header: "Review", options: [{ label: "Approve" }, { label: "Reject" }] },
], "$tc-demo");

// --- question phase ---------------------------------------------------------
console.log("\n── question phase (emoji alias → yes/no-ish option) ──");
await reply("👍"); // → Q1 = Yes
await reply("👎"); // → Q2 = Reject (first unanswered)

// --- review step ------------------------------------------------------------
console.log("\n── review step (buffered; nothing sent until confirm) ──");
await reply("Q2: ✅"); // → correct Q2 to Approve, review edited in place
await reply("👍"); // → ONE complete-set emission, wait resolves

// --- decline ----------------------------------------------------------------
console.log("\n── review step: 👎 declines (upstream cancel path) ──");
const mirrorD = createAskUserMirror({
  post: async (text) => {
    show("room", text);
    return { success: true, eventId: "$demoD" };
  },
  isEnabled: () => true,
  emitAnswer: (p) =>
    show("tui", p.cancel ? "CANCEL emitted → model is told the user declined" : `ANSWER emitted → ${JSON.stringify(p.answers)}`),
});
await mirrorD.onPrompt([
  { question: "Deploy to production?", header: "Ship?", options: [{ label: "Yes" }, { label: "No" }] },
  { question: "Notify the channel?", header: "Tell?", options: [{ label: "Yes" }, { label: "No" }] },
], "$tc-decline");
await reply("1 1", mirrorD); // complete the buffer → review
await reply("👎", mirrorD); // → cancel:true emission, model told the user declined

// --- edge cases ---------------------------------------------------------------
console.log("\n── edge case: emoji on a question without yes/no-ish options ──");
const mirror2 = createAskUserMirror({
  post: async (text) => {
    show("room", text);
    return { success: true, eventId: "$demo2" };
  },
  isEnabled: () => true,
  emitAnswer: () => undefined,
});
await mirror2.onPrompt([
  { question: "Which library?", options: [{ label: "lodash" }, { label: "ramda" }, { label: "none" }] },
], "$tc2");
await reply("👍", mirror2); // no yes-ish option → grammar nudge, still consumed (not chat)

console.log("\n════ transcript done ════");
