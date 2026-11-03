/**
 * Integration test: patch A2.13-0001 (partial answer registration) against
 * the INSTALLED @juicesharp/rpiv-ask-user-question, real tool + real session
 * on a fake TUI, hand-built channel payloads (the mirror's own emission
 * paths are covered by test-logic/test-polls; this proves the PACKAGE side):
 *
 *   - a `partial` set registers into the mounted dialog (its render changes,
 *     the tab advances) WITHOUT resolving the wait;
 *   - an empty entry clears the registered answer (render reverts);
 *   - partial+cancel → invalid_payload; out-of-range → invalid_answer;
 *   - a complete flagless set still resolves; partial after close → not_found.
 *
 *   node test/integration/partial-channel.mjs
 */
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPiJiti } from "../_harness.mjs";

const PKG_DIR = path.dirname(path.dirname(path.dirname(process.execPath))) +
	"/lib/node_modules/@earendil-works/pi-coding-agent";
const RPIV_DIR =
	process.env.RPIV_AUQ_PKG || `${homedir()}/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`;
if (!existsSync(RPIV_DIR + "/answer-channel.ts")) {
	console.error(`package not found at ${RPIV_DIR} — skip (install it or set RPIV_AUQ_PKG).`);
	process.exit(0);
}
if (!/Patch A2\.13-0001/.test((await import("node:fs")).readFileSync(RPIV_DIR + "/answer-channel.ts", "utf8"))) {
	console.error("patch A2.13-0001 not applied — skip (run the kit's apply.sh).");
	process.exit(0);
}

const jt = await createPiJiti(import.meta.url);
let pass = 0, fail = 0;
const check = (n, c, x = "") => { if (c) { pass++; console.log("  ok  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

const makeBus = () => {
	const h = new Map();
	return {
		emit(ch, d) { for (const f of [...(h.get(ch) ?? [])]) f(d); },
		on(ch, f) { if (!h.has(ch)) h.set(ch, new Set()); h.get(ch).add(f); return () => h.get(ch).delete(f); },
	};
};
const bus = makeBus();
const verdicts = [];
bus.on("rpiv:ask-user:answer-result", (d) => verdicts.push(d));
const answersState = []; // patch A2.13-0002 outbound broadcasts
bus.on("rpiv:ask-user:answers-state", (d) => answersState.push(d));

const QUESTIONS = [
	{ question: "Pick a library?", header: "Lib", options: [{ label: "lodash" }, { label: "ramda" }] },
	{ question: "Pick scopes?", header: "Scopes", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
];

const toolMod = await jt.import(RPIV_DIR + "/ask-user-question.ts");
let tool = null;
toolMod.registerAskUserQuestionTool({ registerTool: (d) => { tool = d; }, events: bus, on: () => {} });

const theme = { fg: (c, t) => t, bg: (c, t) => t, bold: (t) => t, dim: (t) => t, inverse: (t) => t, underline: (t) => t, red: (t) => t, green: (t) => t, yellow: (t) => t, blue: (t) => t, cyan: (t) => t, magenta: (t) => t, gray: (t) => t };
let comp = null;
let doneFromSession = null;
let sessionReadyResolve;
const sessionReady = new Promise((r) => (sessionReadyResolve = r));
const ctx = {
	hasUI: true,
	ui: {
		custom: (factory) =>
			new Promise((res) => {
				try {
					const c = factory({ requestRender() {}, invalidate() {}, isDestroyed() { return false; }, rows: 40, columns: 100, terminal: { rows: 40, cols: 100 } }, theme, { matches: () => false }, (r) => { doneFromSession = r; res(r); });
					comp = c;
					c && c.render(80);
				} catch { /* fake-tui render limits */ }
				sessionReadyResolve();
			}),
	},
};
const executePromise = tool.execute("tc", { questions: QUESTIONS }, new AbortController().signal, () => {}, ctx);
await sessionReady;
check("tool registered + session mounted", tool?.name === "ask_user_question" && comp !== null);

const renderBefore = comp?.render(80)?.join("\n") ?? "";
bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "p1", partial: true, answers: [{ questionIndex: 0, optionIndexes: [1] }] });
check("partial accepted (verdict ok)", verdicts.some((v) => v.requestId === "p1" && v.ok === true), JSON.stringify(verdicts));
const renderAfter = comp?.render(80)?.join("\n") ?? "";
check("partial REGISTERED in the mounted dialog (render changed)", renderBefore !== renderAfter && renderAfter !== "", "");
check("wait NOT resolved by partial", doneFromSession === null);
check(
	"answers-state broadcast on registration (patch 0002: full map, labeled)",
	answersState.length === 1 && answersState[0].toolCallId === "tc" &&
		answersState[0].answers?.length === 1 && answersState[0].answers?.[0]?.questionIndex === 0 &&
		answersState[0].answers?.[0]?.kind === "option" && answersState[0].answers?.[0]?.answer === "ramda",
	JSON.stringify(answersState.at(-1) ?? null),
);

bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "p2", partial: true, answers: [{ questionIndex: 0, optionIndexes: [] }] });
check("partial clear accepted (verdict ok)", verdicts.some((v) => v.requestId === "p2" && v.ok === true));
check("clear REVERTED the render", comp?.render(80)?.join("\n") === renderBefore, "");

bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "p3", partial: true, cancel: true });
check("partial+cancel refused (invalid_payload)", verdicts.some((v) => v.requestId === "p3" && v.ok === false && v.code === "invalid_payload"), JSON.stringify(verdicts.at(-1)));

bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "p4", partial: true, answers: [{ questionIndex: 9, optionIndexes: [0] }] });
check("out-of-range partial refused (invalid_answer)", verdicts.some((v) => v.requestId === "p4" && v.ok === false && v.code === "invalid_answer"));

bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "c1", answers: [{ questionIndex: 0, optionIndexes: [1] }, { questionIndex: 1, optionIndexes: [0, 1] }] });
const envelope = await executePromise;
const text = envelope.content?.[0]?.text ?? "";
check("complete set still resolves the tool", text.includes('"Pick a library?"="ramda"') && text.includes('"Pick scopes?"="read, write"'), text.slice(0, 200));

bus.emit("rpiv:ask-user:answer", { toolCallId: "tc", requestId: "p5", partial: true, answers: [{ questionIndex: 0, optionIndexes: [0] }] });
check("partial after close → not_found", verdicts.some((v) => v.requestId === "p5" && v.ok === false && v.code === "not_found"));
const statesAtClose = answersState.length;
check("no answers-state broadcast after the session settled", answersState.length === statesAtClose, JSON.stringify(answersState.slice(statesAtClose)));

console.log(`\npartial-channel: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
