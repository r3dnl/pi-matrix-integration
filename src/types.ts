/**
 * Pi Matrix Integration - Type Definitions
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface MatrixConfig {
  // transport-and-state.md: MSC4125 sender-side attachment
  // encryption (the VectorIM Element Web fix). "on" encrypts every m.file
  // upload (AES-256-CTR v2; non-MSC4125 clients see ciphertext — the
  // documented trade-off). Default "on".
  attachEncryption?: "on" | "off";
  // transport-and-state.md: E2EE via the bundled Rust crypto WASM + the file-backed
  // crypto store. Default "on" — the homeserver's new-room default is
  // encrypted (encryption_enabled_by_default_for_room_type: all).
  e2ee?: "on" | "off";
  // transport-and-state.md: the on-disk crypto-store root (device + room keys).
  // Default: `<dirname(credentialsPath)>/store` (the account dir that
  // holds credentials.json — per-account separation).
  cryptoStoreDir?: string;
  // At-rest encryption for the crypto store (the WASM's `storagePassword`):
  // when set, the store's key material is unreadable without this passphrase.
  storePassphrase?: string;
  // transport-and-state.md: the stable device id (the bot's E2EE identity across
  // restarts). Default "PI_AGENT_1" — the MAS device-scope policy needs at
  // least 10 characters, which rules out "PI_AGENT".
  deviceId?: string;
  // transport-and-state.md: the SDK sync long-poll cap (ms). Default 60000.
  syncTimeoutMs?: number;
  // Identity (transport-and-state.md): the account store's
  // credentials file is the single source of truth for user_id + homeserver.
  // Both are optional here — absent means "derive from the credentials
  // file" (loadConfig), and a present-but-mismatched `userId` is a
  // validation error (the identity invariant), not a silent drift. The
  // extension stack is only built when validation set them.
  homeserver?: string;
  userId?: string;
  roomId: string;
  credentialsPath: string;
  showInFooter: boolean;
  piTerminalMatrixMessagePrefix?: string;
  // Push a short "Pi did X" line to the room on session_start (reason
  // startup / reload / new / resume / fork). Gated by this key.
  // Default true.
  sendSessionStartStopMilestones?: boolean;
  // Push a short line to the room on context compaction: session_compact
  // (/compact, auto-compact on threshold or overflow) and
  // session_compact_failed. Gated by this key. Default true.
  sendCompactionMilestones?: boolean;
  // Push a short line to the room when the active model or thinking level
  // changes via /model, Ctrl+P cycling, or session restore (model_select
  // and thinking_level_select events). Gated by this key. Default true.
  sendModelChangeMilestones?: boolean;
  // Broadcast the user's own terminal-typed prompt to the room as a
  // "🧑 User: …" line, so a phone-only user sees what they (or a
  // colleague at the terminal) asked. Only fires for genuine terminal-typed
  // input (the `input` event with source === "interactive") — NEVER for
  // Matrix-relayed messages (which arrive as source "extension" or via
  // custom-message injection that doesn't fire `input` at all). Default true.
  sendUserMessages?: boolean;
  // Opt-in: at every turn_end, broadcast the turn's final assistant message
  // (the last thing the user saw in the terminal) to the Matrix room.
  sendFinalMessages?: boolean;
  // Gate for the heuristic auto-broadcasts (milestone-marker scan at
  // message_end, TODO-marker scan at turn_end). The `matrix_send_milestone`
  // tool is NOT gated — it is an explicit, model-chosen action. Default true.
  sendMilestones?: boolean;
  // Connect (and start polling) at session start. Default true.
  autoConnect?: boolean;
  // Content-level dedupe window for outgoing sends (ms). Default 600000 (10 min).
  dedupeWindowMs?: number;
  /** Inbound staleness guard (minutes): a room message older than this is
   *  dropped instead of injected, warn-logged and reported once to the room.
   *  Guards against the initial-sync / limited-timeline backfill, which
   *  matrix-js-sdk flags live. Default 30; 0 or negative disables it. */
  maxMessageAgeMinutes?: number;
  // Final-message broadcast cutoff (chars); longer answers are truncated.
  // Default 2000.
  maxFinalMessageLength?: number;
  // Convert outgoing markdown to HTML and send it as `formatted_body`
  // (`format: org.matrix.custom.html`).
  // The room client decides how a formatted body renders, so this stays off
  // until rendering is verified in the client you use.
  // Default false.
  sendFormatted?: boolean;
  // When sendFormatted is on: split markdown table blocks into their own
  // send instead of inlining them in the same message. Default false.
  tablesInSeparateMessage?: boolean;
  // Error log file owned by the extension (recurring errors land here
  // instead of the TUI console). Default `.pi/matrix/logs/pi-matrix.log`,
  // relative to the working directory; a leading `~/` is expanded.
  logPath?: string;
  // Relay room-typed `/command` messages into Pi as composer input.
  // Unknown names get a plain-text fuzzy-suggestion reply. Default true.
  slashRelay?: boolean;
  // Dual-surface RPIV decisions: mirror `ask_user_question` questionnaires
  // into the room; a phone reply proceeds the decision (terminal stays
  // usable, first surface to complete wins). Default true.
  mirrorAskUser?: boolean;
  // Native Matrix polls for RPIV decision questions:
  // each single-select question also posts as a tappable m.poll. No-op
  // when mirrorAskUser is false. Default true.
  mirrorAskUserPolls?: boolean;
  // `@` remote file picker (triggered from Matrix). Default false.
  remoteFilePicker?: boolean;
  // `@@` file attachment to outbound Matrix messages.
  fileAttach?: boolean;
  // How the `@@` artifact picker ranks: "builtin" (substring + length) or
  // "fzf" (headless fzf relevance, falls back to builtin when absent).
  fileSearchMethod?: "builtin" | "fzf";
  // Cap for inlined @-attached file content (bytes). Default 200000.
  attachMaxBytes?: number;
  // Candidate list length for both pickers; the list shows at most this many
  // matches and says how many it hid. Default 10.
  pickerLimit?: number;
  // Threading (threads-and-summaries.md). Master gate for
  // session→thread mapping, lazy thread-root creation, and routing all
  // outgoing traffic into the active thread. Needs the sdk transport, which is
  // the only transport. Default false.
  threads?: boolean;
  // Root + sub-thread marker glyph. Default "🧵".
  threadIcon?: string;
  // TUI footer connected-state glyph. Default "💬" (a host without a
  // color-emoji font can set a safe character, e.g. "M").
  footerIcon?: string;
  // In-thread messages per root-edit summary cadence; 0 disables. Default 10.
  threadSummaryEvery?: number;
  // Fibonacci-capped cadence (default true): trigger interval starts
  // 1,1,2,3,5,8… capping at threadSummaryEvery (whichever is lower).
  // false restores the fixed modulo cadence.
  threadSummaryFib?: boolean;
  // Report-out trigger (default true): a "final" post (the turn's
  // report-out, the sendFinalMessages turn_end broadcast) runs a summary
  // pass right after it lands.
  threadSummaryOnFinal?: boolean;
  // Expose the `matrix_update_thread_summary` tool so the agent can refine
  // the root text on demand. Default false.
  threadSummaryByLlm?: boolean;
  // Update the room topic with a short status line at summary/shutdown.
  // Default false (needs PL ≥ 50 or a privileged user — see T5).
  roomTopicUpdates?: boolean;
  // Sub-agent sub-threads + role prefixes (threads-and-summaries.md). Flips on after
  // review round 4 verdict ≥ heuristic. Default false.
  subThreads?: boolean;
  // `🤖 sub-agent-{role}:` prefixes on sub-agent marker traffic.
  // Default true (when subThreads is on).
  rolePrefixes?: boolean;
  // The sub-agent spawn tool name (review round 4: the shipped `subagent`
  // extension registers a tool named `subagent`). Default "subagent".
  subagentToolName?: string;
  // Side-chain (core `Agent` tool) sub-agent tracking (configuration-and-room-behaviour.md
  // configuration-and-room-behaviour.md): detection + routing are ALWAYS on (side-chain sessions never open
  // their own thread root); `enabled` gates the REPORTING (spawn messages,
  // traffic, nested milestone lines). Default true.
  subagents?: SubagentsConfig;
  // Thread-summary prompt delta: max number of the thread's messages kept in
  // the summarizer prompt (most recent; threads-and-summaries.md). Default 40.
  threadSummarizeLimit?: number;
  threadSummarizeRunTimeoutMs?: number;
  // Fir-tree summary caps: max lines in
  // `## Milestones` (default 8), max bullets in `## Recent activity`
  // (default 5), hard total-line cap on the posted body (default 25).
  threadSummarizeMilestoneMax?: number;
  threadSummarizeRecentMax?: number;
  threadSummarizeMaxLines?: number;
  // Model pin ("provider/modelId") for the thread-summary subagent run; a
  // small model keeps the cadence runs cheap. Omit to inherit the session's
  // model. Default undefined.
  threadSummarizeModel?: string;
  // Where the summarizer's delta comes from. "room" (default) = the thread's
  // own Matrix messages; "session" = the Pi session's own context (legacy
  // in-session re-prompt, threads-and-summaries.md). "session" runs the
  // pass in the main session; "room" uses the subagent (in-session fallback).
  threadSummarizeSource?: "room" | "session";
  // Where non-user sends from a pending session (no thread root yet) go:
  // "flat" (default) = the main conversation (today's configuration-and-room-behaviour.md behavior);
  // "latest" = soft-attach them to the most recent thread root (the
  // session stays pending; the first user message still opens a new root).
  threadPendingRoute?: "flat" | "latest";
  // First-run project connection prompt: ask to connect to Matrix room on
  // first Pi start in a new project folder. Default true.
  promptConnectOnStartup?: boolean;
  
  // v2 schema additions (for backward compatibility with v2 configs)
  // Logging level for extension errors and debug messages
  logLevel?: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
  // Icon for milestone messages
  milestoneIcon?: string;
  // Icon for user messages sent to Matrix
  userMessageIcon?: string;
  // Prefix for the remote file picker (triggered from Matrix)
  filePickerPrefix?: string;
  // Prefix for the relayed slash command (default "/")
  slashCommandPrefix?: string;
  // Whether the /matrix-login command is available. Default true.
  matrixLoginEnabled?: boolean;
  // Whether the startup banner is echoed to stdout. Default false.
  displayStdoutOnStartup?: boolean;
  // Offer the 2025 QR sign-in method (MSC4108/MSC4388) in /matrix-login.
  // Off by default; the probe re-checks the server + crypto at login time.
  qr2025?: boolean;
  // Inbound voice/audio messages are downloaded, decoded and transcribed
  // locally, then injected as the sender's text. On by default.
  voiceTranscription?: boolean;
  // Prefix for file attachment to outbound Matrix messages
  fileAttachPrefix?: string;
  // Maximum bytes for file uploads to Matrix
  maxBytesUpload?: number;
}

