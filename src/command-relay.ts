/**
 * Pi Matrix Integration — slash-command relay 
 *
 * Room-typed `/command` messages are dispatched exactly as if typed in the
 * Pi composer (`pi.sendUserMessage` + `expandPromptTemplates: true` — that
 * is what dispatches extension commands, `/skill:` commands and prompt
 * templates, verified in the SDK). Unknown command names get a plain-text
 * fuzzy-suggestion list back in the room (A3 decision: plain text first,
 * polls second — the suggestion list is kept as a pure function so the
 * poll transport slots in later without touching the relay).
 */

export interface CommandName {
  name: string;
}

/**
 * A room message that starts with `/name` (optionally `:scoped`), with the
 * remainder as args. Returns null when the text is not a command line.
 */
export function parseCommandLine(
  text: string,
  prefix: string = "/",
): { name: string; args: string } | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${escaped}([a-z][\\w:-]*)(?:\\s+([\\s\\S]*))?$`, "i").exec(String(text ?? '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

/** Exact (case-insensitive) match against the live command registry. */
export function findCommand(name: string, commands: CommandName[]): CommandName | null {
  const n = name.toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === n) ?? null;
}

/**
 * Fuzzy candidate list for an unknown command name. Scoring: prefix/
 * substring (so a bare scoped prefix like "/skill" lists the `skill:*`
 * menu) beats typo distance (Levenshtein ≤ 2, compared against the whole
 * name and its first `:`-segment). Exact full-name matches are excluded —
 * the caller handles those.
 */
export function fuzzyCommandCandidates(
  name: string,
  commands: CommandName[],
  limit = 5,
): string[] {
  const n = name.toLowerCase();
  const scored = commands
    .map((c) => {
      const cn = c.name.toLowerCase();
      const seg = cn.split(':')[0];
      const d = Math.min(lev(n, cn), lev(n, seg));
      let score: number;
      if (cn === n) score = -1; // exact full-name match — caller's problem
      // prefix/substring: a bare scoped prefix like "/skill" matches as a
      // prefix of every "skill:*" name, so the scoped menu lists itself
      else if (cn.startsWith(n) || n.startsWith(cn) || cn.includes(n)) score = 1;
      else if (d <= 2) score = 3 + d; // typos: 4..5
      else if (n.length >= 4 && n.includes(cn)) score = 4;
      else score = 99;
      return { name: c.name, score };
    })
    .filter((s) => s.score !== -1 && s.score <= 5)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * The plain-text reply shown when an unknown `/name` has fuzzy candidates
 * A later version replaces the text reply with a Matrix poll.
 */
export function formatCommandSuggestion(name: string, candidates: string[]): string {
  const list = candidates.map((c) => `/${c}`).join(' ');
  return `/${name} is not a known command — did you mean: ${list}? Reply with the exact command.`;
}

/** Levenshtein distance, only meaningful for short names (capped). */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < 3 || b.length > 24) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1));
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}
