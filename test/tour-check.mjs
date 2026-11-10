/**
 * Scripted introduction tour (tour.ts) — the fixed runbook.
 *
 * The tour posts a fixed message sequence by code through the outgoing
 * pipeline; the LLM must never see it. These checks lock the contract the
 * live scenario (test/live/scenarios.mjs, scripted-tour) asserts against:
 * one exact script per config variant, stable order, milestone at position
 * 3, conditional steps pruned by their live toggles, and a runner that
 * posts in order with dedupe off (a replay inside the window must still
 * post every step).
 */
import path from "node:path";
import { EXT_DIR, createPiJiti, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { buildTourScript, runTourScript } = await jiti.import(path.join(EXT_DIR, "src/tour.ts"));
const { check, finish } = makeCheck("tour");

const ALL_ON = { remoteFilePicker: true, fileAttach: true, voiceTranscription: true };
const ALL_OFF = { remoteFilePicker: false, fileAttach: false, voiceTranscription: false };

// --- script shape -----------------------------------------------------------
{
  const full = buildTourScript(ALL_ON);
  check("all toggles on → 11 steps", full.length === 11, `got ${full.length}`);
  const bare = buildTourScript(ALL_OFF);
  check("all toggles off → 8 steps (picker/attach/voice pruned)", bare.length === 8, `got ${bare.length}`);
  check("voice defaults on: undefined voiceTranscription keeps the step",
    buildTourScript({ remoteFilePicker: false, fileAttach: false }).length === 9);
}
{
  const s = buildTourScript(ALL_ON);
  check("welcome first", s[0].text.startsWith("👋 Welcome") && s[0].kind === "other");
  check("milestone demo at position 3, kind=milestone",
    s[2].kind === "milestone" && s[2].text.startsWith("🎯 Milestone:") && s[2].text.includes("milestone format"),
    s[2].text.slice(0, 40));
  check("decision example kind=decision", s[7].kind === "decision" && s[7].text.includes("Example option"));
  check("closing names the replay command", s[10].text.includes("/matrix-introduction-tour"));
  check("milestone + welcome carry no step number",
    !/^\d+\./.test(s[0].text) && !/^\d+\./.test(s[2].text));
  check("numbered steps count 1..9 without gaps",
    s.filter((x) => /^\d+\./.test(x.text)).map((x) => Number(x.text.match(/^(\d+)\./)[1])).join(",") === "1,2,3,4,5,6,7,8,9");
  // The pruned variant must renumber, not skip ("3." then "6." would leak).
  const bare = buildTourScript(ALL_OFF);
  check("pruned variant renumbers 1..6",
    bare.filter((x) => /^\d+\./.test(x.text)).map((x) => Number(x.text.match(/^(\d+)\./)[1])).join(",") === "1,2,3,4,5,6");
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
  const n = await runTourScript(steps, async (text, kind) => {
    posts.push({ text, kind });
    return { success: true, eventId: `$ev-${posts.length}` };
  });
  check("runner posts every step in order",
    n === steps.length && posts.every((p, i) => p.text === steps[i].text && p.kind === steps[i].kind));
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