// Side-chain sub-agent reporting. Detection and
// routing are always on; these keys gate the REPORTING only.
export interface SubagentsConfig {
  /** Master switch: off → sub-agents are silent in Matrix. Default true. */
  enabled?: boolean;
  /** post the spawn line at all. Default true. */
  spawnMessages?: boolean;
  /** the settle result is summarized INTO the spawn line: the spawn
   *  line is an anchor edited in place at settle; false → plain spawn +
   *  settle lines. Default true. */
  summarizeResultIntoSpawnLine?: boolean;
  /** `turn-end` (default): only the turn's final assistant message;
   *  `all`: every assistant message. */
  postMode?: "turn-end" | "all";
  /** User-pinned type → #RRGGBB (wins over the palette hash). */
  colorByType?: Record<string, string>;
  /** Palette the type hash picks from. Default: 8 distinct hues. */
  colorPalette?: string[];
  /** Plain-mode actor marker. Default "⚡". */
  plainMarker?: string;
  /** Sub-agent provider dialect: `auto`
   *  binds today's tintinweb dialect until the async probe lands; an
   *  explicit dialect that never answers logs one warning per session.
   *  Env alias `PI_MATRIX_SUBAGENT_PROVIDER`. Default "auto". */
  provider?: "auto" | "tintinweb" | "nicobailon";
}

