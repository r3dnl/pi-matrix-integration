/**
 * Pi Matrix Integration — `/matrix-help` guide builder (item: end-user guide)
 *
 * Produces a concise, natural-language overview of what a *room user* can do,
 * tailored to the live config (e.g. whether the @ picker is enabled). Kept a
 * pure function of `MatrixConfig` so it is unit-testable without the pi API.
 * The text is plain (no HTML) so it renders identically on desktop and mobile.
 */
import type { MatrixConfig } from "./types.js";

export function buildMatrixHelp(config: MatrixConfig): string {
  const lines: string[] = [];

  lines.push("🧭 Matrix–Pi Integration — how to use this room");
  lines.push("");
  lines.push("This room connects a Pi coding session to you. The agent works in a");
  lines.push("terminal; you steer it from here. Your messages are read by the agent,");
  lines.push("and it posts its progress and answers back into this room.");
  lines.push("");
  lines.push("What you can do here");
  lines.push("");
  lines.push("1. Just talk. Write in plain language and the agent picks it up on its");
  lines.push("   next poll. It replies with milestones and its final answer.");
  lines.push("");
  lines.push("2. Slash commands. Type /name and it runs as if typed in the terminal —");
  lines.push("   any extension command, /skill: pipeline command, or prompt template.");
  lines.push("   Misspell a command and the agent suggests the closest match. Not a");
  lines.push("   command at all? It's read as normal text.");
  lines.push("   Note: terminal built-ins (/new, /reload, /hotkeys, /settings) are");
  lines.push("   terminal-only and do not run from the room.");
  lines.push("");

  if (config.remoteFilePicker) {
    lines.push("3. Attach a file with @. Send a fragment like `@src/`, or a glob like");
    lines.push("   `@src/*.ts`. The agent lists the matches, shortest path first; reply");
    lines.push("   with the number (or the exact path) and that file's contents are");
    lines.push("   handed to the agent with its path.");
  } else {
    lines.push("3. Attach a file with @. This is currently disabled in this deployment");
    lines.push("   (remoteFilePicker is off). When the operator enables it, you'll be able to");
    lines.push("   send a fragment like `@src/` and pick a file to hand to the agent.");
  }
  lines.push("");
  lines.push("4. Decide things. When the agent needs a choice it posts a numbered list");
  lines.push("   here; reply with the number or the option text. Native polls are on");
  lines.push("   the roadmap.");
  lines.push("");
  lines.push("What the agent posts on its own");
  lines.push("  - 🎯 milestones as it hits checkpoints");
  lines.push("  - 📋 TODO progress updates");
  lines.push("  - 💬 its final answer at the end of a turn");
  lines.push("  - 🧑 your own terminal-typed prompts (so you see what you asked");
  lines.push("    for — Matrix-typed messages are never re-echoed)");
  lines.push("  - 🧵 a thread per conversation: its root message carries a");
  lines.push("    summary that the agent refreshes every few messages");
  lines.push("    (run /matrix-thread-summarize to refresh it on demand)");
  lines.push("  - formatted code and tables, rendered natively in Element");
  lines.push("");
  lines.push("Connection control (extension commands, also relayed from the room)");
  lines.push("  /matrix-connect  /matrix-disconnect  /matrix-toggle");
  lines.push("  /matrix-status   /matrix-messages   /matrix-thread-toggle (on/off, footer 🧵 shows)");
  lines.push("  /pi-help (= /matrix-help)");
  lines.push("  /matrix-thread-summarize (alias /matrix-summarize-thread) — make the");
  lines.push("  agent refresh the thread's summary right now");
  lines.push("");
  lines.push("Or just say it: send `@pi_agent: help` (or a bare `help`) and this same");
  lines.push("guide is posted here. Re-run /pi-help any time to get it again.");

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
    .match(/^(@([A-Za-z0-9_]+)(?::[\w.-]+)?)?\s*[:\-]?\s*help[!?.]?\s*$/i);
  if (!m) return false;
  const mention = m[2];
  if (!mention) return true; // bare "help"
  const lower = mention.toLowerCase();
  return agentLocalParts.some((p) => p.toLowerCase() === lower);
}
