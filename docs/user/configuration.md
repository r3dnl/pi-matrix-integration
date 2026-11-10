# Configuration reference

The extension reads one JSON/JSONC file plus environment variables. This page
lists every key the code reads, its default, and the environment variable that
overrides it. Environment values are typed from the default, so booleans
accept `true`/`1` and numbers must parse as numbers.

**An example config file with comments explaining the options can be found [here](matrix-config.example.jsonc)**

## Precedence

1. Environment variables (highest).
2. The config file.
3. Built-in defaults (lowest).

The extension uses the **first config file that exists**:

1. An explicit path given by the API.
2. Project-local: `<project>/.pi/matrix/matrix-config.json` (or `.jsonc`).
   Pi runs with the project as cwd, so each project can carry its own room,
   credentials, and state under `<project>/.pi/matrix/`.
3. Extension-local: `<extension-dir>/config/matrix-config.json` (or `.jsonc`).
4. Install location: `~/.pi/agent/extensions/pi-matrix-integration/config/`.
5. XDG: `~/.config/pi-matrix-integration/config.json` (or `.jsonc`).

Tiers 3 and 4 are the same directory in a development install, where the
extension is a symlink under `~/.pi/agent/extensions/` and its `config/`
folder is the source tree. They are not a usable place for user config in an
npm install: Pi caches such packages under `~/.pi/agent/tmp/extensions/` and
reinstalls them whenever the registry has a newer matching version, so a file
written inside the package does not survive an update. Pi defines no
user-level config directory for extensions — its only documented persistence
surface is the session transcript (`pi.appendEntry()`), which is per session,
not per machine. Use tier 2 for one project and tier 5 to cover a machine.

### Profiles & Precedence
A json(c) can be saved as `matrix-config.{pi_agent_user}--{matrix_domain}.json(c)`,
and this can be loaded with `/matrix-switch` in the terminal.

One trap wrt precendence: a profile-suffixed file (for example
`matrix-config.pi_agent--example.com.jsonc`) is **not** in above list. The bare
`matrix-config.json` is the live config; a profile file is only read when you
activate that profile with `/matrix-switch` or `/matrix-connect <profile>`.
Keys written into a profile file have no effect until the profile is active.

## File format

The config file is versioned. A v2 file looks like this (excerpt):

```jsonc
{
  "configVersion": "2.0",
  "piMatrixIdentity": { "homeserver": "matrix.example.com" },
  "piMatrixThreading": { "summaryCadence": 10 }
}
```

A v1 flat file is migrated on read; the keys below name both the v2 section
key and the flat key. The `subagents` block merges shallowly: a partial block
cannot drop omitted keys. Config writes are atomic (temporary file plus
rename). The complete file, every key commented with its enum values and
default: [matrix-config.example.jsonc](matrix-config.example.jsonc).

## Identity and connection

