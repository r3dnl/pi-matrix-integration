/**
 * Pi Matrix Integration - Configuration Management
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { MatrixConfig, PartialMatrixConfig } from './types.js';
// Type-only: erased at runtime, so config-utils.ts keeps no dependency on config
// even though config imports values from here.
import type { ConfigV2 } from './config.js';

/**
 * Load environment variables from .env files.
 * Checks in order: project .env, extension .env, then stops at first found.
 * Returns true if any .env file was loaded and processed.
 */
export function loadEnvFiles(): boolean {
  const envPaths = [
    join(process.cwd(), '.env'),
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', '.env'),
    join(getExtensionDir(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        parseDotenv(content);
        return true;
      } catch (error) {
        console.warn(`[matrix] Failed to load .env from ${envPath}:`, error);
      }
    }
  }
  return false;
}

/**
 * Simple dotenv parser - handles KEY=value and KEY="value" formats.
 * Skips comments (lines starting with #) and empty lines.
 * Does not handle multi-line values or complex escaping - keeps it simple.
 */
function parseDotenv(content: string): void {
  const lines = content.split('\n');
  
  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Find the first = that's not inside quotes
    const equalsIndex = findEqualsOutsideQuotes(trimmed);
    if (equalsIndex === -1) continue;
    
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    
    if (!key) continue;
    
    // Remove surrounding quotes if present
    const unquotedValue = removeSurroundingQuotes(value);
    
    // Only set if not already in environment (later .env files don't override earlier ones)
    if (process.env[key] === undefined) {
      process.env[key] = unquotedValue;
    }
  }
}

/**
 * Find the first = character that's not inside quotes.
 */
function findEqualsOutsideQuotes(line: string): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === '=' && !inSingleQuote && !inDoubleQuote) {
      return i;
    }
  }
  
  return -1;
}

/**
 * Remove surrounding single or double quotes from a string.
 */
