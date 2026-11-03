/**
 * Full-loop test: matrix-side AskUserMirror (emit) +
 * @juicesharp/rpiv-ask-user-question's NATIVE answer channel (consume),
 * one shared event bus.
 *
 * Simulates: RPIV questionnaire blocks → mirror posts it to the room
 * (captured) → phone replies "2" then "Q2: 1 2" (buffered — the channel
 * refuses partial sets) → "👍" at the review step emits ONE complete
 * `rpiv:ask-user:answer` (toolCallId + option indexes) → the package
 * validates, answers on `answer-result`, and resolves the blocked tool.
 */
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const PKG_DIR =
	"/Users/vincentjansen/.local/share/fnm/node-versions/v24.18.0/installation/lib/node_modules/@earendil-works/pi-coding-agent";
const EXT_DIR = "/Users/vincentjansen/.pi/agent/extensions/pi-matrix-integration";
const RPIV_DIR = "/Users/vincentjansen/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question";
const { createJiti } = await import(`${PKG_DIR}/node_modules/jiti/lib/jiti-static.mjs`);
const require = createRequire(`${PKG_DIR}/package.json`);
const alias = {
	"@earendil-works/pi-coding-agent": `${PKG_DIR}/dist/index.js`,
	"@earendil-works/pi-tui": `${PKG_DIR}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	typebox: require.resolve("typebox"),
	"typebox/compile": require.resolve("typebox/compile"),
	"typebox/value": require.resolve("typebox/value"),
};
const jt = createJiti(fileURLToPath(import.meta.url), { moduleCache: false, alias });
let pass = 0, fail = 0;
const check = (n, c, x = "") => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

// Shared bus — the same shape as pi's EventBus (emit/on).
const makeBus = () => {
	const h = new Map();
	return {
		emit(ch, d) { for (const f of [...(h.get(ch) ?? [])]) f(d); },
		on(ch, f) { if (!h.has(ch)) h.set(ch, new Set()); h.get(ch).add(f); return () => h.get(ch).delete(f); },
	};
};
const bus = makeBus();

const QUESTIONS = [
	{ question: "Pick a library?", header: "Lib", options: [{ label: "lodash" }, { label: "ramda" }] },
	{ question: "Pick scopes?", header: "Scopes", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
];

// --- consumer side: the real tool + native answer channel, on the bus ---
const toolMod = await jt.import(RPIV_DIR + "/ask-user-question.ts");
let tool = null;
toolMod.registerAskUserQuestionTool({ registerTool: (d) => { tool = d; }, events: bus, on: () => {} });
check("tool registered on the bus", tool?.name === "ask_user_question");

// --- emit side: the mirror, wired exactly like index.ts -------------------
const { createAskUserMirror } = await jt.import(EXT_DIR + "/src/ask-user-mirror.ts");
const roomPosts = [];
const mirror = createAskUserMirror({
	post: async (text) => { roomPosts.push(text); return { success: true, eventId: "$sim" }; },
	isEnabled: () => true,
	emitAnswer: (payload) => bus.emit("rpiv:ask-user:answer", payload),
});
// index.ts wiring: prompt → mirror.onPrompt (+ toolCallId), verdicts →
// mirror.onAnswerResult, reply consumed in onMessage.
bus.on("rpiv:ask-user:prompt", (d) => mirror.onPrompt(d.questions, d.toolCallId));
bus.on("rpiv:ask-user:answer-result", (d) => mirror.onAnswerResult(d));

// --- run the tool with a fake TUI that parks until the bus answers --------
let doneFromSession = null;
let sessionReadyResolve;
// Settle once the factory has constructed the session (`sessionRef.current`
// exists) so the prompt event is out — the test awaits it before the first
// bus reply; the 2.13 answer channel accepts answers from the moment the
// prompt is emitted.
const sessionReady = new Promise((r) => (sessionReadyResolve = r));
const theme = { fg: (c, t) => t, bg: (c, t) => t, bold: (t) => t, dim: (t) => t, inverse: (t) => t, underline: (t) => t, red: (t) => t, green: (t) => t, yellow: (t) => t, blue: (t) => t, cyan: (t) => t, magenta: (t) => t, gray: (t) => t };
const ctx = {
	hasUI: true,
	ui: {
		// The promise resolves exactly when the session's done effect fires
		// (terminal OR external submit) — the 4th factory argument. The
		// factory runs synchronously here: no timer that could race the
		// test's own sequencing.
		custom: (factory) =>
			new Promise((res) => {
				try {
					const c = factory({ requestRender() {}, invalidate() {}, isDestroyed() { return false; }, rows: 40, columns: 100, terminal: { rows: 40, cols: 100 } }, theme, { matches: () => false }, (r) => { doneFromSession = r; res(r); });
					c && c.render(80);
				} catch { /* fake-tui render limits */ }
				sessionReadyResolve();
			}),
	},
};

const executePromise = tool.execute("tc", { questions: QUESTIONS }, new AbortController().signal, () => {}, ctx);

// The session exists and the prompt is mirrored before any room reply.
await sessionReady;
check("prompt mirrored to the room", roomPosts.length === 1 && roomPosts[0].includes("Pick a library?") && roomPosts[0].includes("[multi]"), roomPosts[0]?.slice(0, 80));

check("phone reply 1: '2' consumed as an answer", mirror.tryConsumeReply("2") === true, "");
check("chat while open is NOT consumed", mirror.tryConsumeReply("lunch?") === false, "");
const partialVerdicts = [];
bus.on("rpiv:ask-user:answer-result", (d) => { if (typeof d.requestId === "string" && d.requestId.startsWith("matrix-partial-")) partialVerdicts.push(d); });
mirror.tryConsumeReply("1: 2"); // re-answer Q1 identically: buffer unchanged, partial re-sent
check(
	"display-sync partial accepted by the patched package (verdict ok, tool still awaiting)",
	partialVerdicts.some((v) => v.ok === true) && !doneFromSession,
	JSON.stringify(partialVerdicts),
);
check("tool still parked (partial never resolves the wait)", !doneFromSession, "");

// The reply-1 ack is the living message's first post; reply-2's update
// chains onto its settle — flush the microtask queue before asserting.
await new Promise((r) => setTimeout(r, 0));
check("phone reply 2: 'Q2: 1 2' completes the buffer → review armed", mirror.tryConsumeReply("Q2: 1 2") === true && roomPosts.some((p) => p.includes("🔍 Review")), "");
check(
	"'👍' at the review step emits the ONE complete set (toolCallId 'tc', indexed entries)",
	mirror.tryConsumeReply("👍") === true,
	"",
);
const envelope = await executePromise;
const text = envelope.content?.[0]?.text ?? "";
check("tool resolved with both room answers", text.includes('"Pick a library?"="ramda"') && text.includes('"Pick scopes?"="read, write"'), text.slice(0, 200));
check("session done-effect fired from room answers", doneFromSession?.answers?.[0]?.answer === "ramda" && doneFromSession?.answers?.[1]?.selected?.length === 2, JSON.stringify(doneFromSession?.answers));

console.log(`\nfull-loop: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
