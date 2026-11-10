/**
 * Pi Matrix Integration — `/matrix-help` guide builder (item: end-user guide)
 *
 * The room's reference card: what you can send, what every command does, what
 * the agent posts on its own, and where settings live. Condensed on purpose —
 * the guided walk is `/matrix-introduction-tour`, so nothing here re-explains
 * a feature; it names it and says where the answer shows up.
 *
 * Kept a pure function of `MatrixConfig` (like the tour) so it is unit-testable
 * without the pi API, and deliberately HTML-free: the pipeline converts
 * markdown to `formatted_body` under the `sendFormatted` gate, and plain-text
 * clients get the same document. Color is not available here for the same
 * reason it is unavailable to any agent message — the converter escapes raw
 * HTML before it parses markdown.
 */
import type { MatrixConfig } from "./types.js";

/** The user-facing configuration reference, linked from the guide so a phone
 *  reader can look a key up (the same repo URL the README's images use). The
 *  guide deliberately does not re-list the key groups: this link is the
 *  reference, and a copy of it in the guide would be a second source to keep
 *  current.
 *  Note: paths written in this file are scanned by the docs gate as if they
 *  were commands, so config paths are written without a slash directly in
 *  front of `matrix-…`. */
const CONFIG_DOC_URL =
  "https://github.com/r3dnl/pi-matrix-integration/blob/main/docs/user/configuration.md";

/** Marks a room action this deployment switched off. */
const off = (enabled: boolean): string => (enabled ? "" : " *(off here)*");

/**
 * The guide, as GitHub-flavoured markdown: three tables and a settings
 * pointer. Every command `src/commands.ts` registers is listed (the docs gate
 * fails either way it is wrong: a missing command, or one that does not
 * exist), and the "answer shows" column carries the split the room cannot
 * guess — most commands answer in the terminal, not here.
 */
export function buildMatrixHelp(config: MatrixConfig): string {
  const picker = config.remoteFilePicker !== false;
  const attach = config.fileAttach !== false;
  const voice = config.voiceTranscription !== false;

  const lines: string[] = [];
  lines.push("🧭 **Matrix–Pi room — the reference card**");
  lines.push("");
  lines.push(
    "A Pi coding session works in a terminal; this room steers it. Want it shown instead of listed? `/matrix-introduction-tour`.",
  );
  lines.push("");

  lines.push("**Actions** — send these in the room");
  lines.push("");
  lines.push("| You send | What happens |");
  lines.push("| --- | --- |");
  lines.push("| plain text | the agent picks it up on its next poll and answers in this thread |");
  lines.push(
    "| `/name …` | runs in the terminal as if typed there — any extension command, `/skill:` stage, or prompt template. A misspelling comes back with the closest match; anything that is not a command is read as text |",
  );
  lines.push(
    `| \`@src/\` or \`@src/*.ts\` | lists the matches, shortest path first; reply with the number and that file's contents go to the agent${off(picker)} |`,
  );
  lines.push(
    `| \`@@readme\` | opens the artifact picker; pick one and it is uploaded and attached here${off(attach)} |`,
  );
  lines.push(
    `| a voice note | transcribed and treated as typed text, with a 🗣️ echo naming the engine${off(voice)} |`,
  );
  lines.push(
    "| `1` · `Q2: 3` · `Custom: …` · `confirm` | answers a decision the agent posted (option number, answer for question 2, a free-text answer, then send it) |",
  );
  lines.push("| `help` | re-posts this card |");
  lines.push("");

  lines.push("**Commands** — typed here they run in the terminal; the last column says where you see the answer");
  lines.push("");
  lines.push("| Command | Does | Answer shows |");
  lines.push("| --- | --- | --- |");
  lines.push("| `/matrix-help` (alias `/pi-help`) | this card | room |");
  lines.push("| `/matrix-introduction-tour` | replays the guided tour | room |");
  lines.push("| `/matrix-send TEXT` | posts TEXT into the room | room |");
  lines.push(
    "| `/matrix-thread-summarize` (alias `/matrix-summarize-thread`) | refreshes this thread's root summary now | room (the root message edits) |",
  );
  lines.push("| `/matrix-messages [n]` | reads back the last n room messages | terminal |");
  lines.push("| `/matrix-status` | server, room, user, threading, encryption | terminal |");
  lines.push("| `/matrix-subagents` | the session's live and settled sub-agent spawns | terminal |");
  lines.push("| `/matrix-thread-toggle` | threading on or off (footer 🧵 bright or faded) | terminal |");
  lines.push("| `/matrix-connect` · `/matrix-disconnect` | start or stop the connection | terminal (a connect posts its 🎯) |");
  lines.push("| `/matrix-toggle` | the whole integration on or off | terminal |");
  lines.push("| `/matrix-switch [profile]` | switch to another config profile | terminal |");
  lines.push("| `/matrix-login` | re-authenticate or add an account (its dialogue is terminal-side) | terminal |");
  lines.push("");

  lines.push("**What the agent posts here, on its own**");
  lines.push("");
  lines.push(
    "🎯 milestones at checkpoints · 📋 TODO progress · 💬 the turn's final answer · 🧑 the prompts you type in the terminal (room-typed ones are never echoed back) · ⚡ sub-agent spawn and result lines · 🤖 decision questionnaires · 🗣️ voice transcripts · 🧵 one thread per conversation, its root carrying a summary the agent keeps current",
  );
  lines.push("");
  lines.push(
    "Pi's own terminal built-ins (`/new`, `/reload`, `/settings`, `/hotkeys`) do not run from the room.",
  );
  lines.push("");

  lines.push("**Settings live in the config, not in commands**");
  lines.push("");
  lines.push(
    `The file is \`matrix-config.json\` (or \`.jsonc\`) in the \`.pi/matrix/\` folder of the directory pi was started in, so each project carries its own; \`~/.config/pi-matrix-integration/config.json\` (or \`.jsonc\`) covers projects that have none. Every key takes a \`PI_MATRIX_*\` override. Full reference, each key with its default: [docs/user/configuration.md](${CONFIG_DOC_URL})`,
  );
  return lines.join("\n");
}

/**
 * Detect an agent-directed "help" request in a room message body: a bare
 * `help`, or a mention of the agent (localpart, optionally with `:domain`)
 * followed by `help`. Pure, so it is unit-testable without the pi API.
 *
 * Accepted forms (case-insensitive, optional terminal punctuation):
 *   help | @pi_agent help | @pi_agent: help | @pi_agent:domain help | @pi_agent:domain: help
 * A mention only counts when its localpart is in `agentLocalParts`; a bare
 * `help` (no mention) is treated as agent-directed (this room has one agent).
 */
export function isAgentHelp(body: string, agentLocalParts: string[]): boolean {
  const m = String(body ?? "")
    .trim()
    .match(/^(@([A-Za-z0-9_]+)(?::[\w.-]+)?)?\s*[:-]?\s*help[!?.]?\s*$/i);
  if (!m) return false;
  const mention = m[2];
  if (!mention) return true; // bare "help"
  const lower = mention.toLowerCase();
  return agentLocalParts.some((p) => p.toLowerCase() === lower);
}
