/**
 * Pi Matrix Integration — `@@` artifact attach 
 *
 * A room message that is ONLY `@@fragment` uploads a work artifact (a
 * `.md` or `.feature` file) OR a media file (image / audio / video) as a
 * real Matrix file attachment, instead of the earlier feature's inline `@` content
 * expansion. `fragment` is fuzzy-matched against the working directory's
 * attachable files (case-sensitive substring, ranked short-first — the
 * same matcher the earlier feature uses): a fragment that IS one of those paths uploads
 * it, anything looser posts a numbered list the user resolves with a
 * follow-up — even a 1-hit search, which is a guess, not a request.
 *
 * All of it is pure except `pickArtifactFiles` (one exec wrapper, `git
 * ls-files` / `find`) and `gitFileCommit` (one exec wrapper) — the impure
 * parts are injected or process-bound exactly like the earlier feature's `pickFiles`.
 */

import { execFileSync } from "node:child_process";
import {
  escapeRegExp,
  GLOB_TOKEN_CHARS,
  listProjectFiles,
  matchCandidates,
  TOKEN_CHARS,
} from "./file-attach.js";

/** The "way of working" artifact types: work planning / delivery files. */
export const ARTIFACT_EXTENSIONS = [".md", ".feature"];

/**
 * Media types the `@@` attach accepts alongside work artifacts: the
 * outbox `sendFile` path can carry any content type — only the picker
 * extension filter and the MIME table excluded these.
 */
export const MEDIA_EXTENSIONS = [
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".heic",
  // audio
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac",
  // video
  ".mp4", ".webm", ".mov", ".mkv",
];

/** Everything the `@@` attach picks: work artifacts + media. */
export const ATTACH_EXTENSIONS = [...ARTIFACT_EXTENSIONS, ...MEDIA_EXTENSIONS];

/**
 * `@@TOKEN` is a lone artifact token: exactly one, and it is the whole
 * message. `@@a b` and `@a` are not. (Distinct from the earlier feature's lone `@`:
 * that regex rejects a leading `@@`, so the two protocols never collide.)
 */
export function isLoneArtifactToken(body: string, prefix: string = "@@", globs = false): boolean {
  return new RegExp(`^${escapeRegExp(prefix)}${globs ? GLOB_TOKEN_CHARS : TOKEN_CHARS}+$`).test(String(body ?? "").trim());
}

/**
 * Candidate matcher backends for `@@` artifact attach:
 * - `builtin` (default): case-sensitive substring, ranked short-first —
 *   pure, deterministic, zero dependencies (the earlier feature's `matchCandidates`).
 * - `fzf`: rank the extension-filtered candidate list through headless
 *   `fzf` (relevance-ranked, subsequence/typo-tolerant). Impure; a
 *   missing or failing binary soft-falls-back to the builtin ranking for
 *   that message (never drops it).
 */
export type ArtifactSearchMode = "builtin" | "fzf";

/** The fragment after the artifact prefix, or "" when the body is not an artifact token. */
export function extractArtifactToken(body: string, prefix: string = "@@", globs = false): string {
  const chars = globs ? GLOB_TOKEN_CHARS : TOKEN_CHARS;
  const m = String(body ?? "").trim().match(new RegExp(`^${escapeRegExp(prefix)}(${chars}+)`));
  return m ? m[1] : "";
}

/** Case-insensitive extension check against the artifact extensions. */
export function isArtifactPath(
  path: string,
  extensions: string[] = ARTIFACT_EXTENSIONS,
): boolean {
  const lower = String(path ?? "").toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Working-directory artifact files matching `fragment` (case-sensitive
 * substring, ranked short-first, no dupes): the extension-filtered tree
 * fed through the earlier feature's `matchCandidates`. The file listing is the
 * shared `listProjectFiles` rule (git ls-files / find fallback) — same
 * rule and cwd as the "@" picker. `mode` picks the ranking backend.
 * Returns ALL ranked matches — the caller decides the 1 / 0 / many decision.
 */
export function pickArtifactFiles(
  fragment: string,
  cwd: string,
  extensions: string[] = ATTACH_EXTENSIONS,
  mode: ArtifactSearchMode = "builtin",
  onFzfFallback?: () => void,
): string[] {
  const artifacts = listProjectFiles(cwd).filter((f) => isArtifactPath(f, extensions));
  if (mode === "fzf") {
    const ranked = rankArtifactWithFzf(artifacts, fragment);
    if (ranked !== null) return ranked;
    // fzf unavailable: soft-fallback to the builtin ranking (never drop)
    onFzfFallback?.();
  }
  return matchCandidates(fragment, artifacts);
}

/**
 * Rank an extension-filtered artifact list for `fragment` via headless
 * `fzf` (`-f`: print matches for the query and exit — fzf ≥ 0.4x; older
 * versions used the trailing positional, which 0.66 turned into the
 * interactive UI query). Relevance-ranked, `--tiebreak=index` keeps it
 * deterministic for a given fzf version. Returns `null` when the binary
 * is missing or the invocation fails (the caller falls back to the
 * builtin ranking); returns `[]` when fzf authoritatively found no
 * matches (exit 1). `bin` is injectable so tests can point at a
 * guaranteed-missing binary.
 */
export function rankArtifactWithFzf(
  files: string[],
  fragment: string,
  bin: string = "fzf",
): string[] | null {
  if (files.length === 0) return [];
  try {
    const out = execFileSync(bin, ["-f", fragment, "--tiebreak=index"], {
      input: files.join("\n") + "\n",
      encoding: "utf8",
    });
    return out.split("\n").filter((l) => l.trim() !== "");
  } catch (error: unknown) {
    const code = (error as { code?: number | string }).code;
    if (code === 1) return []; // fzf exit 1 = "no matches" — authoritative
    return null; // ENOENT / spawn failure — fall back to builtin
  }
}

const MEDIA_MIME: ReadonlyArray<readonly [string, string]> = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".flac", "audio/flac"],
  [".aac", "audio/aac"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".mkv", "video/x-matroska"],
];

/** MIME type for the attach extension (the `m.file` `mimetype`). */
export function mimeFor(name: string): string {
  const lower = String(name ?? "").toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".feature")) return "text/plain";
  for (const [ext, mime] of MEDIA_MIME) {
    if (lower.endsWith(ext)) return mime;
  }
  return "application/octet-stream";
}

/** Case-insensitive media-extension check (the media half of `@@`). */
export function isMediaPath(
  path: string,
  extensions: string[] = MEDIA_EXTENSIONS,
): boolean {
  const lower = String(path ?? "").toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * The source-provenance caption, used as the `m.file` event `body` so a
 * client that does not render attachments still reads where the file came
 * from and which commit it was at. `commit` empty ⇒ "uncommitted".
 */
export function formatArtifactCaption(name: string, relPath: string, commit: string): string {
  const short = commit && commit !== "uncommitted" ? commit : "uncommitted";
  return `${name} — ${relPath} · ${short}`;
}

/**
 * Last commit hash touching `relPath` (short form), or "uncommitted" when
 * the file has no commit. One exec wrapper; a git failure is reported as
 * uncommitted rather than throwing into the message pipeline.
 */
export function gitFileCommit(relPath: string, cwd: string): string {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%h", "--", relPath], {
      cwd,
      encoding: "utf8",
    }).trim();
    if (out) return out;
  } catch {
    // no git, no repo, or the path has no commits — fall through
  }
  return "uncommitted";
}
