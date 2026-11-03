/**
 * Pi Matrix Integration — `@` file attach 
 *
 * 10a: `@path` tokens in incoming room messages are pre-expanded into a
 * labeled content block (`@@ file: <path>\n<content>`) so the LLM sees
 * provenance + content. Tokens resolve against the working directory,
 * are symlink-safe (resolved token must stay inside the canonical cwd),
 * and are capped by `attachMaxBytes`; unresolvable tokens stay verbatim
 * with a one-line note instead of silently disappearing.
 *
 * 10b: a message that is ONLY an `@fragment` runs the chat-protocol
 * picker: project files (`git ls-files`, `find . -type f` outside git),
 * matched by case-sensitive substring OR — when the fragment carries `*` —
 * as a glob. Any fragment that is not itself a real file path answers with a
 * numbered plain-text auto-reply (no LLM turn) — including a search that
 * returns exactly one candidate, because one candidate is still a guess. The
 * list is capped at `pickerLimit`: more matches shows the top `pickerLimit`
 * (shortest path first) and says the list is partial, because a list the user
 * can read beats a refusal to list. A lone fragment that IS a real path
 * attaches directly, as does any `@token` inside an ordinary message (10a).
 * A follow-up reply with the number or the exact path resolves against the
 * last candidate list posted in the session (kept in memory, not re-derived
 * from history).
 *
 * All of it is pure except `pickFiles` (one `execFileSync` wrapper).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Path characters a token may carry. `?` and `[` stay out of the charset —
 * they read as sentence punctuation in a chat. `globs` adds `*`, and ONLY the
 * pickers ask for it: in an ordinary message `@src/*.ts` has no file to expand,
 * so it must stay literal text instead of becoming a "not found" note. */
export const TOKEN_CHARS = "[A-Za-z0-9_./-]";
/** The picker charset: the token characters plus `*`. Exported for the `@@`
 * picker, which resolves tokens the same way. */
export const GLOB_TOKEN_CHARS = "[A-Za-z0-9_./*-]";

/** A file token: `@` + path characters, not glued to a preceding word. */
function fileTokenRegex(prefix: string = "@", globs = false): RegExp {
  return new RegExp(`(^|\\s)${escapeRegExp(prefix)}(${globs ? GLOB_TOKEN_CHARS : TOKEN_CHARS}+)`, "g");
}

/**
 * Extract the path parts of every `@token` in the body. "word@x" and
 * "@@" are not tokens.
 */
export function extractFileTokens(body: string, prefix: string = "@", globs = false): string[] {
  const tokens: string[] = [];
  const re = fileTokenRegex(prefix, globs);
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(body ?? ""))) !== null) {
    tokens.push(m[2]);
  }
  return tokens;
}

export type ResolveOpts = {
  cwd: string;
  attachMaxBytes: number;
  fs: {
    exists: (p: string) => boolean;
    size: (p: string) => number;
    read: (p: string) => string;
    resolve: (p: string) => string;
  };
};

export type FileTokenResolution =
  | { kind: "expanded"; path: string; content: string }
  | { kind: "too-large"; note: string }
  | { kind: "outside"; note: string }
  | { kind: "missing"; note: string };

/**
 * Resolve one token against the fs wrapper. The resolved token (the
 * caller's `fs.resolve` — realpath in production) must stay inside the
 * canonical cwd; that is the symlink-escape guard. `cwd` is passed
 * canonical by the caller, so the prefix check runs against it.
 */
export function resolveFileToken(token: string, opts: ResolveOpts): FileTokenResolution {
  const { cwd, attachMaxBytes, fs } = opts;
  const resolved = fs.resolve(token);
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (resolved !== cwd && !resolved.startsWith(prefix)) {
    return { kind: "outside", note: `@${token} resolves outside the working directory (${resolved})` };
  }
  if (!fs.exists(token)) {
    return { kind: "missing", note: `@${token} not found` };
  }
  try {
    const size = fs.size(token);
    if (size > attachMaxBytes) {
      return {
        kind: "too-large",
        note: `@${token} is ${size} bytes, over the ${attachMaxBytes}-byte attach cap`,
      };
    }
    return { kind: "expanded", path: token, content: fs.read(token) };
  } catch {
    // unreadable file, a directory (EISDIR), or a stat/read failure: keep
    // the token verbatim with a one-line note instead of crashing the
    // message pipeline.
    return { kind: "missing", note: `@${token} could not be read` };
  }
}

