/**
 * Pi Matrix Integration — scripted introduction tour.
 *
 * The fixed onboarding runbook: every step is one exact, human-written
 * message posted by code through the outgoing pipeline
 * (`messageHandler.post`). The LLM is not in the loop in either direction:
 * no directive is injected (so no session turn starts), and the posted
 * messages echo back as own-user events, which the inbound funnel drops
 * before prompt injection — same guard as every other code-posted message.
 * Kept a pure function of `MatrixConfig` (like `buildMatrixHelp`) so the
 * sequence is unit-testable per config variant.
 *
 * Every step has the same shape: a colored topic line, part A (what the
 * feature is) and part B (what to type to try it right now). The shape is
 * the `TourEntry` type, not a convention — a step without a `tryIt` cannot
 * be written without saying so.
 *
 * Show, do not tell. Where the room can produce the real artifact, the tour
 * triggers it instead of describing it: the milestone step posts a real
 * milestone, the decision step's hook opens a real questionnaire on the
 * ask-user mirror, and the sub-agent step posts the lines the production
 * formatters build. The tour stays a dummy interaction: it starts no session
 * turn, spawns nothing, and the mirror swallows the demo's replies — a room
 * answer resolves the demo, never a parked tool call.
 */
import type { MatrixConfig } from "./types.js";
import type { SendKind } from "./threading.js";
import {
  applyInlineMarkdown,
  convertMarkdown,
  escapeHtml,
  INLINE_CODE_STYLE,
} from "./markdown.js";
import { INSTRUCTION_GREEN, type MirrorQuestion } from "./ask-user-mirror.js";
import {
  colorForType,
  spawnLine,
  trafficLine,
  type SubagentSettings,
  type SubagentSpawnRecord,
} from "./subagent-bus.js";

export interface TourStep {
  /** Markdown: `**topic**`, part A, the part B line. Posts as the message
   *  body, so plain-text clients and the thread ledger read the same words. */
  text: string;
  kind: SendKind;
  /** Pre-built Element HTML, shipped as `formatted_body` regardless of the
   *  `sendFormatted` gate: the colored topic and the green instruction need
   *  raw `<font>`, which the markdown converter escapes by design. Same
   *  mechanism as the decision mirror's review post. */
  html: string;
  /** A live artifact to trigger after this step lands, resolved by the caller
   *  against its own hooks (`integration.ts` owns the ask-user mirror). Show,
   *  do not tell: the decision step explains and then the REAL questionnaire
   *  arrives — no model turn, the mirror consumes the room's replies. */
  hook?: "decision-demo";
}

interface TourEntry {
  /** Colored bold heading; no backticks here (the topic ships as text, not
   *  as a code span). Empty for a step that is itself a format demo. */
  topic?: string;
  /** Part A: what the feature is and what the room will show. Markdown.
   *  Absent only on a `verbatim` step, whose text comes from production. */
  explain?: string;
  /** Part B: what to type (or look for) right now. Rendered green. */
  tryIt?: string;
  kind: SendKind;
  hook?: "decision-demo";
  /** A step whose text and HTML come from production code rather than the
   *  tour's own copy — the sub-agent demo posts exactly what the real
   *  spawn/result formatters build. */
  verbatim?: { text: string; html?: string };
}

/**
 * The recorded tour, posted as a link in the welcome step. Empty until the
 * recording exists — the step stays out of the script rather than posting a
 * dead link. Hosted next to the README gifs, so the npm package carries no
 * media (the tarball gate excludes `docs/assets/*` images by design).
 * ponytail: one constant, no config key. Add `piMatrixTour.videoUrl` when a
 * deployment needs its own recording.
 */
const TOUR_VIDEO_URL = "";

const tryItHtml = (text: string): string =>
  `<p><font color="${INSTRUCTION_GREEN}">Try it: ${applyInlineMarkdown(escapeHtml(text))}</font></p>`;

/**
 * The tour's live decision demo, asked through the real ask-user mirror.
 * The question and its options ARE the guidance: the pick names the next
 * thing to do, and answering changes nothing in the session (`integration.ts`
 * ends the demo instead of resolving a tool call — none is parked).
 */