| Key (v2 `piMatrixIdentity` / `piMatrixConnection`) | Default | Env override | Effect |
|---|---|---|---|
| `homeserver` | — (from login / credentials) | `PI_MATRIX_HOMESERVER` | Homeserver base URL the client connects to. |
| `userId` | — | `PI_MATRIX_USER` | The agent's Matrix user id, e.g. `@pi_agent:example.com`. |
| `deviceId` | *(unset → the credentials file's `device_id`, else `PI_AGENT_1`)* | `PI_MATRIX_DEVICE_ID` | Device the token is presented as. See below. |
| *(env only)* | *(derived from the working directory)* | `PI_MATRIX_PROJECT` | Names the project by hand, overriding the name derived from the cwd. |
| `credentialsPath` | `~/.config/mtx/accounts/{pi-matrix-username}--{matrix-domain}/credentials.json` | `PI_MATRIX_CREDENTIALS_PATH` | Where the access token is read from and written by `/matrix-login`. |
| `roomId` (`autoConnect` block) | `#{room-name}:{matrix-server-domain}` | `PI_MATRIX_ROOM` | Target room. Accepts an alias or an id. |
| `autoConnect` | `true` | `PI_MATRIX_AUTO_CONNECT` | Connect at session start. `/matrix-connect` stays the manual retry. |
| `syncTimeoutMs` | `30000` | `PI_MATRIX_SYNC_TIMEOUT_MS` | Long-poll timeout of the sync loop. |
| `promptConnectOnStartup` | `true` | `PI_MATRIX_PROMPT_CONNECT_ON_STARTUP` | Ask to connect at session start when not connected. |
| `dedupeWindowMs` | `600000` | `PI_MATRIX_DEDUPE_WINDOW_MS` | Skip an outgoing send whose content already went out within this window. |
| `maxMessageAgeMinutes` | `30` | `PI_MATRIX_MAX_MESSAGE_AGE_MINUTES` | Drop inbound room messages older than this (guards the reconnect backfill). `0` disables. |

### `deviceId` and the credentials file

An access token belongs to one device. The credentials file written by
`/matrix-login` records that device's `device_id`, so leaving `deviceId`
unset is correct for every normal install. A configured `deviceId` is an
operator override and wins over the credentials file. If the two disagree,
the extension logs a warning at connect and the homeserver rejects the
session with an unexplained `400` — remove the key to fix it.

## Room

| Key (v2 `piMatrixRoom`) | Default | Env override | Effect |
|---|---|---|---|
| `updateTopic` | `false` | `PI_MATRIX_ROOM_TOPIC_UPDATES` | Let the extension write the room topic. |
| `endToEndEncryption` | `true` | `PI_MATRIX_E2EE` (`off` to disable) | E2EE for room traffic (Olm/Megolm via the bundled Rust-crypto WASM). |
| `attachmentEncryption` | `true` | `PI_MATRIX_ATTACH_ENCRYPTION` (`off` to disable) | Encrypt file attachments at rest (Matrix spec attachment encryption). |

The crypto store is a file-backed store with `0700`/`0600` permissions.
Credentials are written the same way. What the room can and cannot do with
this extension — including who can drive the agent — is in
[SECURITY.md](../../SECURITY.md).
Device identity stays stable across restarts, which keeps E2EE history
readable.

| Key (flat) | Default | Env override | Effect |
|---|---|---|---|
| `cryptoStoreDir` | *(per-user default)* | `PI_MATRIX_CRYPTO_STORE_DIR` | Where the crypto store lives. |
| `storePassphrase` | *(unset)* | `PI_MATRIX_STORE_PASSPHRASE` | Optional at-rest passphrase for the crypto store. |

## Logging and terminal UI

| Key | Default | Env override | Effect |
|---|---|---|---|
| `logPath` (v2 `piMatrixLogging`) | `.pi/matrix/logs/pi-matrix.log` | `PI_MATRIX_LOG_PATH` | Extension log. When the active config is project-local, an unpinned path co-locates to `<project>/.pi/matrix/state/pi-matrix.log`; an explicit value always wins. |
| `logLevel` (v2 `piMatrixLogging`) | `"INFO"` | `PI_MATRIX_LOG_LEVEL` | Log verbosity. |
| `showMatrixStatus` (v2 `piTerminalUi`) | `true` | `PI_MATRIX_SHOW_FOOTER` | Show the connection status in the Pi footer. |
| `matrixIcon` (v2 `piTerminalUi`) | `💬` | `PI_MATRIX_FOOTER_ICON` | Footer icon. |
| `displayStdoutOnStartup` (v2 `piTerminalUi`) | `false` | `PI_MATRIX_DISPLAY_STDOUT_ON_STARTUP` | Print the startup banner to stdout. |
| `enabled` (v2 `piTerminalMatrixLoginCommand`) | `true` | `PI_MATRIX_MATRIX_LOGIN_ENABLED` | Register `/matrix-login`. |
| `qr2025` (v2 `piTerminalMatrixLoginCommand`) | `false` | `PI_MATRIX_QR2025` | Enable the QR-based login support. |

## Outgoing messages

| Key | Default | Env override | Effect |
|---|---|---|---|
| `sendMilestones.enabled` | `true` | `PI_MATRIX_SEND_MILESTONES` | Broadcast milestones to the room. The `matrix_send_milestone` tool is not gated by it. |
| `sendSessionStartStopMilestones` | `true` | `PI_MATRIX_SEND_SESSION_MILESTONES` | One line on session start/reload/new. |
| `sendCompactionMilestones` | `true` | `PI_MATRIX_SEND_COMPACT_MILESTONES` | One line on context compaction (`/compact` or auto-compact). |
| `sendModelChangeMilestones` | `true` | `PI_MATRIX_SEND_MODEL_MILESTONES` | One line when the model or thinking level changes. |
| `milestoneIcon` | `🎯` | `PI_MATRIX_MILESTONE_ICON` | Milestone prefix. |
| `sendUserMessages.enabled` | `true` | `PI_MATRIX_SEND_USER_MESSAGES` | Echo the terminal-typed prompt to the room as `🧑 User: …`. Never fires for room-relayed input. |
| `icon` (v2 `sendUserMessages`) | `🧑` | `PI_MATRIX_USER_MESSAGE_ICON` | User-echo prefix. |
| `sendFinalMessages.enabled` | `true` | `PI_MATRIX_SEND_FINAL_MESSAGES` | Broadcast each turn's final message as `💬 Pi: …`. |
| `prefix` (v2 `piMatrixMessageFormatting`) | `[Matrix] ` | `PI_MATRIX_PI_TERMINAL_MESSAGE_PREFIX` | Marker in front of room-origin messages in the terminal. |
| `sendFormatted` | `true` | `PI_MATRIX_SEND_FORMATTED` | Convert outgoing markdown to HTML for Matrix rich display. |
| `sendTablesInSeparateMessages` | `false` | `PI_MATRIX_TABLES_IN_SEPARATE_MESSAGE` | Send markdown tables as separate messages. |
| `maxFinalMessageLength` | `8000` | `PI_MATRIX_MAX_FINAL_MESSAGE_LENGTH` | Final-message broadcast cutoff in characters. |

## Inbound from the room

| Key | Default | Env override | Effect |
|---|---|---|---|
| `matrixToPiSlashCommands.enabled` | `true` | `PI_MATRIX_SLASH_RELAY` | Allow slash commands from the room. |
| `slashCommandPrefix` | `/` | `PI_MATRIX_SLASH_COMMAND_PREFIX` | Prefix that marks a room message as a command. |
| `piToMatrixMirrorAskUserQuestions.enabled` | `true` | `PI_MATRIX_MIRROR_ASK_USER` | Mirror `ask_user_question` questionnaires into the room. See [ask-user pairing](ask-user-pairing.md). |
| `createPollsForAskUserQuestions` (same v2 section) | `true` | `PI_MATRIX_MIRROR_ASK_USER_POLLS` | Also post a poll for yes/no style questions. |
| `matrixToPiVoiceTranscription.enabled` | `true` | `PI_MATRIX_VOICE_TRANSCRIPTION` | Transcribe voice notes sent to the room. Needs `ffmpeg` on the Pi host; failures post a warning into the room. |
| `matrixToPiVoiceTranscription.sttBaseUrl` | `""` (off) | `PI_MATRIX_STT_BASE_URL` | Remote STT endpoint tried first (OpenAI-shaped `POST {base}/audio/transcriptions`, e.g. an mlx-audio server on the LAN). Any remote failure falls back to the local engine. |
| `matrixToPiVoiceTranscription.sttModel` | `mlx-community/whisper-small-asr-fp16` | `PI_MATRIX_STT_MODEL` | Model id sent to the remote endpoint. |

Anything typed in the room becomes model input for the agent. The room's
member list is the security boundary — see [SECURITY.md](../../SECURITY.md).

## Files between terminal and room

| Key | Default | Env override | Effect |
|---|---|---|---|
| `matrixToPiRemoteFilePicker.enabled` | `false` | `PI_MATRIX_REMOTE_FILE_PICKER` | Let the room pull files from the project. |
| `fileAttachPrefix` (same v2 section) | `@` | `PI_MATRIX_FILE_PICKER_PREFIX` | Prefix that opens the file picker from the room. |
| `maxBytes` (same v2 section) | `200000` | `PI_MATRIX_ATTACH_MAX_BYTES` | Size cap for files pulled into the room. |
| `pickerLimit` | `10` | `PI_MATRIX_PICKER_LIMIT` | Entries the picker lists. |
| `fileSearchMethod` | `"builtin"` | `PI_MATRIX_FILE_SEARCH_METHOD` | Search backend for the picker. |
| `piToMatrixFileAttachment.enabled` | `false` | `PI_MATRIX_FILE_ATTACH` | Let the terminal push a file to the room. |
| `prefix` (v2 `piToMatrixFileAttachment`) | `@@` | `PI_MATRIX_FILE_ATTACH_PREFIX` | Prefix that attaches a file. |
| `maxBytesUpload` | `25000000` | `PI_MATRIX_MAX_BYTES_UPLOAD` | Upload size cap. |

## Threading and summaries

| Key (v2 `piMatrixThreading`) | Flat key | Default | Env override | Effect |
|---|---|---|---|---|
| `enabled` | `threads` | `true` | `PI_MATRIX_THREADS` | Each session opens its own `🧵` thread. `/matrix-thread-toggle` switches at runtime. |
| `threadIcon` | `threadIcon` | `🧵` | `PI_MATRIX_THREAD_ICON` | Thread marker. |
| `summaryCadence` | `threadSummaryEvery` | `10` | `PI_MATRIX_THREAD_SUMMARY_EVERY` | One summary pass every Nth message; `0` = cadence off (teardown only). |
| `useFibonacciCadence` | `threadSummaryFib` | `true` | `PI_MATRIX_THREAD_SUMMARY_FIB` | Ramp trigger points 1, 1, 2, 3, 5, 8… up to the cadence, so young threads summarize sooner. |
| `summarizeOnFinalMessage` | `threadSummaryOnFinal` | `true` | `PI_MATRIX_THREAD_SUMMARY_ON_FINAL` | Run a pass right after the turn's final message lands in the thread. |
| `useLlmForSummaries` | `threadSummaryByLlm` | `true` | `PI_MATRIX_THREAD_SUMMARY_BY_LLM` | `false` = a zero-cost heuristic line instead of an LLM pass. |
| `summarizeLimit` | `threadSummarizeLimit` | `40` | `PI_MATRIX_THREAD_SUMMARIZE_LIMIT` | Cap on new messages fed into one pass. |
| *(unset)* | `threadSummarizeModel` | *(inherited session model)* | `PI_MATRIX_THREAD_SUMMARIZE_MODEL` | Model pin for the summarizer run. |
| `summarizeRunTimeoutMs` | `threadSummarizeRunTimeoutMs` | `1800000` | `PI_MATRIX_THREAD_SUMMARIZE_RUN_TIMEOUT_MS` | Completion budget (ms) for one summarizer run on slow models. Lower it only where the summarizer model is fast; a too-low budget kills slow but successful runs. |
| `summarizeMilestoneMax` | `threadSummarizeMilestoneMax` | `8` | `PI_MATRIX_THREAD_SUMMARIZE_MILESTONE_MAX` | Milestone lines kept in the summary shape. |
| `summarizeRecentMax` | `threadSummarizeRecentMax` | `5` | `PI_MATRIX_THREAD_SUMMARIZE_RECENT_MAX` | Recent-activity lines kept. |
| `summarizeMaxLines` | `threadSummarizeMaxLines` | `25` | `PI_MATRIX_THREAD_SUMMARIZE_MAX_LINES` | Hard line cap of the rewritten root message. |
| `summarizeSource` | `threadSummarizeSource` | `"room"` | `PI_MATRIX_THREAD_SUMMARIZE_SOURCE` | `"room"` summarizes from the thread's own Matrix history (survives `/compact` and restarts, needs `pi-subagents`); `"session"` summarizes the Pi session context (richer, degraded by `/compact`). |
| `pendingRoute` | `threadPendingRoute` | `"flat"` | `PI_MATRIX_THREAD_PENDING_ROUTE` | Where messages that cannot route to a thread go: the room main line (`"flat"`) or the latest thread (`"latest"`). |
| `subThreads.enabled` | `subThreads` | `false` | `PI_MATRIX_SUB_THREADS` | Give sub-agent runs their own sub-threads. |
| `subThreads.showRolePrefixes` | `rolePrefixes` | `true` | `PI_MATRIX_ROLE_PREFIXES` | Prefix sub-agent lines with their role. |
| `subThreads.toolName` | `subagentToolName` | `"subagent"` | `PI_MATRIX_SUBAGENT_TOOL_NAME` | Tool name the detector matches for spawn detection. |

A thread summary pass that cannot produce a non-empty summary never
overwrites the last good summary. `summarizeSource: "room"` requires the
`pi-subagents` extension; without it the extension falls back to summarizing
in the current session.

## Sub-agents

The `piMatrixSubagents` block (flat: `subagents`) is shallow-merged.

| Key (v2) | Flat key | Default | Effect |
|---|---|---|---|
| `enabled` | `subagents.enabled` | `true` | Post sub-agent spawn/result traffic to the room. |
| `postSpawnMessages` | `spawnMessages` | `true` | Post a line when a sub-agent spawns. |
| `summarizeResultIntoSpawnLine` | `summarizeResultIntoSpawnLine` | `true` | Fold the result into the spawn line instead of a new message. |
| `postMode` | `postMode` | `"turn-end"` | When results are posted. |
| `plainMarker` | `plainMarker` | `⚡` | Marker on sub-agent lines. |
| `provider` | `provider` | `"tintinweb"` | Which sub-agent provider to bind: `tintinweb` (`@tintinweb/pi-subagents`, the default), `nicobailon` (`pi-subagents`, carries an upstream wake bug), or `auto` (probe and flip). Env: `PI_MATRIX_SUBAGENT_PROVIDER`. |

Wake behaviour: a finished background sub-agent run wakes the idle Pi
session through `pi-subagents`. The mirror treats that wake as internal
traffic — it does not echo back to the room and cannot re-arm the summary
trigger. That rule is the loop guard from the 2026-10 summary-loop incident:
without it, one wake spawned a new wake, forever.
