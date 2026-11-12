/**
 * Integration test: the Matrix ask-user mirror against the INSTALLED
 * @juicesharp/rpiv-ask-user-question (real tool + real mounted dialog on a
 * fake TUI), driven by simulated room replies. Covers the two regressions:
 *
 *   1. a room reply registers into the mounted terminal dialog (the TUI tab
 *      follows the room) via the display-sync partial set;
 *   2. the completing room reply arms the room-side review step and does NOT
 *      resolve the wait — the terminal may not continue before "confirm".
 *
 *   node test/integration/mirror-partial-sync.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createPiJiti, makeCheck, EXT_DIR } from "../harness/_harness.mjs";

const RPIV_DIR =
  process.env.RPIV_AUQ_PKG || `${homedir()}/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`;
if (!existsSync(RPIV_DIR + "/answer-channel.ts")) {
  console.error(`package not found at ${RPIV_DIR} — skip (install it or set RPIV_AUQ_PKG).`);
  process.exit(0);
}

const RPIV_PATCHED = readFileSync(RPIV_DIR + "/answer-channel.ts", "utf8").includes("A2.13-0001");

const jt = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("mirror-partial-sync");

const bus = (() => {
  const h = new Map();
  return {
    emit(ch, d) { for (const f of [...(h.get(ch) ?? [])]) f(d); },
    on(ch, f) { if (!h.has(ch)) h.set(ch, new Set()); h.get(ch).add(f); return () => h.get(ch).delete(f); },
  };
})();

// --- the real tool, mounted on a fake TUI -------------------------------------
let tool = null;
const toolMod = await jt.import(RPIV_DIR + "/ask-user-question.ts");
toolMod.registerAskUserQuestionTool({ registerTool: (d) => { tool = d; }, events: bus, on: () => {} });

const theme = {};
for (const m of ["fg", "bg"]) theme[m] = (c, t) => t;
for (const m of ["bold", "dim", "inverse", "underline", "red", "green", "yellow", "blue", "cyan", "magenta", "gray"])
  theme[m] = (t) => t;

let comp = null;
let settled = null;
let mounted;
const mountedReady = new Promise((r) => (mounted = r));
const ctx = {
  hasUI: true,
  ui: {
    custom: (factory) =>
      new Promise((res) => {
        try {
          const c = factory(
            { requestRender() {}, invalidate() {}, isDestroyed() { return false; }, rows: 40, columns: 100, terminal: { rows: 40, cols: 100 } },
            theme,
            { matches: () => false },
            (r) => { settled = r; res(r); },
          );
          comp = c;
          c && c.render(120);
        } catch { /* fake-tui render limits */ }
        mounted();
      }),
  },
};

const QUESTIONS = [
  { question: "Pick a library?", header: "Lib", options: [{ label: "lodash" }, { label: "ramda" }] },
  { question: "Ship it?", header: "Ship", options: [{ label: "yes" }, { label: "no" }] },
];
const executePromise = tool.execute("tc-1", { questions: QUESTIONS }, new AbortController().signal, () => {}, ctx);
await mountedReady;
check("dialog mounted", comp !== null && tool?.name === "ask_user_question");

// --- the mirror, wired to the same bus ---------------------------------------
const { createAskUserMirror } = await jt.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));
const posted = [];
const mirror = createAskUserMirror({
  post: async (t) => { posted.push(t); return { success: true, eventId: `$ev${posted.length}` }; },
  postResult: async (t) => { posted.push(t); return { success: true, eventId: `$ev${posted.length}` }; },
  edit: async () => ({ success: true }),
  isEnabled: () => true,
  emitAnswer: (p) => bus.emit("rpiv:ask-user:answer", p),
  pollsEnabled: () => false,
});
const states = [];
const emitted = [];
bus.on("rpiv:ask-user:answer-result", (d) => mirror.onAnswerResult(d));
bus.on("rpiv:ask-user:answers-state", (d) => { states.push(d); mirror.onAnswersState(d); });
bus.on("rpiv:ask-user:answer", (d) => emitted.push(d));

await mirror.onPrompt(QUESTIONS, "tc-1");
const renderEmpty = comp?.render(120)?.join("\n") ?? "";

// --- regression 1: a room reply registers in the terminal dialog ------------
const consumed1 = mirror.tryConsumeReply("Q1: 2");
const renderAfter1 = comp?.render(120)?.join("\n") ?? "";
check("room reply consumed", consumed1 === true);
if (RPIV_PATCHED) {
  // Proof of registration: the dialog broadcasts its answer map on every change
  // (patch 0002), so a broadcast naming this answer means the DIALOG holds it.
  // The tab also advances to the next unanswered question.
  check(
    "REGRESSION 1: room answer registered in the mounted TUI dialog",
    states.some((s) => s.answers?.some((a) => a.questionIndex === 0 && a.answer === "ramda")) &&
      renderAfter1 !== renderEmpty &&
      /Ship it\?/.test(renderAfter1),
    `EMITTED=${JSON.stringify(emitted)}\nSTATES=${JSON.stringify(states)}`,
  );
} else {
  // A stock package has no display-only mode: it would judge this set as a
  // real answer and refuse it as incomplete. Registration is impossible there
  // — see test/offline/ask-user-display-sync.mjs for what the mirror does
  // instead (refuse, warn once, never answer on the user's behalf).
  console.log("  skip  REGRESSION 1 registration — pairing patch A2.13-0001 not applied to " + RPIV_DIR);
  check("stock package: the refused display-sync set registered nothing", states.length === 0, JSON.stringify(states));
}
check("wait NOT resolved after 1/2", settled === null);

// --- regression 2: the completing reply arms review, does not resolve -------
const consumed2 = mirror.tryConsumeReply("Q2: 1");
const renderAfter2 = comp?.render(120)?.join("\n") ?? "";
check("completing room reply consumed", consumed2 === true);
check(
  "REGRESSION 2: wait still open — room review is the gate",
  settled === null,
  `settled=${JSON.stringify(settled)}\nEMITTED=${JSON.stringify(emitted)}`,
);
check(
  "completing reply ships a partial, never a complete set",
  emitted.filter((p) => !p.partial).length === 0,
  JSON.stringify(emitted),
);
check(
  "room review armed with a confirm hint",
  posted.some((t) => /confirm/i.test(t)),
  JSON.stringify(posted),
);

// --- confirm ships the complete set and resolves ---------------------------
mirror.tryConsumeReply("confirm");
const envelope = await executePromise;
check("confirm resolves the wait", (envelope.content?.[0]?.text ?? "").includes("ramda"));

finish();