export interface PartialMatrixConfig {
  homeserver?: string;
  userId?: string;
  roomId?: string;
  credentialsPath?: string;
  showInFooter?: boolean;
  piTerminalMatrixMessagePrefix?: string;
  subagents?: SubagentsConfig;
  sendSessionStartStopMilestones?: boolean;
  sendCompactionMilestones?: boolean;
  sendModelChangeMilestones?: boolean;
  sendUserMessages?: boolean;
  sendFinalMessages?: boolean;
  sendMilestones?: boolean;
  autoConnect?: boolean;
  dedupeWindowMs?: number;
  maxMessageAgeMinutes?: number;
  maxFinalMessageLength?: number;
  sendFormatted?: boolean;
  tablesInSeparateMessage?: boolean;
  logPath?: string;
  slashRelay?: boolean;
  mirrorAskUser?: boolean;
  mirrorAskUserPolls?: boolean;
  // `@` remote file picker (triggered from Matrix).
  remoteFilePicker?: boolean;
  fileAttach?: boolean;
  // How the `@@` artifact picker ranks: "builtin" or "fzf".
  fileSearchMethod?: "builtin" | "fzf";
  attachMaxBytes?: number;
  pickerLimit?: number;
  threads?: boolean;
  // QR login (2025 variant, MSC4108/MSC4388) method offer in the login
  // dialogue (configuration-and-room-behaviour.md). Off by default; gated at probe time as well.
  qr2025?: boolean;
  threadIcon?: string;
  footerIcon?: string;
  threadSummaryEvery?: number;
  threadSummaryFib?: boolean;
  threadSummaryOnFinal?: boolean;
  threadSummaryByLlm?: boolean;
  roomTopicUpdates?: boolean;
  subThreads?: boolean;
  rolePrefixes?: boolean;
  subagentToolName?: string;
  threadSummarizeLimit?: number;
  threadSummarizeRunTimeoutMs?: number;
  threadSummarizeMilestoneMax?: number;
  threadSummarizeRecentMax?: number;
  threadSummarizeMaxLines?: number;
  threadSummarizeModel?: string;
  threadSummarizeSource?: "room" | "session";
  threadPendingRoute?: "flat" | "latest";
  attachEncryption?: "on" | "off";
  /** Voice-message transcription: an `m.audio`/`m.voice`
   *  room message is downloaded, decoded (ffmpeg), transcribed (local
   *  Whisper via the rpiv-voice engine — the dictate-local chain) and
   *  injected as the sender's text message. Default "on". */
  voiceTranscription?: boolean;
  e2ee?: "on" | "off";
  cryptoStoreDir?: string;
  storePassphrase?: string;
  deviceId?: string;
  syncTimeoutMs?: number;
  promptConnectOnStartup?: boolean;
  
