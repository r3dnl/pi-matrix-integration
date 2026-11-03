/**
 * Sub-agent bus (src/subagent-bus.ts, DESIGN-SUBAGENT-TRACKING §4):
 * deterministic type colors, line rendering (plain + html), and the
 * spawn → bind → post → settle flow including the summarizeResultIntoSpawnLine
 * anchor edit,
 * nested (depth 2) milestones, and the `enabled: false` gate.
 */
import { createPiJiti, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const bus = await jiti.import("../src/subagent-bus.ts");
const { check, finish } = makeCheck("SUBAGENT-BUS");

const {
  colorForType,
  agentSpawnMeta,
  fmtDuration,
  firstLine,
  escapeHtml,
  tintedLine,
  spawnLine,
  settleLine,
  createSubagentBus,
} = bus;

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers -------------------------------------------------------

const s0 = { enabled: true, spawnMessages: true, summarizeResultIntoSpawnLine: false, postMode: "turn-end" };

check(
  "colorForType deterministic per type",
  colorForType("researcher", s0) === colorForType("researcher", { ...s0 }) &&
    colorForType("coder", s0) === colorForType("coder", { ...s0 }),
);
check(
  "colorForType falls in the palette",
  bus.DEFAULT_PALETTE.includes(colorForType("any-random-type", s0)),
);
check(
  "colorForType user pin wins",
  colorForType("researcher", { ...s0, colorByType: { researcher: "#123456" } }) === "#123456",
);

const meta = agentSpawnMeta({ description: "Find the bug", subagent_type: "Explore", thinking: "low" });
check("agentSpawnMeta name fallback (description)", meta.name === "Find the bug");
check(
  "agentSpawnMeta model default + thinking",
  meta.model === "(session model)" && meta.thinking === "low" && meta.type === "Explore",
);
check(
  "agentSpawnMeta name wins over description",
  agentSpawnMeta({ name: "auth-audit", description: "d" }).name === "auth-audit",
);

check("fmtDuration seconds", fmtDuration(45_000) === "45s");
check("fmtDuration minutes", fmtDuration(125_000) === "2m5s");
check("firstLine skips blanks", firstLine("\n\n  done here\n") === "done here");
check("escapeHtml", escapeHtml('a<b>&"c') === "a&lt;b&gt;&amp;&quot;c" || escapeHtml("a<b>&c") === "a&lt;b&gt;&amp;c");

const plain = tintedLine("⚡ Spawn: x", " (t · m)", "#FF0000", false);
check("tintedLine plain: no html, marker text", !plain.html && plain.text.startsWith("⚡ Spawn: x"));
const rich = tintedLine("⚡ Spawn: x", " (t · m)\nline2", "#FF0000", true);
check(
  "tintedLine html: font span + converted body",
  rich.html?.includes('<font color="#FF0000">⚡ Spawn: x</font>') && rich.html?.includes("line2<br>") === false,
);
// No raw markdown may survive into formatted_body (feedback round 2, 2026-10-08):
// the body runs through convertMarkdown; the plain text keeps the markdown.
const mdRich = tintedLine("⚡ Agent result: x: ", "Found **two** files:\n\n1. `a.js`", "#2E7D32", true);
check(
  "tintedLine converts markdown body to html",
  mdRich.html?.includes("<strong>two</strong>") && !mdRich.html.includes("**") && mdRich.text.includes("**two**"),
);

// --- bus flow -----------------------------------------------------------

function mkPost() {
  const sent = [];
  const edits = [];
  return {
    sent,
    edits,
    impl: {
      send: async (text, html) => {
        sent.push({ text, html });
        return { success: true, eventId: `ev-${sent.length}` };
      },
      edit: async (eventId, text, html) => {
        edits.push({ eventId, text, html });
        return true;
      },
    },
  };
}

// summarizeResultIntoSpawnLine: false → spawn line + traffic (turn) + settle line.
{
  const p = mkPost();
  const b = createSubagentBus(() => s0, () => true, p.impl);
  const rec = b.spawn({ description: "Find the bug", subagent_type: "Explore", prompt: "Find  the bug" });
  await tick();
  check("spawn posts one line", p.sent.length === 1 && p.sent[0].text.includes("⚡ Spawn subagent, task: Find the bug"));
  check("spawn line carries type + model", p.sent[0].text.includes("Explore") && p.sent[0].text.includes("(session model)"));
  check("spawn line shows explicit thinking (default when absent)", p.sent[0].text.includes("thinking=default"));

  const id = b.bind("sess-1", "explore-agent", "Find the bug", false);
  check("bind matches normalized prompt", id?.name === "Find the bug" && id?.depth === 1);
  check("bind unmatched → null", b.bind("sess-x", "x", "no such prompt", false) === null);

  b.post("sess-1", "m1", "message"); // turn-end mode: message kind is dropped
  b.post("sess-1", "final **turn** text", "turn");
  await tick();
  check(
    "postMode turn-end: one traffic line for the turn-final",
    p.sent.length === 2 && p.sent[1].text.includes("Find the bug") && p.sent[1].text.includes("final **turn** text"),
  );
  check("traffic line uses the Agent result label", p.sent[1].text.includes("⚡ Agent result: Find the bug:"));
  check("traffic line html: markdown body converted, no raw **", p.sent[1].html?.includes("<strong>turn</strong>") && !p.sent[1].html.includes("**"));

  b.settle("sess-1", "line one\nrest");
  await tick();
  check(
    "settle line: directive + duration + meta, no result text (round 6)",
    p.sent.length === 3 &&
      p.sent[2].text.includes("settled in") &&
      p.sent[2].text.includes("(session model)") &&
      p.sent[2].text.includes("thinking=default") &&
      !p.sent[2].text.includes("line one"),
  );
  check("settle line keeps the Spawn subagent, task: directive", p.sent[2].text.includes("⚡ Spawn subagent, task: Find the bug · settled in"));
  check("no anchor edit in separate-line mode", p.edits.length === 0);
  check("record settled once", rec.status === "settled" && b.list().length === 1);
  // A second settle is a no-op (single settle source).
  b.settle("sess-1", "again");
  await tick();
  check("settle is idempotent", p.sent.length === 3);
}

// Explicit meta (feedback round 1, 2026-10-08): a spawn without overrides
// resolves the session's current model/thinking (no placeholder once known).
{
  const p = mkPost();
  const b = createSubagentBus(
    () => s0,
    () => true,
    p.impl,
    undefined,
    () => ({ model: "anthropic/claude-sonnet-x", thinking: "medium" }),
  );
  b.spawn({ description: "Deep dive", subagent_type: "Plan", prompt: "Deep  dive" });
  await tick();
  check(
    "spawn line resolves session model + thinking",
    p.sent.length === 1 &&
      p.sent[0].text.includes("⚡ Spawn subagent, task: Deep dive") &&
      p.sent[0].text.includes("anthropic/claude-sonnet-x") &&
      p.sent[0].text.includes("thinking=medium"),
  );
}

// summarizeResultIntoSpawnLine: the settle edits the spawn anchor in place (no settle line).
{
  const p = mkPost();
  const b = createSubagentBus(
    () => ({ ...s0, summarizeResultIntoSpawnLine: true }),
    () => false, // plain mode
    p.impl,
  );
  const rec = b.spawn({ name: "w1", subagent_type: "Explore", prompt: "p1" });
  await tick();
  check("summarizeResultIntoSpawnLine captures the anchor event id", rec.spawnAnchorEventId === "ev-1");
  b.bind("sess-b", "w1", "p1", false);
  b.settle("sess-b", "the full result text");
  await tick();
  check(
    "summarizeResultIntoSpawnLine settle edits the anchor: header only, no result (round 6)",
    p.edits.length === 1 &&
      p.edits[0].eventId === "ev-1" &&
      p.edits[0].text.includes("w1 · settled in") &&
      !p.edits[0].text.includes("the full result text"),
  );
  // The edited-in-place anchor IS the spawn message: it keeps the directive
  // and the full explicit meta (feedback rounds 2 + 6, 2026-10-08).
  check(
    "anchor edit keeps the Spawn subagent, task: directive + thinking meta",
    p.edits[0].text.includes("⚡ Spawn subagent, task: w1 · settled in") && p.edits[0].text.includes("thinking="),
  );
  check("summarizeResultIntoSpawnLine posts no separate settle line", p.sent.length === 1);
  check("anchorEdited flag", rec.anchorEdited === true);
}

// Nested (depth 2): milestone lines only.
{
  const p = mkPost();
  const b = createSubagentBus(() => s0, () => true, p.impl);
  b.spawn({ name: "parent-agent", subagent_type: "general-purpose", prompt: "parent work" });
  b.nestedSpawn("parent-agent", { name: "child", subagent_type: "Explore", prompt: "child work" });
  await tick();
  check("nested spawn posts a ↳ line", p.sent.length === 2 && p.sent[1].text.startsWith("↳ parent-agent spawned child"));

  const id = b.bind("sess-n", "child", "child work", true);
  check("bind prefers depth-2 for side chains", id?.depth === 2);
  b.post("sess-n", "nested traffic", "turn"); // v1: nested traffic is not posted
  await tick();
  check("nested traffic line suppressed in v1", p.sent.length === 2);
  b.settle("sess-n", "child done");
  await tick();
  check("nested settle posts one milestone line", p.sent.length === 3 && p.sent[2].text.includes("↳ child [nested]: settled in"));
}

// enabled: false — detection still records, nothing posts.
{
  const p = mkPost();
  const b = createSubagentBus(() => ({ ...s0, enabled: false }), () => true, p.impl);
  const rec = b.spawn({ name: "silent", subagent_type: "Explore", prompt: "quiet" });
  b.bind("sess-s", "silent", "quiet", false);
  b.post("sess-s", "x", "turn");
  b.settle("sess-s", "y");
  await tick();
  check("enabled=false posts nothing", p.sent.length === 0 && p.edits.length === 0);
  check("enabled=false still records + settles", rec.status === "settled" && b.list().length === 1);
}

// Re-spawn of a running prompt reuses the record (the resume path).
{
  const p = mkPost();
  const b = createSubagentBus(() => s0, () => true, p.impl);
  const r1 = b.spawn({ name: "a", subagent_type: "Explore", prompt: "same prompt" });
  r1.sessionId = "old-session";
  const r2 = b.spawn({ name: "a", subagent_type: "Explore", prompt: "same   prompt" });
  await tick();
  check("re-spawn reuses the running record", r2 === r1 && r1.sessionId === undefined);
  check(
    "re-spawn posts no duplicate line (the running line stays the anchor)",
    p.sent.length === 1,
  );
}

// Completion-channel settle (DESIGN-SUBAGENT-PROVIDER §6): the run id
// attached from the parent's spawn tool_result joins the completion
// event back to the room's spawn line.
{
  const p = mkPost();
  const b = createSubagentBus(() => s0, () => true, p.impl);
  b.spawn({ name: "recon", subagent_type: "Explore", prompt: "Recon the src tree" });
  await tick();
  b.attachRunId("Recon  the src tree", "run-9"); // normalized prompt match
  b.settleByRunId("unknown-run");
  await tick();
  check("settleByRunId unknown run → no-op", p.sent.length === 1);
  b.settleByRunId("run-9");
  await tick();
  check(
    "completion settle posts a settle line",
    p.sent.length === 2 && p.sent[1].text.includes("settled in"),
  );
  b.settleByRunId("run-9");
  await tick();
  check("completion settle is idempotent", p.sent.length === 2);
}
{
  const p = mkPost();
  const b = createSubagentBus(() => ({ ...s0, summarizeResultIntoSpawnLine: true }), () => true, p.impl);
  b.spawn({ name: "recon", subagent_type: "Explore", prompt: "anchor recon" });
  await tick();
  b.attachRunId("anchor recon", "run-10");
  b.settleByRunId("run-10");
  await tick();
  check(
    "completion settle edits the spawn anchor",
    p.edits.length === 1 && p.edits[0].eventId === "ev-1" && p.edits[0].text.includes("settled in"),
  );
}

finish();
