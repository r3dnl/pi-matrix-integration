/**
 * Scripted introduction tour (tour.ts) — the fixed runbook.
 *
 * The tour posts a fixed message sequence by code through the outgoing
 * pipeline; the LLM must never see it. These checks lock the contract the
 * live scenario (test/live/scenarios.mjs, scripted-tour) asserts against:
 * one exact script per config variant, stable order, milestone at position 3,
 * conditional steps pruned by their live toggles, and a runner that posts in
 * order with dedupe off (a replay inside the window must still post every
 * step).
 *
 * They also lock the approved step format: colored topic + part A (explain) +
 * part B ("Try it:"), no step numbers, and the decisions demo carrying the
 * decision mirror's own questionnaire shape.
 */
import path from "node:path";
import { EXT_DIR, createPiJiti, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { buildTourScript, runTourScript, tourDecisionDemoQuestions } = await jiti.import(
  path.join(EXT_DIR, "src/tour.ts"),
);
const { check, finish } = makeCheck("tour");

const ALL_ON = { remoteFilePicker: true, fileAttach: true, voiceTranscription: true };
const ALL_OFF = { remoteFilePicker: false, fileAttach: false, voiceTranscription: false };

const BLUE = "#3385ff";
const GREEN = "#1a7f37";
const byTopic = (steps, needle) => steps.find((s) => s.text.includes(needle));
const byIndex = (steps, i) => steps[i] ?? { text: "", html: "", kind: "other" };

// --- script shape -----------------------------------------------------------
{
  const full = buildTourScript(ALL_ON);
  check("all toggles on → 15 steps", full.length === 15, `got ${full.length}`);
  const bare = buildTourScript(ALL_OFF);
  check("all toggles off → 12 steps (picker/attach/voice pruned)", bare.length === 12, `got ${bare.length}`);
  check("voice defaults on: undefined voiceTranscription keeps the step",
    buildTourScript({ remoteFilePicker: false, fileAttach: false }).length === 13);
  check("sub-agent reporting off drops the two demo lines, keeps the step",
    buildTourScript({ ...ALL_ON, subagents: { enabled: false } }).length === 13);
}
{
  const s = buildTourScript(ALL_ON);
  check("welcome first", s[0].text.startsWith("**👋 Welcome") && s[0].kind === "other");
  check("milestone demo at position 3, kind=milestone",
    s[2].kind === "milestone" && s[2].text.startsWith("🎯 Milestone:") && s[2].text.includes("milestone format"),
    s[2].text.slice(0, 40));
  // The milestone is a format demo, so it must not wear the tour's own heading.
  check("milestone demo carries no tour topic heading",
    !s[2].html.includes("<strong><font"), s[2].html.slice(0, 60));
  check("closing step is the Next prompt",
    s[s.length - 1].text.includes("**🚀 Next**") &&
      s[s.length - 1].text.includes("type a message about the topic you want to talk about"),
    s[s.length - 1].text);
  check("controls step names the replay command",
    byTopic(s, "**🎛 Controls**").text.includes("/matrix-introduction-tour"));
}
{
  // No step numbers, in any variant — the tour is a runbook, not a checklist.
  const numbered = (steps) => steps.filter((x) => /^\d+\./.test(x.text));
  check("no step text starts with a number (all on)", numbered(buildTourScript(ALL_ON)).length === 0);
  check("no step text starts with a number (pruned)", numbered(buildTourScript(ALL_OFF)).length === 0);
}
{
  // Part A / part B: every tour item explains and then says what to type.
  // Payload lines (the milestone and sub-agent demos) carry no heading — they
  // ARE the payload. Welcome is the preamble, the closer IS the thing to type.
  const s = buildTourScript(ALL_ON);
  const items = s.slice(1, -1).filter((x) => x.text.startsWith("**"));
  const missingTryIt = items.filter((x) => !x.text.includes("\n\nTry it: "));
  check("every tour item carries a Try-it line",
    items.length === 10 && missingTryIt.length === 0,
    missingTryIt.map((x) => x.text.slice(0, 30)).join(" | "));
  check("every topic renders bold + blue",
    s.filter((x) => x.text.startsWith("**")).every((x) =>
      x.html.startsWith(`<p><strong><font color="${BLUE}">`)));
  check("every Try-it line renders green",
    s.filter((x) => x.text.includes("Try it:")).every((x) => x.html.includes(`color="${GREEN}"`)));
  check("every step ships html for formatted_body",
    s.every((x) => x.html.startsWith("<") && x.html.includes("</")));
}
{
  // Show, do not tell. The decisions step no longer embeds a look-alike table
  // (that drifted from the real one); it explains and carries a hook, and the
  // caller opens a REAL questionnaire on the ask-user mirror.
  const s = buildTourScript(ALL_ON);
  const dec = byTopic(s, "**🤝 Decisions**");
  check("decisions step explains and hooks the real mirror",
    dec.hook === "decision-demo" && !dec.text.includes("| # | Option | Description |"),
    JSON.stringify(dec.hook));
  const q = tourDecisionDemoQuestions();
  check("the demo questionnaire is answerable and its options are the guidance",
    q.length === 1 && q[0].question.length > 0 && q[0].options.length >= 2 &&
      q[0].options.every((o) => o.label && o.description),
    JSON.stringify(q));
  check("decisions demo drops the old hand-written option list",
    !s.some((x) => x.text.includes("Another example option")));

  // The sub-agent demo posts what the production formatters build — tinted
  // spawn line, then the result line. No bus record is written, so
  // /matrix-subagents still lists only real spawns.
  const i = s.findIndex((x) => x.text.includes("⚡ Spawn subagent"));
  check("sub-agent demo lines follow the sub-agents step",
    byIndex(s, i - 1).text.includes("**🤖 Sub-agents**") &&
      /^⚡ Spawn subagent, task: .*running, /.test(s[i].text) &&
      s[i].html.startsWith('<font color="#') &&
      /^⚡ Agent result: /i.test(s[i + 1].text),
    s[i]?.text);
}
{
  // Fenced blocks must keep the language hint — that class is what turns on
  // Element's syntax highlighting.
  const code = byTopic(buildTourScript(ALL_ON), "**🧾 Code renders as code**");
  check("code step ships a json and a ts fence",
    code.html.includes('class="language-json"') && code.html.includes('class="language-ts"'),
    code.html.slice(0, 80));
  check("code step posts no unbalanced fence in the plain body",
    (code.text.match(/```/g) ?? []).length === 4);
  // Both examples must be about rendering, not about a config file that
  // happens to be JSON.
  check("code step carries no unrelated config-path claim",
    !code.text.includes(".pi/matrix"), code.text.slice(0, 90));
}
{
  // The command split the user could not discover: room-typed commands run in
  // the terminal and most answer there only. The step must say so and demo
  // both halves.
  const slash = byTopic(buildTourScript(ALL_ON), "**⌨️ Slash commands**");
  check("slash step teaches the room-visible vs terminal-only split",
    slash.text.includes("terminal") && slash.text.includes("/matrix-help") &&
      slash.text.includes("/matrix-status") && slash.text.includes("stays in the terminal"),
    slash.text.slice(-120));
  const subs = byTopic(buildTourScript(ALL_ON), "**🤖 Sub-agents**");
  check("sub-agent step tries it by spawning one, not by listing them",
    /ask Pi for a task[^.]*sub-agent/i.test(subs.text.split("Try it:")[1]) &&
      !subs.text.split("Try it:")[1].includes("/matrix-subagents"),
    subs.text.split("Try it:")[1]);
  const threads = byTopic(buildTourScript(ALL_ON), "**🧵 Threads**");
  check("thread step names the session→thread rule and `/new`",
    threads.text.includes("`/new`") && threads.text.includes("new thread start"),
    threads.text.split("Try it:")[1]);
}
{
  // Pruning keeps the remaining steps in runbook order (no renumbering to
  // keep, so order is the whole contract).
  const topics = buildTourScript(ALL_OFF).map((x) => x.text.split("\n")[0]);
  check("pruned variant keeps order without the toggled steps",
    topics[0].includes("Welcome") && !topics.some((t) => /Hand a file|Get a file out|Voice notes/.test(t)) &&
      topics.some((t) => t.includes("Decisions")) &&
      topics[topics.length - 1].includes("Next"),
    JSON.stringify(topics));
}
{
  // The script is deterministic: same config → byte-identical sequence.
  const a = JSON.stringify(buildTourScript(ALL_ON));
  const b = JSON.stringify(buildTourScript(ALL_ON));
  check("script is deterministic per config", a === b);
}

// --- runner -----------------------------------------------------------------
{
  const steps = buildTourScript(ALL_ON);
  const posts = [];
  const hooks = [];
  const n = await runTourScript(steps, async (text, kind, html) => {
    posts.push({ text, kind, html });
    return { success: true, eventId: `$ev-${posts.length}` };
  }, { "decision-demo": async () => { await new Promise((r) => setTimeout(r, 0)); hooks.push(posts.length); } });
  check("runner posts every step in order (text, kind, html)",
    n === steps.length && posts.every((p, i) =>
      p.text === steps[i].text && p.kind === steps[i].kind && p.html === steps[i].html));
  // The demo must land AFTER its explanation, not before or beside it.
  check("a step's hook fires after that step has landed",
    hooks.length === 1 && hooks[0] === steps.findIndex((x) => x.hook === "decision-demo") + 1,
    JSON.stringify({ hooks, posted: posts.length }));
  const noHooks = [];
  await runTourScript(steps, async (text) => { noHooks.push(text); return { success: true }; });
  check("a script with hooks still runs when the caller provides none",
    noHooks.length === steps.length);
}
{
  const steps = buildTourScript(ALL_OFF);
  let threw = null;
  await runTourScript(steps, async (text) =>
    text.includes("Welcome") ? { success: true, eventId: "$ev" } : { success: false, error: "boom" },
  ).catch((e) => { threw = e; });
  check("runner throws on a failed send naming the step",
    threw instanceof Error && /tour step failed/.test(threw.message) && /boom/.test(threw.message),
    String(threw));
}

finish();