export function tourDecisionDemoQuestions(): MirrorQuestion[] {
  return [
    {
      header: "Tour",
      question: "You are looking at a real decision. Which do you want to do first?",
      options: [
        { label: "Answer this one", description: "reply 1, then confirm — that is the full room flow" },
        { label: "Read on", description: "keep reading the remaining tour steps" },
        { label: "Try a command", description: "send /matrix-help and read the guide it posts here" },
      ],
    },
  ];
}

/** The demo spawn's clock. Fixed, not `Date.now()`: the script stays a pure
 *  function of the config (the tour checks compare it byte-for-byte). */
const DEMO_SPAWN_AT = 1760000000000;
const DEMO_SETTLE_AT = DEMO_SPAWN_AT + 42_000;

/** The reporting settings the bus would use for this config, so the demo
 *  lines carry the user's own marker and type colors. */
function subagentSettings(config: MatrixConfig): SubagentSettings {
  const s = config.subagents ?? {};
  return {
    enabled: s.enabled !== false,
    spawnMessages: s.spawnMessages !== false,
    summarizeResultIntoSpawnLine: s.summarizeResultIntoSpawnLine !== false,
    postMode: s.postMode ?? "turn-end",
    ...(s.colorByType ? { colorByType: s.colorByType } : {}),
    ...(s.colorPalette ? { colorPalette: s.colorPalette } : {}),
    ...(s.plainMarker ? { plainMarker: s.plainMarker } : {}),
  };
}

/** The two lines a spawn really shows, built by the production formatters.
 *  No bus record is written: the demo shows the rendering, it is not a
 *  spawn, and `/matrix-subagents` stays honest. */
function subagentDemoLines(config: MatrixConfig): { spawn: TourStep["text"]; spawnHtml: TourStep["html"]; result: string; resultHtml?: string } {
  const settings = subagentSettings(config);
  const formatted = config.sendFormatted !== false;
  const type = "reviewer";
  const rec: SubagentSpawnRecord = {
    key: "tour-demo",
    name: "audit the tour copy",
    type,
    model: "sonnet",
    thinking: null,
    prompt: "tour demo",
    spawnAt: DEMO_SPAWN_AT,
    settleAt: DEMO_SETTLE_AT,
    depth: 1,
    color: colorForType(type, settings),
    status: "running",
    anchorEdited: false,
  };
  const spawn = spawnLine(rec, settings, formatted);
  const result = trafficLine(rec.name, "Three steps read as instructions rather than explanations.", settings.plainMarker ?? "⚡", formatted);
  return { spawn: spawn.text, spawnHtml: spawn.html ?? convertMarkdown(spawn.text).html, result: result.text, resultHtml: result.html };
}

function render(entry: TourEntry): TourStep {
  if (entry.verbatim) {
    return {
      kind: entry.kind,
      text: entry.verbatim.text,
      html: entry.verbatim.html ?? convertMarkdown(entry.verbatim.text).html,
      ...(entry.hook ? { hook: entry.hook } : {}),
    };
  }
  const explain = entry.explain ?? "";
  const body = entry.tryIt ? `${explain}\n\nTry it: ${entry.tryIt}` : explain;
  const html =
    (entry.topic
      ? `<p><strong><font color="${INLINE_CODE_STYLE}">${escapeHtml(entry.topic)}</font></strong></p>`
      : "") +
    convertMarkdown(explain).html +
    (entry.tryIt ? tryItHtml(entry.tryIt) : "");
  return {
    kind: entry.kind,
    text: entry.topic ? `**${entry.topic}**\n\n${body}` : body,
    html,
    ...(entry.hook ? { hook: entry.hook } : {}),
  };
}

/**
 * The fixed tour, in play order (maintainer-approved runbook): 15 steps with
 * every toggle on. Four steps follow their live config toggles, same as the
 * help guide: the `@` picker (`remoteFilePicker`), the `@@` attach
 * (`fileAttach`), voice transcription (`voiceTranscription`, on unless
 * explicitly off) and the two sub-agent demo lines (`subagents.enabled`).
 */