function removeSurroundingQuotes(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Simple JSONC parser - removes comments and then parses as JSON.
 * Handles both // single-line and block (multi-line) comments.
 * This allows .jsonc files to be used for config with comments.
 */
/** Parse a .json/.jsonc file body. Exported for the v1 -> v2 conversion, which
 * must migrate the FILE's values, not the merged config (see config). */
export function parseJsonc(content: string): Record<string, unknown> {
  // Comment stripping must be string-aware: a regex sweep deletes the `//`
  // inside "http://…" config values and corrupts the document (the
  // sttBaseUrl incident — unterminated string, un-loadable config, login
  // prompt on restart). One pass with a tiny state machine instead: inside a
  // string only `"` (honouring `\`) ends the run; outside it, `//` skips to
  // the newline and `/* … */` skips to the close.
  let out = '';
  let inString = false;
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (inString) {
      if (c === '\\') { out += content.slice(i, i + 2); i += 2; continue; }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && content[i + 1] === '/') { while (i < content.length && content[i] !== '\n') i++; continue; }
    if (c === '/' && content[i + 1] === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * Map a v2 nested config object to the flat MatrixConfig structure.
 * Used by loadConfig when it encounters a v2 .jsonc file.
 * This is the inverse of the v2 section structure — pulls values from
 * the nested sections into the flat keys the rest of the code expects.
 */
/** Drop keys whose value is `undefined`. A v2 file that omits a field must
 * keep its DEFAULT_CONFIG value; spreading a mapped `undefined` over the
 * defaults would erase them. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function mapV2ToFlat(v2: Record<string, unknown>): Record<string, unknown> {
  const identity = (v2.piMatrixIdentity ?? {}) as Record<string, unknown>;
  const connection = (v2.piMatrixConnection ?? {}) as Record<string, unknown>;
  const room = (v2.piMatrixRoom ?? {}) as Record<string, unknown>;
  const logging = (v2.piMatrixLogging ?? {}) as Record<string, unknown>;
  const threading = (v2.piMatrixThreading ?? {}) as Record<string, unknown>;
  const subThreadsCfg = (threading.subThreads ?? {}) as Record<string, unknown>;
  const subagents = (v2.piMatrixSubagents ?? {}) as Record<string, unknown>;
  const ui = (v2.piTerminalUi ?? {}) as Record<string, unknown>;
  const send = (v2.piMatrixMessageFormatting ?? {}) as Record<string, unknown>;
  const milestones = (v2.sendMilestones ?? {}) as Record<string, unknown>;
  const sendUser = (v2.sendUserMessages ?? {}) as Record<string, unknown>;
  const sendFinal = (v2.sendFinalMessages ?? {}) as Record<string, unknown>;
  const slash = (v2.matrixToPiSlashCommands ?? {}) as Record<string, unknown>;
  const mirror = (v2.piToMatrixMirrorAskUserQuestions ?? {}) as Record<string, unknown>;
  const attachPi = (v2.matrixToPiRemoteFilePicker ?? {}) as Record<string, unknown>;
  const attachMx = (v2.piToMatrixFileAttachment ?? {}) as Record<string, unknown>;
  const login = (v2.piTerminalMatrixLoginCommand ?? {}) as Record<string, unknown>;
  const voice = (v2.matrixToPiVoiceTranscription ?? {}) as Record<string, unknown>;

  return {
    userId: identity.userId,
    homeserver: identity.homeserver,
    credentialsPath: identity.credentialsPath,
    deviceId: identity.deviceId,
    cryptoStoreDir: identity.cryptoStoreDir,
    storePassphrase: identity.storePassphrase,
    autoConnect: connection.autoConnect,
    syncTimeoutMs: connection.syncTimeoutMs,
    roomId: connection.roomId,
    roomTopicUpdates: room.updateTopic,
    e2ee: room.endToEndEncryption === false ? "off" : "on",
    attachEncryption: room.attachmentEncryption === false ? "off" : "on",
    logPath: logging.logPath,
    logLevel: logging.logLevel,
    threads: threading.enabled,
    threadIcon: threading.threadIcon,
    threadSummaryEvery: threading.summaryCadence,
    threadSummaryFib: threading.useFibonacciCadence,
    threadSummaryOnFinal: threading.summarizeOnFinalMessage,
    threadSummaryByLlm: threading.useLlmForSummaries,
    threadSummarizeLimit: threading.summarizeLimit,
    threadSummarizeMilestoneMax: threading.summarizeMilestoneMax,
    threadSummarizeRecentMax: threading.summarizeRecentMax,
    threadSummarizeMaxLines: threading.summarizeMaxLines,
    threadSummarizeModel: threading.summarizeModel,
    threadSummarizeRunTimeoutMs: threading.summarizeRunTimeoutMs,
    threadSummarizeSource: threading.summarizeSource,
    threadPendingRoute: threading.pendingRoute,
    subThreads: subThreadsCfg.enabled,
    rolePrefixes: subThreadsCfg.showRolePrefixes,
    subagentToolName: subThreadsCfg.toolName,
    showInFooter: ui.showMatrixStatus,
    footerIcon: ui.matrixIcon,
    subagents: stripUndefined({
      enabled: subagents.enabled,
      spawnMessages: subagents.postSpawnMessages,
      summarizeResultIntoSpawnLine: subagents.summarizeResultIntoSpawnLine,
      postMode: subagents.postMode,
      colorByType: subagents.colorByType,
      colorPalette: subagents.colorPalette,
      plainMarker: subagents.plainMarker,
      provider: subagents.provider,
    }),
    promptConnectOnStartup: connection.promptConnectOnStartup,
    piTerminalMatrixMessagePrefix: send.prefix,
    sendFormatted: send.sendFormatted,
    tablesInSeparateMessage: send.sendTablesInSeparateMessages,
    dedupeWindowMs: connection.dedupeWindowMs,
    maxMessageAgeMinutes: connection.maxMessageAgeMinutes,
    maxFinalMessageLength: send.maxFinalMessageLength,
    sendMilestones: milestones.enabled,
    sendSessionStartStopMilestones: milestones.sendSessionStartStopMilestones,
    sendCompactionMilestones: milestones.sendCompactionMilestones,
    sendModelChangeMilestones: milestones.sendModelChangeMilestones,
    sendUserMessages: sendUser.enabled,
    sendFinalMessages: sendFinal.enabled,
    milestoneIcon: milestones.milestoneIcon,
    userMessageIcon: sendUser.icon,
    slashRelay: slash.enabled,
    slashCommandPrefix: slash.slashCommandPrefix,
    mirrorAskUser: mirror.enabled,
    mirrorAskUserPolls: mirror.createPollsForAskUserQuestions,
    remoteFilePicker: attachPi.enabled,
    attachMaxBytes: attachPi.maxBytes,
    pickerLimit: attachPi.pickerLimit,
    fileSearchMethod: attachPi.fileSearchMethod,
    filePickerPrefix: attachPi.fileAttachPrefix,
    matrixLoginEnabled: login.enabled,
    qr2025: login.qr2025,
    voiceTranscription: voice.enabled,
    sttBaseUrl: voice.sttBaseUrl,
    sttModel: voice.sttModel,
    displayStdoutOnStartup: ui.displayStdoutOnStartup,
    fileAttach: attachMx.enabled,
    fileAttachPrefix: attachMx.prefix,
    maxBytesUpload: attachMx.maxBytesUpload,
  };
}

/**
 * v2 typo guard. `mapV2ToFlat` reads every v2 key the loader understands, so it
 * IS the schema — wrap the parsed document so each access records itself, then
 * report what the file carries and the mapping never read. Without this a v2
 * file has no protection at all: `sendMilestons: true` inside sendMilestones,
 * or a leftover v1 flat key at top level, is dropped in silence — while the
 * flat v1 format has always warned (validateConfig). Deriving the allowed set
 * from the reader means the guard cannot drift away from it.
 */
function recordV2Reads(v2: Record<string, unknown>, read: Set<string>): Record<string, unknown> {
  const wrap = (obj: Record<string, unknown>, prefix: string): Record<string, unknown> =>
    new Proxy(obj, {
      get(target, prop) {
        if (typeof prop !== 'string') return Reflect.get(target, prop);
        const path = prefix ? `${prefix}.${prop}` : prop;
        read.add(path);
        const value = target[prop];
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return wrap(value as Record<string, unknown>, path);
        }
        return value;
      },
    });
  return wrap(v2, '');
}

function warnUnreadV2Keys(v2: Record<string, unknown>, read: Set<string>): void {
  const unread: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (path === 'configVersion') continue;
      if (!read.has(path)) {
        // An unknown section is reported once, not once per key inside it.
        unread.push(path);
        continue;
      }
      // A v2 document's top level is configVersion plus section objects. A
      // scalar there is a v1 flat key that shares a section's name —
      // `sendMilestones` is both — and the mapping reads `.enabled` off it and
      // silently gets nothing.
      if (prefix === '' && (value === null || typeof value !== 'object')) {
        unread.push(`${path} (expected a section)`);
        continue;
      }
      // Descend only where the reader actually went. `colorPalette` is a
      // free-form map (subagent type -> colour) that the mapping hands over
      // whole, so its keys are nobody's schema and must not be reported.
      const below = `${path}.`;
      const readerWentIn = value !== null && typeof value === 'object' && !Array.isArray(value) &&
        [...read].some((r) => r.startsWith(below));
      if (readerWentIn) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };
  walk(v2, '');
  if (unread.length > 0) {
    console.warn(`[matrix] config: ignoring unknown key(s): ${unread.join(', ')}`);
  }
}

// Default configuration.
//
// Naming notes:
// - ``roomId`` is the room **alias** (e.g., ``#pi-updates:matrix.example.com``), not a room id:
//   the server generates the real ``!…`` room id at creation, but the alias
//   is stable, carries the ``alias`` field the alias resolver reads, and the
//   server resolves aliases to room ids.
// - Placeholder values use {brackets} to indicate what should be replaced.
export const DEFAULT_CONFIG: MatrixConfig = {
  // userId + homeserver are intentionally ABSENT:
  // the account store's credentials file is the single source of truth for
  // user_id + homeserver. loadConfig derives them from the credentials file
  // when the config/env value is absent; a present-but-mismatched userId is
  // a validation error (the identity invariant) — never a silent drift.
  roomId: '#{room-name}:{matrix-server-domain}',
  credentialsPath: '~/.config/mtx/accounts/{pi-matrix-username}--{matrix-domain}/credentials.json',
  showInFooter: true,
  piTerminalMatrixMessagePrefix: '[Matrix] ',
  // On by default: preserves the heuristic auto-broadcasts (milestone /
  // TODO marker scans). Opt out for quiet rooms; the `matrix_send_milestone`
  // tool stays available regardless.
  sendMilestones: true,
  // Lifecycle milestone broadcasts: session start/reload/new, compaction,
  // model/thinking-level switch. Each gated independently; all default true
  // (the room gets a short "Pi did X" line at each event).
  sendSessionStartStopMilestones: true,
  sendCompactionMilestones: true,
  sendModelChangeMilestones: true,
  // Terminal-typed user prompt broadcast: "🧑 User: …" in the room when the
  // user types a prompt in the Pi terminal. Only fires for genuine
  // terminal-typed input (source === "interactive"), never for
  // Matrix-relayed messages. Default true.
  sendUserMessages: true,
  // On by default: broadcast every turn's final message so "Pi updates on my
  // phone" just works. Opt out (config file / env var) when it gets chatty
  // in interactive sessions.
  sendFinalMessages: true,
  // Connect + start polling at session start. Opt out with
  // PI_MATRIX_AUTO_CONNECT=false; `/matrix-connect` stays the manual retry.
  autoConnect: true,
  // Content-level dedupe window for outgoing sends (10 min default).
  dedupeWindowMs: 600_000,
  // Inbound staleness guard (minutes). The initial sync and every limited
  // timeline after a disconnect arrive flagged live (matrix-js-sdk: liveEvent
  // means "landed on the live timeline", not "just happened"), so hours-old
  // room history can stream in as if it were said now. Older than this →
  // drop + warn + one room notice. 0 disables.
  maxMessageAgeMinutes: 30,
  // Final-message broadcast cutoff (chars) for mobile readability.
  maxFinalMessageLength: 8000,
  // --- v2 schema defaults (single source of truth; the v2 section defaults
  // in config.ts mirror these numbers) ---
  // Logger verbosity floor.
  logLevel: "INFO",
  // Prefix icon for milestone posts.
  milestoneIcon: "🎯",
  // Prefix icon for the user's own terminal prompt posted to the room.
  userMessageIcon: "🧑",
  // Prefix that marks a relayed slash command coming from the room.
  slashCommandPrefix: "/",
  // Prefix that triggers the in-terminal file picker.
  filePickerPrefix: "@",
  // Prefix that triggers a file attach on an outbound room message.
  fileAttachPrefix: "@@",
  // Attach cap, shared by text and media (@@ attach).
  maxBytesUpload: 25_000_000,
  // Whether /matrix-login is offered in the terminal.
  matrixLoginEnabled: true,
  // Whether the startup banner is echoed to stdout.
  displayStdoutOnStartup: false,
  // Always on: the sdk is the only transport
  // and the pipeline translates markdown <-> HTML in both directions
  // (outbound `formatted_body`, inbound `htmlToMarkdown` in formatForPi).
  // Keep `false` only as a debug escape hatch (plain-mode invariant: no
  // HTML is ever posted).
  sendFormatted: true,
  // Only if mobile chokes on inline tables.
  tablesInSeparateMessage: false,
  // Recurring extension errors (reconnect loops, failed sends) append here
  // instead of the TUI console.
  logPath: '.pi/matrix/logs/pi-matrix.log',
  // Relay room-typed /commands into Pi as composer input.
  slashRelay: true,
  // Dual-surface RPIV decisions: mirror `ask_user_question` questionnaires
  // into the room so a phone reply can proceed a RPIV decision (terminal
  // stays usable; first surface to complete wins). Opt out with false.
  mirrorAskUser: true,
  // Native Matrix polls (m.poll) for RPIV decision questions: each
  // single-select question also ships as a tappable poll alongside the text
  // questionnaire (poll tap = a third answer surface for the same reducer).
  // Multi-select questions and custom answers stay on the text grammar.
  // No-op when mirrorAskUser is false. Opt out with false.
  mirrorAskUserPolls: true,
  // `@` file attach: @token pre-expansion (10a) + picker
  // auto-replies (10b). Off by default.
  remoteFilePicker: false,
  // Voice-message transcription: an m.audio/m.voice room
  // message is downloaded, decoded (ffmpeg) and transcribed (local
  // Whisper, the dictate-local chain), then injected as the sender's
  // text. On by default (opt out with false / PI_MATRIX_VOICE_TRANSCRIPTION).
  voiceTranscription: true,
  // Remote STT endpoint tried before the local voice engine: an
  // OpenAI-shaped POST {sttBaseUrl}/audio/transcriptions (multipart
  // file/model/response_format=json — e.g. an mlx-audio server on the
  // LAN). Any remote failure falls back to the local chain above.
  // Empty = local-only, the conservative default: no LAN dependency
  // unless the operator declares one.
  sttBaseUrl: "",
  sttModel: "mlx-community/whisper-small-asr-fp16",
  // `@@` outbound attach: a lone @@fragment uploads a work artifact or a
  // media file (image/audio/video) as a Matrix file attachment. One cap for
  // both — `maxBytesUpload` — because media is the binding case. Uploads go
  // through the sdk transport. Off by default.
  fileAttach: false,
  // Candidate matcher for `@@` artifact attach: "builtin" (pure
  // substring + length rank, zero deps) or "fzf" (headless fzf relevance
  // ranking, soft-falls-back to builtin when the binary is missing).
  fileSearchMethod: "builtin",
  // Cap for inlined @-attached file content (bytes); bigger files get a
  // one-line note instead of content.
  attachMaxBytes: 200_000,
  // Candidate list length for both pickers: the numbered list shows at most
  // this many matches (closest path first) and says how many it hid.
  pickerLimit: 10,
  // Threading: session→thread mapping with
  // lazy root creation. Thread writes ride the outbox write surface
  // (the SdkOutbox thread delegate).
  // Default true.
  threads: true,
  // QR login (2025 variant, MSC4108/MSC4388) method offer (configuration-and-room-behaviour.md).
  // Off by default; the probe re-checks the server + crypto at login time.
  qr2025: false,
  threadIcon: "🧵",
  // TUI footer connected-state glyph ("✗" down-state stays fixed).
  footerIcon: "💬",
  threadSummaryEvery: 10,
  // Fibonacci-capped summary cadence: trigger interval starts 1,1,2,3,5,8…
  // capping at threadSummaryEvery (whichever is lower). Default on; false
  // restores the fixed modulo cadence.
  threadSummaryFib: true,
  // Report-out trigger: a "final" post (the turn's report-out, the
  // sendFinalMessages turn_end broadcast) runs a summary pass right after
  // it lands. Default on; heuristic edits are zero-cost, LLM runs are the
  // small summarizer model.
  threadSummaryOnFinal: true,
  threadSummaryByLlm: true,
  roomTopicUpdates: false,
  subThreads: false,
  rolePrefixes: true,
  subagentToolName: "subagent",
  // Side-chain sub-agent tracking: detection +
  // routing are always on; these gate the reporting only.
  subagents: {
    enabled: true,
    spawnMessages: true,
    summarizeResultIntoSpawnLine: true,
    postMode: "turn-end" as const,
    colorByType: undefined as Record<string, string> | undefined,
    colorPalette: undefined as string[] | undefined,
    plainMarker: "⚡",
    // Default dialect: @tintinweb/pi-subagents. "auto" re-probes and flips
    // to the nicobailon package when tintinweb is silent — that package has
    // an upstream wake-handling bug (roadmap 0.10), so the flip is no
    // longer the default. Opt back in with provider: "auto".
    provider: "tintinweb" as const,
  },
  // Thread-summary prompt delta cap (most-recent thread messages kept in the
  // summarizer prompt). Default 40.
  threadSummarizeLimit: 40,
  // Fir-tree summary caps: ## Milestones max
  // lines, ## Recent activity max bullets, hard total-line cap on the posted
  // body (line-boundary truncate + warn as backstop; the prompt carries the
  // same cap as primary control).
  threadSummarizeMilestoneMax: 8,
  threadSummarizeRecentMax: 5,
  threadSummarizeMaxLines: 25,
  // Model pin for the thread-summary subagent run (small model keeps cadence
  // runs cheap). Omit to inherit the session model.
  // Watchdog for a HUNG run that never notifies (dead child, lost bus) — it
  // releases the single-flight flag, it is not a duration budget: slow
  // completions always post (2026-10-24: 120_000 dropped successful 8-13min
  // ornith runs). Typed default so env coercion reads a number.
  threadSummarizeRunTimeoutMs: 1_800_000,
  threadSummarizeModel: undefined as string | undefined,
  // Where the summarizer's delta comes from: "room" (the thread's own Matrix
  // messages, subagent-driven) or "session" (the Pi session's own context,
  // legacy in-session re-prompt). Default "room".
  threadSummarizeSource: "room" as "room" | "session",
  // Where non-user sends from a pending session (no thread root yet) go:
  // "flat" = fall through to the main conversation (today's configuration-and-room-behaviour.md behavior);
  // "latest" = soft-attach them to the most recent thread root. Headless and
  // sub-agent sessions never deliver a user message, so without "latest" they
  // post their session-start milestone and work milestones flat forever.
  threadPendingRoute: "flat" as "flat" | "latest",
  // transport-and-state.md (matrix-js-sdk transport):
  // MSC4125 sender-side attachment encryption — the VectorIM Element Web
  // `isEncrypted === !!content.file` fix. On by default; "off" for
  // plaintext-only setups (those clients then see the VectorIM bug).
  attachEncryption: "on",
  // E2EE (the bundled Rust crypto WASM + file-backed store under
  // cryptoStoreDir). On by default: the homeserver defaults new rooms to
  // encrypted, and the pi room's E2EE toggle (transport-and-state.md configuration-and-room-behaviour.md) rides on it.
  e2ee: "on",
  // Crypto-store root; undefined → `<dirname(credentialsPath)>/store`
  // (the account dir that holds credentials.json, transport-and-state.md).
  cryptoStoreDir: undefined as string | undefined,
  // At-rest encryption for the crypto store (the WASM's `storagePassword`):
  // when set, the on-disk key material is unreadable without the passphrase.
  storePassphrase: undefined as string | undefined,
  // The stable device id (the bot's E2EE identity across restarts).
  // undefined → the credentials file's own device_id (the token is
  // device-bound; the SDK must present that id or /keys/upload 400s).
  deviceId: undefined as string | undefined,
  // The SDK sync long-poll cap (ms). 30 s is the Matrix spec recommendation;
  // this number is the one that actually ships, because DEFAULT_CONFIG wins
  // whenever a config file omits the key (test/config-migration.mjs asserts
  // the two default tables agree).
  syncTimeoutMs: 30_000,
  // First-run project connection prompt: ask to connect to Matrix room on
  // first Pi start in a new project folder. Default true.
  promptConnectOnStartup: true,
};

/**
 * Directory of the extension installation (parent of src/), used to locate
 * the config file that ships next to the extension.
 */
export function getExtensionDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Project-local config candidate candidate: the CURRENT project's `.pi`
 * folder. Pi runs with the project as cwd, so `<cwd>/.pi/matrix/` is
 * per-project: config, profiles, the last-active-profile pointer, and
 * `state/` all live there. Absent → global resolution continues.
 */
export function getProjectConfigPath(): string {
  return join(process.cwd(), '.pi', 'matrix', 'matrix-config.json');
}

/** True when the active config path IS the project-local config — under
 *  either accepted extension (`.json` or `.jsonc`, both resolver
 *  candidates). Every project-scoped feature (state dir, log co-location)
 *  must gate on this, never on a bare `=== getProjectConfigPath()`. */
export function isActiveConfigProjectLocal(active: string | undefined): boolean {
  if (!active) return false;
  return active === getProjectConfigPath() || active === getProjectConfigPath().replace(/\.json$/, '.jsonc');
}

/**
 * The per-project key for the credentials store: the sanitized name of the
 * directory Pi starts in (Pi runs with the project root as cwd). Slug rules:
 * lowercase, non-alphanumeric runs → '-', trimmed (matrix.example.org→matrix-example-org,
 * Strata→strata). PI_MATRIX_PROJECT overrides it — for hand-named projects
 * that do not map from the cwd (the existing `tennisplanner` dir, whose repo
 * is `tennisplanner_2026`).
 */
export function getProjectName(): string {
  const override = process.env.PI_MATRIX_PROJECT;
  if (override && override.trim()) return override.trim();
  const slug = basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/**
 * The per-project credentials path for an account leaf
 * (`<localpart>--<domain>`):
 * `~/.config/mtx/projects/{project}/accounts/{leaf}/credentials.json`.
 * Stored in `~` form — loadConfig expands it (expandHome). At seed time the
 * leaf is a placeholder; /matrix-login overwrites the config with the real
 * leaf it derives from user_id + homeserver. Only the `accounts` segment
 * matters to the login flow's credsDir derivation, so the placeholder is safe.
 */
export function getProjectCredentialsPath(
  leaf: string = '{pi-matrix-username}--{matrix-domain}',
  project: string = getProjectName(),
): string {
  return `~/.config/mtx/projects/${project}/accounts/${leaf}/credentials.json`;
}

/**
 * Candidate config-file paths in precedence order: the explicit path, the
 * project-local `.pi/matrix/` file, the extension-local file, then the
 * install-location and XDG fallbacks. The first existing path is the one
 * in use (shared by loadConfig and the seeder, so both agree on which
 * file they "encounter").
 */
export function resolveConfigPath(configPath?: string): string | undefined {
  const possiblePaths = [
    configPath,
    getProjectConfigPath(),
    getProjectConfigPath().replace(/\.json$/, '.jsonc'),
    getExtensionConfigPath(),
    getExtensionConfigPath().replace(/\.json$/, '.jsonc'),
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config', 'matrix-config.json'),
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config', 'matrix-config.jsonc'),
    join(homedir(), '.config', 'pi-matrix-integration', 'config.json'),
    join(homedir(), '.config', 'pi-matrix-integration', 'config.jsonc'),
  ];
  for (const p of possiblePaths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/** Config file shipped with the extension */
export function getExtensionConfigPath(): string {
  return join(getExtensionDir(), 'config', 'matrix-config.json');
}

/**
 * Directory of the config file actually in use (first existing candidate;
 * `undefined` when no config file exists anywhere — the caller falls back
 * to the global defaults). Profiles, the last-active-profile pointer, and
 * project-local state live HERE, not in the install location.
 */
export function getActiveConfigDir(): string | undefined {
  const active = resolveConfigPath();
  return active ? dirname(active) : undefined;
}

/**
 * State directory (thread-map, per-env seen/unread watermarks).
 *
 * - active config is the project-local `.pi/matrix/` file →
 *   `<project>/.pi/matrix/state` (per-project isolation: own thread map,
 *   own watermarks — the "1 project : 1 room" invariant).
 * - otherwise → the historical `<extension-dir>/state` (existing installs
 *   keep their state where it is — no silent migration).
 */
export function getStateDir(): string {
  const active = resolveConfigPath();
  // A project-local config activates per-project state under EITHER
  // extension (`.json` or `.jsonc`) — the resolver accepts both, so the
  // comparison must too (2026-10-27: a `.jsonc` config silently kept its
  // state in the global dir, and five projects sharing one global
  // seen-events file clobbered each other's ids → duplicate delivery).
  if (active && isActiveConfigProjectLocal(active)) {
    return join(dirname(active), 'state');
  }
  return join(getExtensionDir(), 'state');
}

/** Expand a leading "~" to the home directory */
function expandHome(value: string): string {
  if (value === '~') {
    return homedir();
  }
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/**
 * Identity read from the credentials file (transport-and-state.md): the account
 * store file is the single source of
 * truth for `user_id` + `homeserver`.
 *
 * - `owner`: the file's `user_id` field; falls back to the account-store
 *   leaf name `accounts/<localpart>--<domain>/credentials.json` (the naming
 *   convention the matrix-accounts tooling writes) when the field is absent.
 * - `homeserver`: the file's `homeserver`/`server` field, scheme stripped.
 *
 * Returns undefined when the path is missing/unreadable (note: the caller
 * decides — explicit config values + warn, or error).
 */
export function readCredentialsIdentity(
  credentialsPath?: string,
): { owner?: string; homeserver?: string } | undefined {
  if (!credentialsPath) return undefined;
  const p = resolve(expandHome(credentialsPath));
  let data: { user_id?: string; homeserver?: string; server?: string } | undefined;
  try {
    data = JSON.parse(readFileSync(p, 'utf-8')) as typeof data;
  } catch {
    data = undefined;
  }
  // Filename fallback: .../accounts/<localpart>--<domain>/credentials.json
  const parts = p.split(/[\\/]/).filter(Boolean);
  const leaf = parts.length >= 2 && parts[parts.length - 1] === 'credentials.json'
    ? parts[parts.length - 2]
    : undefined;
  let owner: string | undefined;
  if (typeof data?.user_id === 'string' && data.user_id.startsWith('@')) {
    owner = data.user_id;
  } else if (leaf) {
    const i = leaf.indexOf('--');
    if (i > 0) owner = `@${leaf.slice(0, i)}:${leaf.slice(i + 2)}`;
  }
  const rawHost = data?.homeserver ?? data?.server;
  const homeserver =
    typeof rawHost === 'string' && rawHost
      ? rawHost.replace(/^https?:\/\//, '').replace(/\/+$/, '')
      : undefined;
  if (!owner && !homeserver) return undefined;
  return { owner, homeserver };
}

// Environment variable mappings
const ENV_MAPPINGS: Record<string, keyof MatrixConfig> = {
  PI_MATRIX_HOMESERVER: 'homeserver',
  PI_MATRIX_USER: 'userId',
  PI_MATRIX_ROOM: 'roomId',
  PI_MATRIX_CREDENTIALS_PATH: 'credentialsPath',
  PI_MATRIX_SHOW_FOOTER: 'showInFooter',
  PI_MATRIX_PI_TERMINAL_MESSAGE_PREFIX: 'piTerminalMatrixMessagePrefix',
  PI_MATRIX_SEND_MILESTONES: 'sendMilestones',
  PI_MATRIX_SEND_FINAL_MESSAGES: 'sendFinalMessages',
  PI_MATRIX_SEND_SESSION_MILESTONES: 'sendSessionStartStopMilestones',
  PI_MATRIX_SEND_COMPACT_MILESTONES: 'sendCompactionMilestones',
  PI_MATRIX_SEND_MODEL_MILESTONES: 'sendModelChangeMilestones',
  PI_MATRIX_SEND_USER_MESSAGES: 'sendUserMessages',
  PI_MATRIX_AUTO_CONNECT: 'autoConnect',
  PI_MATRIX_DEDUPE_WINDOW_MS: 'dedupeWindowMs',
  PI_MATRIX_MAX_MESSAGE_AGE_MINUTES: 'maxMessageAgeMinutes',
  PI_MATRIX_MAX_FINAL_MESSAGE_LENGTH: 'maxFinalMessageLength',
  PI_MATRIX_SEND_FORMATTED: 'sendFormatted',
  PI_MATRIX_TABLES_IN_SEPARATE_MESSAGE: 'tablesInSeparateMessage',
  PI_MATRIX_LOG_PATH: 'logPath',
  PI_MATRIX_SLASH_RELAY: 'slashRelay',
  PI_MATRIX_MIRROR_ASK_USER: 'mirrorAskUser',
  PI_MATRIX_MIRROR_ASK_USER_POLLS: 'mirrorAskUserPolls',
  PI_MATRIX_REMOTE_FILE_PICKER: 'remoteFilePicker',
  // v2-era params: same override surface as the rest of the schema.
  PI_MATRIX_LOG_LEVEL: 'logLevel',
  PI_MATRIX_MILESTONE_ICON: 'milestoneIcon',
  PI_MATRIX_USER_MESSAGE_ICON: 'userMessageIcon',
  PI_MATRIX_SLASH_COMMAND_PREFIX: 'slashCommandPrefix',
  PI_MATRIX_FILE_PICKER_PREFIX: 'filePickerPrefix',
  PI_MATRIX_FILE_ATTACH_PREFIX: 'fileAttachPrefix',
  PI_MATRIX_FILE_SEARCH_METHOD: 'fileSearchMethod',
  PI_MATRIX_MAX_BYTES_UPLOAD: 'maxBytesUpload',
  PI_MATRIX_MATRIX_LOGIN_ENABLED: 'matrixLoginEnabled',
  PI_MATRIX_DISPLAY_STDOUT_ON_STARTUP: 'displayStdoutOnStartup',
  PI_MATRIX_VOICE_TRANSCRIPTION: 'voiceTranscription',
  PI_MATRIX_STT_BASE_URL: 'sttBaseUrl',
  PI_MATRIX_STT_MODEL: 'sttModel',
  PI_MATRIX_FILE_ATTACH: 'fileAttach',
  PI_MATRIX_ATTACH_MAX_BYTES: 'attachMaxBytes',
  PI_MATRIX_PICKER_LIMIT: 'pickerLimit',
  PI_MATRIX_THREADS: 'threads',
  PI_MATRIX_QR2025: 'qr2025',
  PI_MATRIX_THREAD_ICON: 'threadIcon',
  PI_MATRIX_FOOTER_ICON: 'footerIcon',
  PI_MATRIX_THREAD_SUMMARY_EVERY: 'threadSummaryEvery',
  PI_MATRIX_THREAD_SUMMARY_FIB: 'threadSummaryFib',
  PI_MATRIX_THREAD_SUMMARY_ON_FINAL: 'threadSummaryOnFinal',
  PI_MATRIX_THREAD_SUMMARY_BY_LLM: 'threadSummaryByLlm',
  PI_MATRIX_ROOM_TOPIC_UPDATES: 'roomTopicUpdates',
  PI_MATRIX_SUB_THREADS: 'subThreads',
  PI_MATRIX_ROLE_PREFIXES: 'rolePrefixes',
  PI_MATRIX_SUBAGENT_TOOL_NAME: 'subagentToolName',
  PI_MATRIX_THREAD_SUMMARIZE_LIMIT: 'threadSummarizeLimit',
  PI_MATRIX_THREAD_SUMMARIZE_MILESTONE_MAX: 'threadSummarizeMilestoneMax',
  PI_MATRIX_THREAD_SUMMARIZE_RECENT_MAX: 'threadSummarizeRecentMax',
  PI_MATRIX_THREAD_SUMMARIZE_MAX_LINES: 'threadSummarizeMaxLines',
  PI_MATRIX_THREAD_SUMMARIZE_MODEL: 'threadSummarizeModel',
  PI_MATRIX_THREAD_SUMMARIZE_RUN_TIMEOUT_MS: 'threadSummarizeRunTimeoutMs',
  PI_MATRIX_THREAD_SUMMARIZE_SOURCE: 'threadSummarizeSource',
  PI_MATRIX_THREAD_PENDING_ROUTE: 'threadPendingRoute',
  PI_MATRIX_ATTACH_ENCRYPTION: 'attachEncryption',
  PI_MATRIX_E2EE: 'e2ee',
  PI_MATRIX_CRYPTO_STORE_DIR: 'cryptoStoreDir',
  PI_MATRIX_STORE_PASSPHRASE: 'storePassphrase',
  PI_MATRIX_DEVICE_ID: 'deviceId',
  PI_MATRIX_SYNC_TIMEOUT_MS: 'syncTimeoutMs',
  PI_MATRIX_PROMPT_CONNECT_ON_STARTUP: 'promptConnectOnStartup',
};


/** Coerce string/env truth values; "false"/"0"/false stay false. */
function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1';
}

/**
 * Get configuration from various sources (env vars > config file > defaults)
 */
export function loadConfig(configPath?: string): MatrixConfig {
  // Load .env files first (they populate process.env)
  loadEnvFiles();
  
  // Start with defaults
  const config: PartialMatrixConfig = { ...DEFAULT_CONFIG };

  // Try to load from config file (file config overrides defaults). Shared
  // resolution order (resolveConfigPath): explicit > project .pi/matrix >
  // extension-local > install/XDG. First EXISTING path wins — the same file
  // the seeder seeds, so loadConfig and seedConfigDefaults always agree.
  let fileConfig: PartialMatrixConfig = {};

  const activeConfigPath = resolveConfigPath(configPath);
  if (activeConfigPath) {
    try {
      const fileContent = readFileSync(activeConfigPath, 'utf-8');
      // Try to parse as JSON first
      // If it fails and the file ends with .jsonc, try parsing as JSONC (with comments)
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(fileContent) as Record<string, unknown>;
      } catch (parseError) {
        if (activeConfigPath.endsWith('.jsonc')) {
          parsed = parseJsonc(fileContent);
        } else {
          throw parseError;
        }
      }
      // V2 detection: if the file has the nested v2 structure, map to flat
      if (parsed.configVersion === "2.0" && parsed.piMatrixIdentity) {
        const readKeys = new Set<string>();
        fileConfig = stripUndefined(mapV2ToFlat(recordV2Reads(parsed, readKeys))) as PartialMatrixConfig;
        warnUnreadV2Keys(parsed, readKeys);
      } else {
        fileConfig = parsed as PartialMatrixConfig;
      }
    } catch (error) {
      console.warn(`Failed to load config from ${activeConfigPath}:`, error);
    }
  }

  // Merge file config over defaults, then apply env vars so they override
  // both (documented precedence: env vars > config file > defaults).
  const merged: PartialMatrixConfig = { ...config, ...fileConfig };
  // The nested `subagents` block shallow-merges over its defaults (a partial
  // block in the file must not drop the keys it omits).
  if (merged.subagents !== undefined) {
    merged.subagents = { ...config.subagents, ...merged.subagents };
  }

  // Coercion table = the type DEFAULT_CONFIG declares for the key. A
  // hand-maintained list of numeric / boolean keys is how drift starts: a new
  // number param reaches the loader as the string "5000" until somebody
  // remembers to add it, and nothing fails loudly. The keys with no default
  // (userId, homeserver, cryptoStoreDir, storePassphrase, deviceId,
  // threadSummarizeModel) are strings — the fallback branch.
  const coerce = (key: string, value: unknown): unknown => {
    const wanted = typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (wanted === 'number') return Number(value);
    if (wanted === 'boolean') return parseBool(value);
    return value;
  };

  // Indexed as a loose record on purpose: the keys come from ENV_MAPPINGS and
  // DEFAULT_CONFIG at runtime, which no single key-of type describes.
  const slot = merged as Record<string, unknown>;

  for (const [envVar, configKey] of Object.entries(ENV_MAPPINGS)) {
    const envValue = process.env[envVar];
    if (envValue === undefined) continue;
    slot[configKey] = coerce(configKey, envValue);
  }

  // Nested-key env alias: ENV_MAPPINGS only
  // covers the flat keys, so `subagents.provider` gets its own line; the
  // value lands untyped and validateConfig rejects a bad id.
  const providerEnv = process.env.PI_MATRIX_SUBAGENT_PROVIDER;
  if (providerEnv !== undefined) {
    slot.subagents = { ...((slot.subagents ?? {}) as Record<string, unknown>), provider: providerEnv };
  }

  // File values get the same coercion, so a config that carries "30000" for
  // syncTimeoutMs behaves like one that carries 30000.
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (slot[key] !== undefined) slot[key] = coerce(key, slot[key]);
  }

  // Expand "~" in path-like values (config files use "~/.config/mtx")
  if (typeof merged.credentialsPath === 'string') {
    merged.credentialsPath = expandHome(merged.credentialsPath);
  }
  if (typeof merged.logPath === 'string') {
    merged.logPath = expandHome(merged.logPath);
  }

  // Project-local log file: when the ACTIVE config is the project-local
  // .pi/matrix one and neither the file nor PI_MATRIX_LOG_PATH pinned
  // logPath, the log co-locates with the project's state —
  // <project>/.pi/matrix/state/pi-matrix.log — instead of the default
  // .pi/matrix/logs path shared by every project.
  const activeIsProject = isActiveConfigProjectLocal(resolveConfigPath(configPath));
  if (activeIsProject && !('logPath' in fileConfig) && process.env.PI_MATRIX_LOG_PATH === undefined) {
    merged.logPath = join(getStateDir(), 'pi-matrix.log');
  }

  // Identity derivation (transport-and-state.md):
  // with userId/homeserver stripped from DEFAULT_CONFIG, "absent" is a
  // real state — derive from the credentials file (account store SSoT).
  // Explicit config/env values are kept and enforced against the owner by
  // validateConfig; only the fallback order inverts (credentials → explicit
  // → error, never a default).
  const identity = readCredentialsIdentity(merged.credentialsPath);
  if (!merged.userId && identity?.owner) {
    merged.userId = identity.owner;
  }
  if (!merged.homeserver && identity?.homeserver) {
    merged.homeserver = identity.homeserver;
  }

  return merged as MatrixConfig;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: MatrixConfig | ConfigV2, configPath?: string): void {
  const path = configPath ||
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config', 'matrix-config.json');

  // Ensure directory exists
  mkdirSync(dirname(path), { recursive: true });

  // v2 configs are written with the .jsonc extension (the name advertises the
  // schema and the loader parses comments on read). NB: the write below is
  // plain JSON.stringify, so it drops any comments the user added — see
  // docs/designs/configuration-and-room-behaviour.md Keeping annotations in the
  // live file is therefore not supported; docs carry the annotated reference.
  const isV2 = (config as { configVersion?: string }).configVersion === "2.0";
  const finalPath = isV2 ? path.replace(/\.json$/, '.jsonc') : path;

  writeFileSync(finalPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Validate configuration
 *
 * The identity invariant —
 * the credentials file's owner must equal `userId` (or `userId` is derived
 * from it by loadConfig). A mismatch is an error, not a warning: this is
 * the invariant that kills the two-sender echo-bug class.
 */
export function validateConfig(config: MatrixConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Unknown-key guard: warn (not fail) on keys the schema doesn't know —
  // catches typos in the JSON config file at load time. userId/homeserver
  // are identity keys stripped from DEFAULT_CONFIG  but still schema
  // keys, so the guard covers them too. `environment` is deprecated
  // (removed 2026-10-13 — the homeserver domain replaced it): still
  // accepted, ignored, so pre-existing config files load clean.
  const schemaKeys = new Set([...Object.keys(DEFAULT_CONFIG), 'userId', 'homeserver', 'environment']);
  const unknownKeys = Object.keys(config).filter((key) => !schemaKeys.has(key));
  if (unknownKeys.length > 0) {
    console.warn(`[matrix] config: ignoring unknown key(s): ${unknownKeys.join(', ')}`);
  }

  // Identity invariant (transport-and-state.md): one account, two plumbings — never
  // two accounts, two plumbings. Read the credentials file's owner.
  const identity = readCredentialsIdentity(config.credentialsPath);
  if (config.userId && identity?.owner && identity.owner !== config.userId) {
    errors.push(
      `identity invariant violated: credentials owner is ${identity.owner} but userId is ${config.userId} — ` +
        'reconcile to one account (drop the mismatched userId so it derives from the credentials file, or point credentialsPath at the matching account)',
    );
  }

  if (!config.homeserver) {
    // Derivable from the credentials file in loadConfig; no default
    // fallback anymore.
    errors.push('homeserver is required (set in config/env or the credentials file)');
  }

  if (!config.userId) {
    // loadConfig derives userId from the credentials owner when absent;
    // reaching this means neither the file nor config/env had it.
    errors.push(
      identity?.owner
        ? `userId is required: it should have been derived from the credentials owner (${identity.owner})`
        : 'userId is required (provision the account store / credentials file, or set userId explicitly — explicit values + missing file are allowed with a warning)',
    );
  } else if (!config.userId.startsWith('@')) {
    errors.push('userId must start with @');
  } else if (!identity) {
    // Decision: missing file + explicit values → warn, allow.
    console.warn(
      '[matrix] config: credentials file missing or unreadable — identity invariant unverifiable (explicit userId allowed)',
    );
  }

  if (!config.roomId) {
    errors.push('roomId is required');
  } else if (!config.roomId.startsWith('!') && !config.roomId.startsWith('#')) {
    errors.push('roomId must start with ! or #');
  }

  if (!config.credentialsPath) {
    errors.push('credentialsPath is required');
  }



  for (const key of ['attachEncryption', 'e2ee'] as const) {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== 'on' && value !== 'off') {
      errors.push(`${key} must be "on" or "off" (got ${JSON.stringify(value)})`);
    }
  }

  // Sub-agent reporting block.
  const sa = config.subagents;
  if (sa !== undefined) {
    if (sa.postMode !== undefined && sa.postMode !== 'turn-end' && sa.postMode !== 'all') {
      errors.push(`subagents.postMode must be "turn-end" or "all" (got ${JSON.stringify(sa.postMode)})`);
    }
    // Provider dialect binding — an env
    // alias arrives untyped, so this is its only gate.
    if (
      sa.provider !== undefined &&
      sa.provider !== 'auto' &&
      sa.provider !== 'tintinweb' &&
      sa.provider !== 'nicobailon'
    ) {
      errors.push(
        `subagents.provider must be "auto", "tintinweb" or "nicobailon" (got ${JSON.stringify(sa.provider)})`,
      );
    }
    const hex = /^#[0-9A-Fa-f]{6}$/;
    for (const [type, color] of Object.entries(sa.colorByType ?? {})) {
      if (!hex.test(color)) {
        errors.push(`subagents.colorByType["${type}"] must be #RRGGBB (got ${JSON.stringify(color)})`);
      }
    }
    for (const color of sa.colorPalette ?? []) {
      if (!hex.test(color)) {
        errors.push(`subagents.colorPalette entry must be #RRGGBB (got ${JSON.stringify(color)})`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get configuration with validation
 */
export function getValidConfig(configPath?: string): { config: MatrixConfig; valid: boolean; errors: string[] } {
  const config = loadConfig(configPath);
  const validation = validateConfig(config);
  return { config, ...validation };
}

/**
 * Create the default configuration file when missing.
 * Never overwrites an existing file — returns the path when created,
 * null when a config file already exists.
 */
export function createDefaultConfig(path?: string): string | null {
  const configPath = path ||
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config', 'matrix-config.json');

  if (existsSync(configPath)) {
    return null;
  }

  saveConfig(DEFAULT_CONFIG, configPath);
  return configPath;
}

/**
 * Get configuration directory path
 */
export function getConfigDir(): string {
  return join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config');
}

/**
 * Seed a config file in place with the default values of known parameters it
 * is missing (self-healing encountered files): every top-level key of
 * DEFAULT_CONFIG that is absent from the file gets its default written back,
 * existing values are preserved, and keys whose default is `undefined`
 * (optional, no meaningful default — e.g. `threadSummarizeModel`) stay
 * absent. No-op when nothing is missing; an unreadable / non-object file is
 * left untouched. Returns the seeded key names (empty when nothing changed).
 */
export function seedConfigFile(path: string, seedDefaults?: Record<string, unknown>): string[] {
  let fileConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[matrix] config: ${path} is not a JSON object — not seeding`);
      return [];
    }
    fileConfig = parsed as Record<string, unknown>;
  } catch (error) {
    console.warn(`[matrix] config: could not seed ${path} (unreadable or invalid JSON): ${error}`);
    return [];
  }
  const defaults = { ...(DEFAULT_CONFIG as unknown as Record<string, unknown>), ...seedDefaults };
  const missing = Object.keys(defaults).filter(
    (key) => defaults[key] !== undefined && !(key in fileConfig),
  );
  if (missing.length === 0) return [];
  for (const key of missing) fileConfig[key] = defaults[key];
  // Atomic write (tmp + rename): a crash mid-write must never leave a
  // truncated / corrupt config file in place (handoff: "write back atomically").
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the partial tmp file; the real error is below
    }
    console.warn(`[matrix] config: seeding ${path} failed (write error): ${error}`);
    return [];
  }
  console.warn(
    `[matrix] config: seeded ${missing.length} missing key(s) with defaults into ${path}: ${missing.join(", ")}`,
  );
  return missing;
}

/**
 * Seed the config file the extension encounters (the first existing
 * candidate path) with defaults for missing parameters. Called at extension
 * load — idempotent: once seeded, later encounters are no-ops. A
 * project-local file seeds `logPath` with the project-local log (its log
 * co-locates with its state); an explicit seedDefaults wins over both.
 */
export function seedConfigDefaults(configPath?: string, seedDefaults?: Record<string, unknown>): string[] {
  const path = resolveConfigPath(configPath);
  if (!path) return [];
  const overrides = { ...seedDefaults };
  if (!configPath && isActiveConfigProjectLocal(path) && overrides.logPath === undefined) {
    overrides.logPath = join(getStateDir(), "pi-matrix.log");
  }
  return seedConfigFile(path, overrides);
}

/**
 * Get credentials path from config or default
 */
export function getCredentialsPath(config: MatrixConfig): string {
  return resolve(config.credentialsPath);
}

// ============================================================================
// Profile loading (/matrix-switch, threads-and-summaries.md)
// ============================================================================

/**
 * List available profile names: `config/matrix-config.<name>.json` files
 * (the bare `matrix-config.json` is the live config, not a profile).
 */
export function listProfiles(): string[] {
  const dir = getActiveConfigDir() ?? getConfigDir();
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => /^matrix-config\..+\.(json|jsonc)$/.test(f))
    .map((f) => f.replace(/^matrix-config\.(.+?)\.(json|jsonc)$/, '$1'))
    .sort();
}

/**
 * Load + validate a profile by name (`config/matrix-config.<name>.json`),
 * the same validation path as `getValidConfig`. Unknown profile → clear
 * error listing the available profiles; the caller keeps the current
 * connection untouched.
 */
export function loadProfile(
  name: string,
): { config: MatrixConfig; valid: boolean; errors: string[] } {
  if (name.includes("/") || name.includes("..")) {
    return {
      config: loadConfig(),
      valid: false,
      errors: [`invalid profile name "${name}" — available: ${listProfiles().join(", ") || "(none)"}`],
    };
  }
  const dir = getActiveConfigDir() ?? getConfigDir();
  const jsonPath = join(dir, `matrix-config.${name}.json`);
  const jsoncPath = join(dir, `matrix-config.${name}.jsonc`);
  const fileConfigPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  if (!existsSync(fileConfigPath)) {
    return {
      config: loadConfig(),
      valid: false,
      errors: [`profile file missing (${fileConfigPath}) — available: ${listProfiles().join(", ") || "(none)"}`],
    };
  }
  return getValidConfig(fileConfigPath);
}

// ============================================================================
// Last-active profile persistence (/matrix-switch survives a pi restart)
// ============================================================================

/** Active-profile pointer: lives in the active config dir (project-local `.pi/matrix/` when that config is active — the pointer is per-project, so a project restart restores ITS last room). */
export function getActiveProfilePath(): string {
  return join(getActiveConfigDir() ?? getConfigDir(), "last-active-profile");
}

/** Persist the last-active profile name (called on every successful /matrix-switch). */
export function persistActiveProfile(name: string): void {
  try {
    writeFileSync(getActiveProfilePath(), `${name}\n`, "utf-8");
  } catch (error) {
    console.warn(`[matrix] config: persisting active profile failed: ${error}`);
  }
}

/** The persisted active profile name, or undefined when unset/unreadable. */
export function getActiveProfileName(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(getActiveProfilePath(), "utf-8");
  } catch {
    return undefined;
  }
  const name = raw.trim();
  return name || undefined;
}

/**
 * The startup config: when the last-active profile pointer is set and its
 * profile still loads valid, use it; otherwise fall back to the live config
 * (a stale pointer never breaks startup). `profile` carries the name that
 * won, so the caller can announce the restore.
 */
export function resolveStartupConfig(): {
  config: MatrixConfig;
  valid: boolean;
  errors: string[];
  profile: string | undefined;
} {
  const name = getActiveProfileName();
  if (name) {
    const res = loadProfile(name);
    if (res.valid) {
      return { ...res, profile: name };
    }
    console.warn(
      `[matrix] config: active profile "${name}" not loadable (${res.errors.join("; ")}) — falling back to the live config`,
    );
  }
  return { ...getValidConfig(), profile: undefined };
}
