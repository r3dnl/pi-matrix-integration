/**
 * Pi Matrix Integration — `/matrix-help` guide builder (item: end-user guide)
 *
 * The room's reference card: what you can send, what every command does, what
 * the agent posts on its own, and where settings live. Condensed on purpose —
 * the guided walk is `/matrix-introduction-tour`, so nothing here re-explains
 * a feature; it names it and says where the answer shows up.
 *
 * Kept a pure function of `MatrixConfig` (like the tour) so it is unit-testable
 * without the pi API, and deliberately HTML-free. The card body ships as ONE
 * fenced block: Element X (iOS) shows the plain-text fallback for
 * table-heavy messages — where a single newline collapses and a markdown
 * table is just pipes — and a fenced block is the one layout that renders
 * identically in every client: monospace via `<pre>` when the formatted HTML
 * is used, monospace via the markdown code-block fallback when it is not.
 * Ceiling: no links or emphasis inside the fence (escaped verbatim), so the
 * intro line and the configuration-reference link ride outside it, where
 * bold and links do render on Element X (verified live). If Element X grows
 * full table rendering, the card may move back to markdown tables.
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

/** Marks a room action this deployment switched off (verbatim monospace —
 *  no markdown emphasis, the card body is a fenced block). */
const off = (enabled: boolean): string => (enabled ? "" : " (off here)");

/** One aligned row inside the fenced card: pad the command to its column. */
const row = (left: string, right: string): string =>
  `  ${left.padEnd(26)}${right}`.trimEnd();

/**
 * The guide: a bold intro line, then the reference card as ONE fenced block
 * of aligned plain text (see the header comment for why), then the settings
 * link outside the fence so it stays clickable where HTML renders. Every
 * command `src/commands.ts` registers is listed (the docs gate fails either
 * way it is wrong: a missing command, or one that does not exist), and each
 * command row carries the split the room cannot guess — most commands answer
 * in the terminal, not here.
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

  // The fenced block. No backticks, links or *emphasis* inside — verbatim
  // monospace is the point; alignment comes from the spaces.
  lines.push("```");
  lines.push("YOU SEND (in the room)");
  lines.push(row("plain text", "agent answers in this thread"));
  lines.push(row("/name …", "runs in the terminal as typed"));
  lines.push(row("", "there; misspellings get the"));
  lines.push(row("", "closest match"));
  lines.push(row("@src/  @src/*.ts", `list matching files${off(picker)}`));
  lines.push(row("", "reply with a number to send"));
  lines.push(row("", "that file to the agent"));
  lines.push(row("@@readme", `artifact picker${off(attach)}`));
  lines.push(row("", "pick one, it is attached here"));
  lines.push(row("a voice note", `transcribed → text${off(voice)}`));
  lines.push(row("1 · Q2: 3 · confirm", "answer a 🤖 decision card"));
  lines.push(row("help", "re-posts this card"));
  lines.push("");

  lines.push("COMMANDS — typed in the room, run in the terminal;");
  lines.push("the answer shows in the terminal unless (room)");
  lines.push(row("/matrix-help  /pi-help", "this card (room)"));
  lines.push(row("/matrix-introduction-tour", "replays the tour (room)"));
  lines.push(row("/matrix-send TEXT", "posts TEXT here (room)"));
  lines.push(row("/matrix-thread-summarize", "refreshes this thread's"));
  lines.push(row("/matrix-summarize-thread", "root summary now (room)"));
  lines.push(row("/matrix-messages [n]", "reads back the last n messages"));
  lines.push(row("/matrix-status", "server, room, user, encryption"));
  lines.push(row("/matrix-subagents", "live/settled sub-agent spawns"));
  lines.push(row("/matrix-thread-toggle", "threading on/off (footer 🧵)"));
  lines.push(row("/matrix-connect", "start (a connect posts its 🎯)"));
  lines.push(row("/matrix-disconnect", "stop the connection"));
  lines.push(row("/matrix-toggle", "the whole integration on/off"));
  lines.push(row("/matrix-switch [profile]", "switch config profile"));
  lines.push(row("/matrix-login", "re-authenticate / add account"));
  lines.push("");

  lines.push("WHAT THE AGENT POSTS HERE, ON ITS OWN");
  lines.push("  🎯 milestones    📋 TODO progress");
  lines.push("  💬 final answer  🧑 your terminal prompts");
  lines.push("     (room-typed ones are never echoed back)");
  lines.push("  ⚡ sub-agent lines   🤖 decision cards");
  lines.push("  🗣️ voice transcripts");
  lines.push("  🧵 one thread per conversation; its root");
  lines.push("     carries a summary the agent keeps current");
  lines.push("");

  lines.push("Pi built-ins (/new, /reload, /settings, /hotkeys)");
  lines.push("are terminal-only — they do not run from here.");
  lines.push("");

  lines.push("SETTINGS — in the config, not in commands");
  lines.push("  matrix-config.json(.c) in the .pi/matrix/ folder");
  lines.push("  of the project pi was started in;");
  lines.push("  ~/.config/pi-matrix-integration/ config.json(.c)");
  lines.push("  covers projects that have none. Every key takes");
  lines.push("  a PI_MATRIX_* env override.");
  lines.push("```");
  lines.push("");
  lines.push(
    `Full reference, each key with its default: [docs/user/configuration.md](${CONFIG_DOC_URL})`,
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