  // v2 schema additions
  logLevel?: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
  milestoneIcon?: string;
  userMessageIcon?: string;
  fileAttachPrefix?: string;
  // Prefix for the remote file picker (triggered from Matrix)
  filePickerPrefix?: string;
  // Prefix for the relayed slash command (default "/")
  slashCommandPrefix?: string;
  matrixLoginEnabled?: boolean;
  displayStdoutOnStartup?: boolean;
  maxBytesUpload?: number;
}

// ============================================================================
// Project Room Manifest Types 
// ============================================================================

/**
 * Project room manifest schema for Pi agent projects.
 * Follows the matrix-accounts-py manifest pattern but simplified for project setup.
 */
export interface ProjectRoomManifest {
  /** API version identifier */
  apiVersion: string;
  /** Manifest kind */
  kind: string;
  /** Project name */
  project: string;
  /** Matrix homeserver domain */
  homeserver: string;
  /** Room alias for this project */
  roomAlias: string;
  /** Room ID (internal Matrix ID) */
  roomId: string;
  /** User ID of the Pi agent */
  userId: string;
  /** Device ID of the Pi agent */
  deviceId: string;
  /** List of invited user IDs */
  invitedUsers?: string[];
  /** Timestamp when the room was created */
  createdAt: string;
  /** Configuration used for this room */
  config: {
    e2ee: boolean;
    threads: boolean;
    autoConnect: boolean;
  };
}

// ============================================================================
// Matrix Message Types
// ============================================================================