export function buildTourScript(config: MatrixConfig): TourStep[] {
  const subagentDemo = subagentDemoLines(config);
  const entries: TourEntry[] = [
    {
      kind: "other",
      topic: "👋 Welcome",
      explain:
        "This room is the remote control for a Pi coding session: you steer from here, the agent works in the terminal and reports back. The tour takes about 2 minutes and every step ends with what to type next. Nothing here is destructive, and `/matrix-toggle` switches the bridge off." +
        (TOUR_VIDEO_URL
          ? `\n\nPrefer video? The recorded tour: ${TOUR_VIDEO_URL}`
          : ""),
    },
    {
      kind: "other",
      topic: "💬 Just talk",
      explain:
        "Plain language is the interface. The agent picks up room messages on its next poll and answers in the thread your message opens — no commands, no syntax.",
      tryIt: "Send `hello` and watch the reply land in a new thread.",
    },
    {
      // A demo of the milestone format, so it is written exactly as a real
      // milestone arrives — no topic heading, kind `milestone` so the thread
      // ledger records it like any other checkpoint.
      kind: "milestone",
      explain:
        "🎯 Milestone: tour step — this is the milestone format. The other automatic posts are 📋 TODO progress and 🧑 the prompts you type in the terminal.",
      tryIt: "Nothing to type — these arrive on their own at the agent's next checkpoint.",
    },
    {
      kind: "other",
      topic: "⌨️ Slash commands",
      explain:
        "A command typed here is relayed into the terminal and runs as if typed there — including every other extension's commands. Misspell one and the closest match is suggested. Most commands answer in the terminal, so the room stays quiet: only the ones whose job is to write here show up here.",
      tryIt:
        "Send `/matrix-help` — the guide lands in this room. Then send `/matrix-status` for contrast: it runs, and its answer stays in the terminal.",
    },
  ];
  if (config.remoteFilePicker) {
    entries.push({
      kind: "other",
      topic: "📂 Hand a file to the agent with @",
      explain:
        "An `@` fragment lists the matches in the room; answering with a number hands that file's contents to the agent.",
      tryIt: "Send `@src/` or a glob like `@src/*.ts`, then reply with the number.",
    });
  }
  if (config.fileAttach) {
    entries.push({
      kind: "other",
      topic: "📤 Get a file out with @@",
      explain:
        "An `@@` fragment opens the artifact picker; pick an entry and the file is uploaded and attached to a room message.",
      tryIt: "Send `@@README` and pick from the list.",
    });
  }
  if (config.voiceTranscription !== false) {
    entries.push({
      kind: "other",
      topic: "🎙 Voice notes",
      explain:
        "A voice message dropped into the room or a thread is transcribed and treated as typed text. The transcript comes back as a 🗣️ echo naming the engine that produced it.",
      tryIt: "Record a short voice note here and read the echo.",
    });
  }
  entries.push(
    {
      kind: "other",
      topic: "🧾 Code renders as code",
      explain:
        "Markdown travels both ways, so what you send keeps its shape: commands and file names render as literals, and a fenced block keeps its language so Element highlights it. This is the shape of a room message:\n\n" +
        "```json\n{\n  \"msgtype\": \"m.text\",\n  \"body\": \"plain fallback\",\n  \"formatted_body\": \"<b>what Element shows</b>\"\n}\n```\n\n" +
        "Even this tour is data, not prose:\n\n" +
        "```ts\ninterface TourEntry {\n  topic?: string; // colored heading\n  explain: string; // part A: what it is\n  tryIt?: string; // part B: what to type\n}\n```",
      tryIt:
        "Send a fenced block of your own — open a line with three backticks and a language name (`json`, `yaml`, `ts`), paste, send.",
    },
    {
      // Show, do not tell: this step explains, and its hook posts a REAL
      // questionnaire through the ask-user mirror (`integration.ts`). The old
      // hand-written table drifted from the real one; now there is nothing to
      // drift. The demo is posted by the mirror as kind `decision`, and the
      // caller closes it — see `closeTourDecisionDemo`.
      kind: "other",
      topic: "🤝 Decisions",
      hook: "decision-demo",
      explain:
        "When the agent needs a choice, a questionnaire like the one arriving now lands in the room. Answer it here or in the terminal — whichever surface answers first wins, and the terminal stays usable.",
      tryIt:
        "This one is the tour's own: reply `1` or `2` (or tap the poll), then `confirm`. Nothing reaches the agent — a real decision behaves exactly the same way.",
    },
    {
      kind: "other",
      topic: "🤖 Sub-agents",
      explain:
        "For parallel work the agent spawns sub-agents, and the room follows them: a spawn line, then the result line when the task lands. The spawn line is edited in place at settle, so a thread keeps one line per agent instead of a trail. The next two messages are exactly those lines, built by the same code that posts a real spawn — no agent ran.",
      tryIt: "Read the two lines below, then ask Pi for a task you would hand to a sub-agent and watch the same pair arrive for real.",
    },
    // The demo lines themselves: production formatter output, no bus record
    // written, so `/matrix-subagents` still lists only real spawns.
    ...(config.subagents?.enabled === false
      ? []
      : [
          { kind: "other" as SendKind, verbatim: { text: subagentDemo.spawn, html: subagentDemo.spawnHtml } },
          {
            kind: "other" as SendKind,
            verbatim: { text: subagentDemo.result, html: subagentDemo.resultHtml },
          },
        ]),
    {
      kind: "other",
      topic: "🧵 Threads",
      explain:
        "Each conversation lives in a thread and its root message carries a running summary the agent refreshes as you talk: topic, milestones, recent activity, latest and next, main decisions. A fresh Pi session opens a fresh thread — so a session break is a thread break, not a lost history.",
      tryIt:
        "In the Pi terminal, type `/new` to start a new session and watch the Matrix room to see a new thread start. Send `/matrix-thread-summarize` to force a summary refresh.",
    },
    {
      kind: "other",
      topic: "🎛 Controls",
      explain:
        "Commands that write here: `/matrix-send TEXT`, `/matrix-help` (the full guide), `/matrix-thread-summarize` (rewrites this thread's root), `/matrix-introduction-tour` (replays this tour). Commands that answer in the terminal only: `/matrix-status`, `/matrix-messages [n]`, `/matrix-subagents`, `/matrix-thread-toggle`. Connection switches — `/matrix-connect`, `/matrix-disconnect`, `/matrix-toggle`, `/matrix-switch [profile]` — also answer in the terminal, and a connect posts the usual session milestone here. A plain `help` message works from anywhere: the agent answers it here.",
      tryIt: "Send `/matrix-help` and read the guide.",
    },
    {
      kind: "other",
      topic: "🚀 Next",
      explain:
        "Just type a message about the topic you want to talk about, and see how it spawns a threaded conversation.",
    },
  );
  return entries.map(render);
}

/**
 * Play the script: one message at a time, in order, through the caller's
 * post (the outgoing pipeline). `dedupe: false` is deliberate — a replay
 * within the dedupe window must still post every step. After a step that
 * carries a `hook`, the caller's matching hook runs (the live decision demo);
 * a hook the caller does not provide is skipped. Throws on the first failed
 * send; the caller logs and the room keeps whatever already landed.
 */
export async function runTourScript(
  steps: TourStep[],
  post: (text: string, kind: SendKind, html: string) => Promise<{ success: boolean; error?: string }>,
  hooks: Partial<Record<NonNullable<TourStep["hook"]>, () => void | Promise<void>>> = {},
): Promise<number> {
  for (const step of steps) {
    const result = await post(step.text, step.kind, step.html);
    if (!result.success) {
      throw new Error(`tour step failed: ${step.text.slice(0, 60)} — ${result.error ?? "send failed"}`);
    }
    if (step.hook) await hooks[step.hook]?.();
  }
  return steps.length;
}
