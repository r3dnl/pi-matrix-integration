/**
 * LLM judge for thread-summary quality (release story 13).
 *
 * PER RELEASE ONLY — never per push: model judging is nondeterministic and
 * costs tokens (test-cycle discipline). Run it after the scenario suite:
 *
 *   node test/live/judge-summary.mjs [artifacts/live-<run-id>]
 *
 * Reads the rewritten thread root (the summary the room shows) from the
 * scenario run's evidence, asks a judge model for a rubric verdict, and
 * SAVES the verdict next to the run — the judgement is part of the release
 * evidence, not a throwaway log line.
 *
 * The judge endpoint is an OpenAI-compatible server from the environment:
 *   PI_MATRIX_JUDGE_BASE_URL  (default http://127.0.0.1:8000)
 *   PI_MATRIX_JUDGE_MODEL     (required — the run refuses to guess a model)
 *   PI_MATRIX_JUDGE_API_KEY   (optional bearer)
 *
 * This is deliberately not part of `npm run test:live`: the gate stays
 * deterministic. Exit 0 only when the judge passes every rubric gate.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.PI_MATRIX_JUDGE_BASE_URL ?? "http://127.0.0.1:8000";
const MODEL = process.env.PI_MATRIX_JUDGE_MODEL;
if (!MODEL) {
  console.error("judge refuses to run — set PI_MATRIX_JUDGE_MODEL (and PI_MATRIX_JUDGE_BASE_URL if not " + BASE + ")");
  process.exit(1);
}

const runsRoot = path.resolve(import.meta.dirname, "..", "..", "artifacts");
const runDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(runsRoot, fs.readdirSync(runsRoot).filter((d) => /^live-\d+$/.test(d)).sort().at(-1));
const summaryPath = path.join(runDir, "8-summary-rewrites-root.json");
if (!fs.existsSync(summaryPath)) {
  console.error(`no scenario-8 evidence at ${summaryPath} — run npm run test:live first (or pass a run dir)`);
  process.exit(1);
}
const evidence = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const summaryMd = String(evidence.evidence?.editEvent?.body ?? "");
const rootBody = String(evidence.evidence?.editEvent?.original_body ?? "");
if (!summaryMd.trim()) {
  console.error(`scenario 8 evidence carries no summary body`);
  process.exit(1);
}

const RUBRIC = `You judge ONE artifact: the summary a Matrix thread root shows a phone-only reader of a coding session.

Score each rubric line 0-10 and answer strictly as JSON:
{"topic": n, "faithful": n, "decisions": n, "quiet": n, "pass": true|false, "notes": "one or two sentences"}

Rubric:
- topic: the "# Topic" line names what the session is actually about.
- faithful: nothing in the summary is invented beyond the material it summarizes (the root was a live session root; invented commit hashes, statuses or outcomes are faithful=0).
- decisions: "## Main decisions" (when present) lists real decisions, not filler.
- quiet: the summary is a summary — no milestone spam, no emoji noise, no restated transcripts.
- pass: true when every score is >= 6 and faithful >= 8.`;

const res = await fetch(`${BASE.replace(/\/+$/, "")}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(process.env.PI_MATRIX_JUDGE_API_KEY ? { authorization: `Bearer ${process.env.PI_MATRIX_JUDGE_API_KEY}` } : {}),
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: RUBRIC },
      { role: "user", content: `Thread root as first posted:\n${rootBody}\n\nThread root after the summary rewrite (judge this):\n${summaryMd}` },
    ],
    max_tokens: 400,
    temperature: 0,
  }),
});
if (!res.ok) {
  console.error(`judge endpoint ${BASE} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const body = await res.json();
const text = body.choices?.[0]?.message?.content ?? "";
const verdict = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

const out = path.join(runDir, "judge-summary.json");
fs.writeFileSync(out, JSON.stringify({ judged: new Date().toISOString(), model: MODEL, base: BASE, verdict, run: evidence.run }, null, 2));
console.log(`judge verdict: ${JSON.stringify(verdict)}\nsaved: ${path.relative(process.cwd(), out)}`);
const gateOk = verdict.pass === true && verdict.faithful >= 8 && ["topic", "decisions", "quiet"].every((k) => verdict[k] >= 6);
if (!gateOk) {
  console.error("judge gate FAILED (pass=true, faithful>=8, others>=6 required)");
  process.exit(1);
}
console.log("judge gate OK");