/**
 * Does the fragment name one real file, exactly? Only then does a lone token
 * attach without a menu: the user pointed at a path, so there is nothing to
 * choose. Anything looser is a search — even a search with one candidate is a
 * guess, and a wrong guess attaches the wrong file in silence.
 *
 * `too-large` counts as a real file: the expansion path reports the size note,
 * which is a better answer than silently falling back to a candidate list.
 */
export function namesRealFile(fragment: string, opts: ResolveOpts): boolean {
  const kind = resolveFileToken(fragment, opts).kind;
  return kind === "expanded" || kind === "too-large";
}

/**
 * Replace every `@token` in the body: known file → `@@ file: <path>\n<content>`
 * block; missing / oversized / outside-cwd → token kept verbatim with a
 * one-line `(note: …)`. `prefix` defaults to `@`; pass the configured
 * `filePickerPrefix` so inline expansion matches the picker's token.
 */
export function expandBody(body: string, opts: ResolveOpts, prefix: string = "@"): string {
  const text = String(body ?? "");
  const re = fileTokenRegex(prefix);
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index + m[1].length);
    last = m.index + m[1].length + 1 + m[2].length;
    const res = resolveFileToken(m[2], opts);
    out += res.kind === "expanded"
      ? `@@ file: ${res.path}\n${res.content}`
      : `${prefix}${m[2]} (note: ${res.note})`;
  }
  out += text.slice(last);
  return out;
}

/**
 * The fragment test used by both pickers. A fragment without `*` is a
 * case-sensitive substring (the original behaviour). With `*` it is a glob:
 * `*` deliberately spans `/`, so `@src/*.ts` means "the .ts files under src",
 * not the shell's one directory level — `@src/**.ts` is the same search. Unanchored
 * like the substring test, and safe here because the caller ranks shortest
 * first and shows at most `pickerLimit` of them.
 */
export function fragmentMatcher(fragment: string): (path: string) => boolean {
  // A leading `./` is how people type a project-relative path, but the file
  // list never carries it (`git ls-files` prints `src/x.ts`, and the `find`
  // fallback strips it), so it can only ever match nothing.
  const text = fragment.startsWith("./") ? fragment.slice(2) : fragment;
  if (!text.includes("*")) return (path) => path.includes(text);
  const pattern = text.split("*").map(escapeRegExp).join(".*");
  const re = new RegExp(pattern);
  return (path) => re.test(path);
}

/**
 * Matching project files, ranked by path length (shortest first); no dupes.
 * Substring or glob — see `fragmentMatcher`.
 */