export interface MatrixMessage {
  eventId: string;
  sender: string;
  body: string;
  timestamp: number;
  formattedBody?: string;
  roomId: string;
  isFromPi: boolean;
  /** The event's msgtype (`m.text`, `m.audio`, `m.voice`, …). Set when the
   *  event carries one. */
  msgtype?: string;
  /** Media URL for `m.audio`/`m.voice`/… — `content.file.url` (MSC4125)
   *  wins over `content.url`. */
  mediaUrl?: string;
  /** Media metadata (`mimetype`, `size`, `duration` ms). */
  mediaInfo?: Record<string, unknown>;
  /** MSC4125 encrypted-attachment object (carries its own `key`/`iv`). */
  mediaFile?: Record<string, unknown>;
  // Thread metadata: set when the event carries
  // a spec `m.relates_to` thread relation / legacy MSC1767
  // `content["org.matrix.msc1767.thread_root"]` (a reply in a thread) or
  // `content["m.thread"]` (itself a thread root). Bookkeeping only — thread
  // messages are ordinary room-timeline events the poll loop already receives.
  threadRoot?: string;
  isThreadRoot?: boolean;
  /** `m.reaction` events: the annotation key (emoji or text). Set only for
   *  reaction events — `onReaction` handlers, not `onMessage`. */
  reactionKey?: string;
  /** The event id the reaction annotates (`m.relates_to.event_id`). */
  parentEventId?: string;
}

export interface MatrixEvent {
  type: string;
  event_id: string;
  origin_server_ts?: number;
  sender: string;
  room_id?: string;
  content?: {
    body?: string;
    formatted_body?: string;
    msgtype?: string;
    /** Media URL (`mxc://…`) — `m.audio`/`m.voice`/`m.image`/`m.video`. */
    url?: string;
    /** Media metadata (`mimetype`, `size` bytes, `duration` ms). */
    info?: Record<string, unknown>;
    /** MSC4125 encrypted-attachment object (`key`/`iv`/`hashes`/`v` +
     *  its own `url`) — present when the client encrypted the media
     *  with an in-event key instead of SSS. */
    file?: { url?: string; [k: string]: unknown };
    /** MSC1767 voice metadata (`duration`, `waveform`) — cosmetic only. */
    ["org.matrix.msc1767.audio"]?: { duration?: number; waveform?: number[] };
    /** Thread-root marker (summary). */
    ["m.thread"]?: unknown;
    /** Edit placeholder (m.replace): the replacement content. Presence
     *  marks the event as an EDIT, not a message (parseMatrixEvent drops
     *  it — see thread-meta.ts). */
    ["m.new_content"]?: unknown;
    /** Thread reply (spec): the thread root event id (threads-and-summaries.md T9). */
    /** Reaction annotation (m.reaction): `m.relates_to` = `m.annotation`,
     *  the emoji/text is `key`, the target is `event_id`. */
    ["m.relates_to"]?: { rel_type?: string; event_id?: string; key?: string };
    /** Legacy MSC1767 draft: reply-in-thread; the thread root event id. */
    ["org.matrix.msc1767.thread_root"]?: string;
  };
}

export interface MatrixSendResult {
  eventId: string;
  success: boolean;
  // True when the send was skipped because identical content went out
  // within the dedupe window (no request was sent).
  deduped?: boolean;
  error?: string;
  timestamp: number;
}

// ============================================================================
// Connection Types
// ============================================================================

export type ConnectionStatus = {
  connected: boolean;
  connecting: boolean;
  lastError?: string;
  lastActivity?: number;
  lastErrorTime?: number;
  /** The configured room id or alias (`!abc:domain` / `#alias:domain`) — not
   *  a matrix.to link. */
  roomId: string;
  userId: string;
};

// ============================================================================
// Pi Message Types
// ============================================================================

/** The kinds this package produces. `response` is an incoming room chat
 *  message; the `user` kind is pi's OUTGOING user broadcast (`getMessagePrefix`
 *  renders it "🧑 User: "). */
export type PiMessageType = 'milestone' | 'response' | 'final' | 'user';

export interface PiMessage {
  type: PiMessageType;
  content: string;
  /** Caller-attached bag. `flat` is routing (skip thread routing); every
   *  other key renders into the room body as a Details block. */
  metadata?: Record<string, unknown>;
  timestamp: number;
  entryId?: string;
}

// ============================================================================
// Session Integration Types
// ============================================================================

/** `details` payload attached to injected `matrix-message` custom messages. */
export interface MatrixMessageDetails {
  sender: string;
  senderName?: string;
  eventId?: string;
  timestamp?: number;
  roomId?: string;
  // Thread metadata carried through for bookkeeping (threads-and-summaries.md — no routing
  // effect: one Pi session per instance).
  threadRoot?: string;
}