export function matchCandidates(fragment: string, files: string[]): string[] {
  if (!fragment) return [];
  const matches = fragmentMatcher(fragment);
  const seen = new Set<string>();
  const hits = files.filter((f) => {
    if (seen.has(f) || !matches(f)) return false;
    seen.add(f);
    return true;
  });
  return hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Numbered plain-text candidate list (no HTML, no markdown). `outOf` is the
 * TOTAL match count when the list was cut to fit `pickerLimit`: the reply
 * protocol only ever sees what was posted, so a partial list has to announce
 * itself or the user hunts for a file that was never shown.
 */
export function formatNumberedMatches(header: string, matches: string[], outOf = matches.length): string {
  const lines = matches.map((p, i) => `${i + 1}. ${p}`);
  const footer = outOf > matches.length
    ? `Showing the first ${matches.length} of ${outOf}. Reply with a number, or send a longer fragment to narrow the list.`
    : "Reply with the exact path (or its number) to attach.";
  return [header, ...lines, footer].join("\n");
}

/** Numbered list for the `@` picker. `prefix` is the configured
 *  token prefix — the header shows the token as the user typed it. */
export function formatCandidateList(fragment: string, matches: string[], outOf = matches.length, prefix = "@"): string {
  return formatNumberedMatches(`Matches for ${prefix}${fragment}:`, matches, outOf);
}

export function formatNoMatches(fragment: string, prefix = "@"): string {
  return `No file matches for ${prefix}${fragment}. Send a longer fragment, or a glob like ${prefix}src/*.ts.`;
}

/**
 * Session-scoped candidate-list state: a numbered or exact-path reply
 * resolves against the LAST list posted; re-posting replaces it.
 */
export class CandidateListTracker {
  private list: string[] = [];
  private posted = false;

  post(matches: string[]): void {
    this.list = [...matches];
    this.posted = true;
  }

  /** Trimmed body: 1-based number or exact path from the last list → that match; else null. */
  resolveReply(body: string): string | null {
    if (!this.posted) return null;
    const t = String(body ?? "").trim();
    if (this.list.includes(t)) return t;
    const n = /^\d+$/.test(t) ? Number(t) : 0;
    return n >= 1 && n <= this.list.length ? this.list[n - 1] : null;
  }
}

/**
 * Both protocol pickers in one object (configuration-and-room-behaviour.md): the
 * "@" file-attach picker  and the "@@" artifact-attach picker
 * . The "never share a posted list" invariant is now a type-level
 * fact — each protocol owns a distinct tracker instance; no shared
 * mutable state. The polls-based picker tag (configuration-and-room-behaviour.md open question)
 * is deferred — a new protocol = a new tracker here.
 */
export class PickerState {
  readonly file = new CandidateListTracker();
  readonly artifact = new CandidateListTracker();
}

/**
 * Project files: `git ls-files` when in a git repo (respects .gitignore),
 * `find . -type f` otherwise. ONE listing rule shared by both protocol
 * pickers — they used to carry their own copies and diverge on the cwd
 * ("@" picked from process.cwd(), "@@" from an injected dir).
 * Returns the raw relative list (non-empty lines only).
 */
export function listProjectFiles(cwd: string): string[] {
  let list: string[];
  try {
    const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" });
    list = out.split("\n");
  } catch {
    // not a git repo (or no git on PATH): fall back to the full tree
    let out: string;
    try {
      out = execFileSync("find", [".", "-type", "f"], { cwd, encoding: "utf8" });
    } catch {
      return [];
    }
    list = out.split("\n").map((l) => l.replace(/^\.\//, ""));
  }
  return list.filter((f) => f.trim() !== "");
}

/**
 * Project files matching the fragment (substring, or glob with `*`).
 * See `listProjectFiles` for the listing rule. Returns ALL matches —
 * the caller ranks via matchCandidates.
 */
export function pickFiles(fragment: string, cwd: string = process.cwd()): string[] {
  const matches = fragmentMatcher(fragment);
  return listProjectFiles(cwd).filter((f) => matches(f));
}

/**
 * The whole (trimmed) message is exactly one `@token` — the picker
 * protocol only fires on that shape; "@mar review" is a normal message.
 */
export function isLoneToken(body: string, prefix: string = "@", globs = false): boolean {
  const chars = globs ? GLOB_TOKEN_CHARS : TOKEN_CHARS;
  return new RegExp(`^${escapeRegExp(prefix)}${chars}+$`).test(String(body ?? "").trim());
}

/**
 * Production fs wrapper for ResolveOpts: realpath-based resolve (a
 * symlink that points outside the cwd is caught by the prefix check);
 * a path that does not exist cannot be realpathed, so fall back to the
 * lexical resolve and let the exists() check report "missing".
 */
export function nodeFsAttach(cwd: string): ResolveOpts["fs"] {
  const abs = (p: string) => pathResolve(cwd, p);
  return {
    exists: (p) => {
      try {
        return existsSync(abs(p));
      } catch {
        return false;
      }
    },
    size: (p) => statSync(abs(p)).size,
    read: (p) => readFileSync(abs(p), "utf8"),
    resolve: (p) => {
      const absPath = abs(p);
      try {
        return realpathSync(absPath);
      } catch {
        return absPath;
      }
    },
  };
}
