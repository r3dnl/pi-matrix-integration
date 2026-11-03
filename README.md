# Pi Matrix Integration Extension

A Pi coding agent extension that enables integration with Matrix chat rooms. This allows Pi to send updates to Matrix and receive user responses, enabling collaborative workflows across terminal and chat interfaces.

## What makes pi-matrix-integration great

From the user's perspective:

- **Your phone becomes the cockpit for the agent.** The room gets a live feed of the session: milestones (`🎯`), TODO progress, session start/compact/model-change events, and each turn's final message (`💬 Pi: …`). You see what the agent is doing without being at the terminal.
- **Two-way control with full attribution.** Reply in the room and Pi picks it up; in the terminal, every Matrix-origin message is marked `[Matrix]` — no ambiguity about where input came from.
- **Decision dialogues on both surfaces.** The `ask_user_question` questionnaire is mirrored into the room; answer in the terminal *or* in the room — whichever completes first wins, with a simple reply grammar (option numbers, `Custom: …`, 👍/👎, review step before proceeding).
- **One session = one conversation thread, auto-summarized.** Each Pi session opens a `🧵 <topic>` thread whose root message gets rewritten in place with topic, main points and decisions. Summaries survive `/compact` and Pi restarts: in `room` source mode the LLM summarizes from the room's own history, so a phone-only user can reconstruct the whole conversation.
- **Flexible configuration manifests.** One manifest picks the Matrix server, the Pi agent's Matrix credentials, the target room, and the extension's behavior. Switching between environments (e.g. a test and a production homeserver) is a manifest swap — no code changes, every key overridable via env vars.

**Starting principle and recommendation** for organizing Pi ↔ Matrix:

1. **(requirement) Pi Agent gets its own matrix account** Pi agent requires its own identiy on the matrix server, seperate from your personal matrix account.
2. **(recommended) One project: one Pi session** Assumption is that a Pi Session runs in the project root.
3. **(recommended) One Pi project instance : one Matrix room.** Each project (its Pi harness, session history, and context) gets its own room — the room is the project's shared, persistent record.
4. **(recommended) One Pi session in that project : one conversation thread.** Enable threaded conversations. Every session opens its own `🧵` thread under the room; the room mainline stays clean, and each thread gets summarized as the conversation moves forward. (*)

*_(*note) `element X` supports threads as a Labs function (at least on iOS), but the best experience is with Element desktop which shows a thread in a separate panel_*

## Features

- **Milestone Broadcasting**: Pi automatically sends milestone updates to a Matrix chatroom
- **Decision Dialogues**: user/RPIV decisions are routed through the `ask_user_question` mirror — the terminal questionnaire is mirrored into the room, and a reply on either surface proceeds the decision
- **Message Attribution**: Matrix-origin messages are clearly marked in the terminal session
- **Connection Status**: Real-time connection status displayed in the terminal footer
- **Two-Way Communication**: Full bidirectional messaging between Pi and Matrix
- **Dynamic Content**: Integration with TODO progress and RPIV decision dialogues
- **Organized Structure Pi <-> Matrix** Recommendation: [1 project with Pi harness : 1 chatroom] -> [1 Pi session : 1 conversation thread]

Checklist:
- [x] new extension that lets Pi interact over a matrix chatroom with the user
- [x] Pi agent runs in its own process - this extension is not a replacement for that
- [x] Pi agent provides the milestone updates in a session to the matrix user
- [x] the matrix user can respond in the chatroom
- [x] the chatroom can be used to complete decisions to be taken by the user
- [x] the normal Pi session in the terminal annotates messages that came in via matrix, so it is fully transparent in the session what the origin is of user input
- [x] the normal Pi session in the terminal has footer information about an active matrix connection: show connection status, the full URI to the matrix server and room
- [x] help function
- [x] @ annotate files
- [ ] markdown files, feature files get auto-uploaded as attachment for inspection
- [x] slash `/{ext:cmd}` commands for extensions
- [x] `/skill:abc` for skill invocation
- [x] Fuzzy search feedback for files, commands and skills
- [x] Threads: starting a new Pi session triggers a new conversation thread
- [x] conversation threads get automatically summarized in the chatroom main thread as conversation moves forward: topic, main discussion points & decisions


## Installation

### Prerequisites

1. **Matrix Server**: Access to a Matrix server (tested with Synapse)
2. **mtx CLI Tool**: The [mtx](https://github.com/vincentjansen/synapse-matrix/tree/main/tools/mtx) tool must be installed and available in PATH
3. **matrix-accounts-py**: The [matrix-accounts-py](https://github.com/vincentjansen/synapse-matrix/tree/main/tools/matrix-accounts-py) tool for account management

### Setup

1. **Install the extension**:
   ```bash
   # Clone or copy the extension to your Pi extensions directory
   mkdir -p ~/.pi/agent/extensions/pi-matrix-integration
   cp -r /path/to/pi-matrix-integration/* ~/.pi/agent/extensions/pi-matrix-integration/
   ```

2. **Create Matrix Account**:
   ```bash
   # Create a manifest for your Pi agent account
   cat > /tmp/pi-agent-manifest.json << 'EOF'
   {
     "apiVersion": "homeops/v1",
     "kind": "AccountSet",
     "environment": "tst2",
     "keycloak_realm": "tst2-matrix",
     "email_domain": "r3d.nl",
     "mc_users_dir": "~/.config/mtx",
     "users": [
       { "username": "pi-agent", "password": "your-secure-password", "is_admin": false }
     ],
     "rooms": [
       { "name": "pi-updates", "topic": "Pi Agent Updates", "primary": true, "members": ["pi-agent"] }
     ]
   }
   EOF
   
   # Provision the account and credentials
   matrix-accounts all /tmp/pi-agent-manifest.json
   ```

3. **Configure the Extension**:
   ```bash
   # Edit the configuration file
   nano ~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json
   ```

   Update the configuration with your Matrix server details — the live file
   `config/matrix-config.json` is the complete schema (every key, live
   values; the reference table is in `DESIGN.md` → *Configuration*):
   ```json
   {
     "environment": "tst2",
     "homeserver": "tst2-matrix.r3d.nl",
     "userId": "@pi_agent:tst2-matrix.r3d.nl",
     "roomId": "#pi-updates:tst2-matrix.r3d.nl",
     "credentialsPath": "~/.config/mtx/accounts/pi_agent--tst2-matrix.r3d.nl/credentials.json",
     "pollInterval": 5000,
     "autoReconnect": true,
     "showInFooter": true,
     "messagePrefix": "[Matrix] ",
     "piDisplayName": "Pi Agent",
     "sendMilestones": true,
     "sendFinalMessages": true,
     "sendSessionMilestones": true,
     "sendCompactMilestones": true,
     "sendModelMilestones": true,
     "sendUserMessages": true,
     "autoConnect": true,
     "dedupeWindowMs": 600000,
     "finalMessageMaxLength": 2000,
     "sendFormatted": false,
     "tablesInSeparateMessage": false
   }
   ```

4. **Verify mtx Installation**:
   ```bash
   mtx --help
   mtx env list
   mtx user list -e tst2
   ```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/matrix-connect` | Connect to the Matrix room |
| `/matrix-disconnect` | Disconnect from the Matrix room |
| `/matrix-toggle` | Toggle Matrix integration on/off |
| `/matrix-status` | Show Matrix connection status |
| `/matrix-send <message>` | Send a message to the Matrix room |
| `/matrix-messages [limit]` | Get recent messages from Matrix |

### Tools

The extension registers the following tools that Pi can use:

| Tool | Description |
|------|-------------|
| `matrix_send_milestone` | Send a milestone update to Matrix |
| `matrix_get_messages` | Retrieve recent messages from Matrix |

Decision questions are not a separate tool: the RPIV `ask_user_question`
dialogue is mirrored into the room by this extension (the dual-surface bridge
in `src/ask-user-mirror.ts`), and a room reply proceeds it.

### Automatic Features

- **Milestone Detection**: Pi automatically detects and sends milestone updates to Matrix
- **TODO Progress**: TODO list updates are broadcast to Matrix
- **Footer Status**: Connection status is shown in the terminal footer
- **Message Attribution**: Matrix messages are clearly marked with `[Matrix]` prefix

## Examples

### Basic Usage

```
# In Pi session:
/matrix-connect
# Pi connects to Matrix and starts polling for messages

# Send a message to Matrix
/matrix-send "Starting work on the feature"

# Check connection status
/matrix-status

# Disconnect
/matrix-disconnect
```

### Decision Flow

Decisions use the RPIV `ask_user_question` dialogue, which this extension
mirrors into the room:

```
User asks Pi for a choice (or Pi raises a decision point)
# Pi shows the questionnaire in the terminal AND mirrors it into the room
# The user answers on the terminal or in the room; whichever completes first wins
Pi: Proceeding with refactoring...
```

Room reply grammar (also posted with the questionnaire): option number(s)
or label(s) ("2", "2 3" multi, "Q2: 3", "Custom: free text"), yes/no
options via emoji ("👍"/"👎", or "✅"/"❌" — mapped onto the single
yes-ish / no-ish option label), and once every question is answered a
review step is posted: "Qn: x" / "Custom: text" to correct, "confirm" /
"👍" to proceed.

### Milestone Updates

```
# When Pi completes a milestone
Pi: Analysis complete. [Milestone: Analysis Done]
# → Automatically sent to Matrix: "🎯 Milestone: Analysis Done"

# When Pi updates TODO
Pi: Updated TODO list
# → Automatically sent to Matrix: "📋 TODO: 3 items remaining"
```

## Configuration

### Environment Variables

You can override configuration using environment variables:

```bash
# Matrix environment
PI_MATRIX_HOMESERVER=tst2-matrix.r3d.nl
PI_MATRIX_USER=@pi_agent:tst2-matrix.r3d.nl
PI_MATRIX_ROOM=#pi-updates:tst2-matrix.r3d.nl

# Paths
PI_MATRIX_CREDENTIALS_PATH=~/.config/mtx/accounts/pi_agent--tst2-matrix.r3d.nl/credentials.json

# Behavior (booleans accept true/1)
PI_MATRIX_SHOW_FOOTER=true
PI_MATRIX_SEND_MILESTONES=true
PI_MATRIX_SEND_SESSION_MILESTONES=true
PI_MATRIX_SEND_COMPACT_MILESTONES=true
PI_MATRIX_SEND_MODEL_MILESTONES=true
PI_MATRIX_SEND_USER_MESSAGES=true
PI_MATRIX_SEND_FINAL_MESSAGES=true
PI_MATRIX_AUTO_CONNECT=true
PI_MATRIX_DEDUPE_WINDOW_MS=600000
PI_MATRIX_MAX_MESSAGE_AGE_MINUTES=30
PI_MATRIX_MAX_FINAL_MESSAGE_LENGTH=8000
PI_MATRIX_SEND_FORMATTED=true
PI_MATRIX_TABLES_IN_SEPARATE_MESSAGE=false
```

Removed env vars (they configured code that no longer exists, or were renamed
with the v2 schema): `PI_MATRIX_POLL_INTERVAL`, `PI_MATRIX_AUTO_RECONNECT`
(the SDK owns the sync loop and reconnect), `PI_MATRIX_ENVIRONMENT` (the
profile name replaced the environment label), and
`PI_MATRIX_FINAL_MESSAGE_MAX_LENGTH` → `PI_MATRIX_MAX_FINAL_MESSAGE_LENGTH`.

Other overrides the same block accepts (names are the config parameter, upper
snake case, prefixed `PI_MATRIX_`): `PI_MATRIX_LOG_LEVEL`, `PI_MATRIX_LOG_PATH`,
`PI_MATRIX_SLASH_RELAY`, `PI_MATRIX_SLASH_COMMAND_PREFIX`,
`PI_MATRIX_MIRROR_ASK_USER`, `PI_MATRIX_MIRROR_ASK_USER_POLLS`,
`PI_MATRIX_REMOTE_FILE_PICKER`, `PI_MATRIX_PICKER_LIMIT`, `PI_MATRIX_ATTACH_MAX_BYTES`,
`PI_MATRIX_FILE_ATTACH`, `PI_MATRIX_FILE_ATTACH_PREFIX`, `PI_MATRIX_FILE_PICKER_PREFIX`,
`PI_MATRIX_FILE_SEARCH_METHOD`, `PI_MATRIX_MAX_BYTES_UPLOAD`, `PI_MATRIX_MILESTONE_ICON`,
`PI_MATRIX_USER_MESSAGE_ICON`, `PI_MATRIX_THREAD_ICON`, `PI_MATRIX_THREADS`,
`PI_MATRIX_SUB_THREADS`, `PI_MATRIX_ROLE_PREFIXES`, `PI_MATRIX_SUBAGENT_TOOL_NAME`,
`PI_MATRIX_ROOM_TOPIC_UPDATES`, `PI_MATRIX_SYNC_TIMEOUT_MS`, `PI_MATRIX_MAX_MESSAGE_AGE_MINUTES`, `PI_MATRIX_PROMPT_CONNECT_ON_STARTUP`,
`PI_MATRIX_MATRIX_LOGIN_ENABLED`, `PI_MATRIX_DISPLAY_STDOUT_ON_STARTUP`,
`PI_MATRIX_PI_TERMINAL_MESSAGE_PREFIX`, `PI_MATRIX_THREAD_PENDING_ROUTE`, `PI_MATRIX_E2EE`, `PI_MATRIX_ATTACH_ENCRYPTION`, `PI_MATRIX_DEVICE_ID`,
`PI_MATRIX_CRYPTO_STORE_DIR`, `PI_MATRIX_STORE_PASSPHRASE`, `PI_MATRIX_QR2025`,
`PI_MATRIX_VOICE_TRANSCRIPTION`, `PI_MATRIX_FOOTER_ICON`, `PI_MATRIX_ALLOW_PROD`.
See `src/config.ts` `ENV_MAPPINGS` for the authoritative list.

### Configuration File

The configuration file is resolved by precedence (first existing wins):

1. an explicit path (API/tests),
2. **project-local**: `<project>/.pi/matrix/matrix-config.json` — Pi runs
   with the project as cwd, so each project can carry its own Matrix setup:
   its room, its agent credentials, its profiles, its
   `last-active-profile` pointer, and its `state/` (thread map + per-env
   seen/unread watermarks) under `<project>/.pi/matrix/state/`. The log
   file co-locates too: an unpinned `logPath` resolves to
   `<project>/.pi/matrix/state/pi-matrix.log` (applied in-memory at load
   time; an explicit file/env value always wins). This is
   how "1 project : 1 room" is realized per project — no code changes,
   just drop a manifest into the project's `.pi` folder.
3. the extension-local `config/matrix-config.json` (ships with the
   extension),
4. the install-location (`~/.pi/agent/extensions/pi-matrix-integration/config/`)
   and XDG (`~/.config/pi-matrix-integration/config.json`) fallbacks.

With no project-local config, state stays in the historical
`<extension-dir>/state/` (existing installs keep their files where they
are — no silent migration).

**FAQ: Running Pi from `~/.pi` (Pi home directory)**
When you start Pi from `~/.pi`, the extension looks for config at `~/.pi/.pi/matrix/matrix-config.json` (project-local path derived from cwd). To use `~/.pi/matrix/` instead, create a symlink:
```bash
mkdir -p ~/.pi/.pi
ln -s ~/.pi/matrix ~/.pi/.pi/matrix
```
This makes the project-local path resolve to your global Matrix config, profiles, and state.

### Per-project setup (1 project : 1 room)

Each project gets its own room + its own agent credentials. Setup once
per project:

```bash
mkdir -p <project>/.pi/matrix
cp ~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json \
   <project>/.pi/matrix/matrix-config.json
# edit the manifest: roomId, userId, credentialsPath for this project's
# room + agent account
```

Then start Pi from the project directory:

```bash
cd <project> && pi
```

What to verify on first run:

1. the session-start milestone lands in **this project's room** (flat, in
   the room main line — not a thread),
2. `<project>/.pi/matrix/state/` appears with `thread-map.json` and
   `pi-matrix.log` (the log path resolves project-local in-memory),
3. a session in a *different* project never touches this project's
   thread map or watermarks,
4. after a Pi restart the project's state and (if used) its
   `last-active-profile` restore from `<project>/.pi/matrix/`.

Debugging: `tail -f <project>/.pi/matrix/state/pi-matrix.log` shows this
project's own extension log instead of the shared `~/.pi/logs/pi-matrix.log`.

The complete key reference (types, defaults, env overrides) is the
configuration table in `DESIGN.md` → *Configuration*. Fields:
- `environment`: Matrix environment name (e.g., 'tst2')
- `homeserver`: Matrix homeserver (e.g., 'tst2-matrix.r3d.nl')
- `userId`: Matrix user ID (e.g., '@pi_agent:tst2-matrix.r3d.nl')
- `roomId`: Matrix room ID or alias (e.g., '#pi-updates:tst2-matrix.r3d.nl')
- `credentialsPath`: Path to credentials.json file
- `pollInterval`: Polling interval in milliseconds (default: 5000)
- `autoReconnect`: Whether to auto-reconnect on connection loss (default: true)
- `showInFooter`: Whether to show connection status in footer (default: true)
- `messagePrefix`: Prefix for Matrix messages in Pi (default: '[Matrix] ')
- `piDisplayName`: Display name for Pi in Matrix (default: 'Pi Agent')
- `sendMilestones`: Heuristic auto-broadcasts (milestone/TODO marker scans) — the `matrix_send_milestone` tool is not gated (default: true)
- `sendSessionMilestones`: Push a short line to the room on session start/reload/new (the `session_start` event) (default: true)
- `sendCompactMilestones`: Push a short line to the room on context compaction (`/compact`, auto-compact on threshold or overflow) (default: true)
- `sendModelMilestones`: Push a short line to the room when the active model or thinking level changes via `/model`, Ctrl+P cycling, or session restore (default: true)
- `sendUserMessages`: Broadcast the user's own terminal-typed prompt to the room as `🧑 User: …` so a phone-only user sees what they (or a colleague at the terminal) asked — only fires for genuine terminal-typed input (`source === "interactive"`), never for Matrix-relayed messages (default: true)
- `sendFinalMessages`: Also broadcast each turn's final assistant message to the room as `💬 Pi: …` (default: false; enabled in the live `config/matrix-config.json`)
- `autoConnect`: Connect + start polling at session start (default: true; `/matrix-connect` stays the manual retry)
- `dedupeWindowMs`: Outgoing send dedupe window in ms; identical content is skipped within the window (default: 600000)
- `maxMessageAgeMinutes`: Drop inbound room messages older than this instead of injecting them (warn-log each drop, one room notice per burst naming the timestamps + thread root). Guards against the initial-sync / reconnect backfill arriving flagged live. `0` disables (default: 30)
- `finalMessageMaxLength`: Final-message broadcast cutoff in chars (default: 2000)
- `sendFormatted`: Convert outgoing markdown to HTML `formatted_body` (`--html`); keep **false** until the `mtx` formatted-body change is deployed and Element Web rendering is verified (default: false)
- `tablesInSeparateMessage`: Send markdown table blocks as separate `mtx` sends (only if mobile chokes on inline tables; default: false)

### Thread Summarizer

Thread summaries rewrite the `🧵 <topic>` root message in place, every
`threadSummaryEvery` messages, and once more at session end. Seven toggles
(`DESIGN-ROOM-SUMMARIZER.md` is the full design):

| key | default | env override | practical effect |
|---|---|---|---|
| `threadSummaryByLlm` | `true` | `PI_MATRIX_THREAD_SUMMARY_BY_LLM` | `true` = the LLM rewrites the summary from last-summary + new messages; `false` = a zero-cost heuristic line (`main: … · now: …`), no LLM call at all |
| `threadSummaryEvery` | `10` | `PI_MATRIX_THREAD_SUMMARY_EVERY` | cadence: one pass every Nth message in the thread; `0` = off (teardown-only). In fib mode N is the cap the Fibonacci ramp settles on |
| `threadSummaryFib` | `true` | `PI_MATRIX_THREAD_SUMMARY_FIB` | Fibonacci-capped cadence: trigger points start 1, 1, 2, 3, 5, 8… capping at `threadSummaryEvery` (whichever is lower); a busy thread settles onto the fixed cadence. `false` restores the fixed modulo cadence |
| `threadSummaryOnFinal` | `true` | `PI_MATRIX_THREAD_SUMMARY_ON_FINAL` | report-out trigger: when the turn's final message (the `sendFinalMessages` report-out, kind `final`) lands in the thread, a summary pass runs right after it. LLM mode dedupes against a queued run; heuristic mode re-posts the (zero-cost) ledger line. A final that only answers a summarizer wake absorbed into a live run is still broadcast, but it does not re-arm the trigger, and a pass whose whole delta is such finals is skipped (see `docs/planning/BUG-SUMMARIZER-ONFINAL-LOOP.md`). Off = cadence + teardown only |
| `threadSummarizeSource` | `"room"` | `PI_MATRIX_THREAD_SUMMARIZE_SOURCE` | where the new material comes from: the thread's own Matrix messages (`"room"`) or the Pi session's own context (`"session"`) |
| `threadSummarizeLimit` | `40` | `PI_MATRIX_THREAD_SUMMARIZE_LIMIT` | cap on how many new messages are kept in the prompt (bounds cost per pass) |
| `threadSummarizeModel` | *(inherited)* | `PI_MATRIX_THREAD_SUMMARIZE_MODEL` | model pin for the subagent run; omit to inherit the session model |
| `threadSummarizeRunTimeoutMs` | `1800000` | `PI_MATRIX_THREAD_SUMMARIZE_RUN_TIMEOUT_MS` | watchdog (ms) for a summarizer run that never reports back — releases the single-flight flag; slow completions always post regardless |

**Decision tree**

```
Do you want automatic thread summaries at all?
├─ no  → threadSummaryByLlm=false (heuristic line, zero LLM cost)
└─ yes →
    Who reads the thread, and when?
    ├─ a phone-only user — after /compact, /reload, or a Pi restart
    │  → threadSummarizeSource="room" (default)
    │     the summary is a pure function of the room artifact: it survives
    │     compaction/restarts because the delta is re-read from the room;
    │     each pass only summarizes what's new (per-root event watermark).
    └─ me, inside this session, where code-level detail matters
       → threadSummarizeSource="session"
          the main session summarizes its own context; richer, but that
          context is what /compact throws away — quality degrades after it.

How expensive should a pass be?
├─ cadence cost matters → pin a small model in threadSummarizeModel
│  (passes run every N messages, not just at teardown)
└─ prompt size matters  → lower threadSummarizeLimit (default 40)
```

**Practical effects**

- **What you see:** the `🧵 <topic>` root message gets rewritten in place in
  the thread room (posted as a fresh root elsewhere). A failed or empty pass
  never clobbers the last good summary — the root keeps its previous text.
- **Cost:** `"room"` runs an isolated subagent with a small standalone
  context (last summary + up to `threadSummarizeLimit` messages) — cheap,
  independent of the main session size. `"session"` costs a full agent turn
  in the main session (the context it needs is already there, so it can't be
  shrunk).
- **Prereq for `"room"`:** the `@tintinweb/pi-subagents` extension. Without
  it, the extension falls back to the in-session directive automatically.
- **`"room"` needs readable room history:** in E2EE rooms the on-demand read
  decrypts on demand (DESIGN-ROOM-SUMMARIZER.md §10) — a thread whose summary
  stays frozen while `msgCount` advances was the E2EE read bug, fixed
  2026-09-21.

**Recommendation** — keep the defaults (`room` + LLM + every 10 + limit 40);
add a `threadSummarizeModel` pin to a small model if the cadence passes
matter. Set `threadSummarizeSource: "session"` only for long coding sessions
where the summary must reflect session decisions (intent, code-level detail)
rather than just what was typed in the room — and accept that a `/compact`
mid-session degrades the material the next pass sees.

## Architectural & technical highlights

- **Security via the official SDK.** Matrix access runs on the official `matrix-js-sdk` Client–Server stack with E2EE enabled by default: bundled Rust-crypto WASM (Olm 1-to-1 device channels + Megolm room keys), a file-backed crypto store with strict `0700`/`0600` permissions, a stable device identity across restarts, and an optional at-rest store passphrase.
- **In-process transport, resilient by design.** Reads and sends — including thread/decision-ledger posts — go directly to the homeserver over Client–Server HTTP from inside the extension: no external process on the message path. Polling with per-room watermarks, dedupe, and auto-reconnect with backoff; a single-sender identity invariant prevents Pi's own posts from echoing back as "user input".

### TO-DO

- [ ] **Manifest-based account provisioning**: provision Matrix accounts and rooms declaratively from a manifest, with secrets (e.g. passwords) injected from environment variables so the manifest itself can be committed.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Pi Terminal Session                            │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    Extension Layer                              │  │
│  │  ┌───────────────┐  ┌────────────────┐  ┌────────────────────┐  │  │
│  │  │ Matrix Client │  │ Message Handler│  │ Session Integrator │  │  │
│  │  │ (mtx wrapper) │  │ (formatting)   │  │ (message injection)│  │  │
│  │  └───────────────┘  └────────────────┘  └────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                    Session Manager                              │  │
│  │  - Stores messages with Matrix metadata                         │  │
│  │  - Tracks conversation tree with source attribution             │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    External Tools (mtx CLI)                         │
│  - Send messages to Matrix                                          │
│  - Read messages from Matrix                                        │
│  - Manage rooms and users                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Matrix Server (Synapse)                        │
│  - tst2-matrix.r3d.nl                                               │
│  - Room: !pi-updates:tst2-matrix.r3d.nl                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Message Flow

### Outgoing (Pi → Matrix)

1. Pi generates a message (milestone, final message, decision dialogue, etc.)
2. Extension intercepts via event listeners
3. Message Handler formats the message for Matrix
4. Matrix Client sends via mtx CLI
5. Message appears in Matrix room

### Incoming (Matrix → Pi)

1. User sends message in Matrix room
2. mtx CLI detects new message (via polling)
3. Matrix Client receives and parses message
4. Message Handler processes message
5. Session Integrator injects into Pi session
6. Pi displays message with `[Matrix]` prefix

## Security

- **Authentication**: Uses existing mtx credential store at `~/.config/mtx`
- **Message Validation**: All incoming messages are validated and sanitized
- **Rate Limiting**: Configurable polling interval prevents excessive requests
- **Error Handling**: Automatic reconnection with exponential backoff

## Troubleshooting

### Connection Issues

1. **Verify mtx is working**:
   ```bash
   mtx status -e tst2
   ```

2. **Check credentials**:
   ```bash
   ls -la ~/.config/mtx/accounts/pi-agent--tst2-matrix.r3d.nl/credentials.json
   ```

3. **Test sending a message manually**:
   ```bash
   mtx message send "test message" -r !pi-updates:tst2-matrix.r3d.nl -e tst2
   ```

### Extension Not Loading

1. **Check Pi logs**: Look for extension loading errors
2. **Verify configuration**: Ensure the config file is valid JSON
3. **Check file permissions**: Ensure Pi can read the extension files

### Messages Not Appearing

1. **Check connection status**: `/matrix-status`
2. **Verify room ID**: Ensure the room ID in config is correct
3. **Test polling**: `/matrix-messages` to see if messages are being retrieved

## Development

### Project Structure

```
pi-matrix-integration/
├── index.ts                    # Main extension entry point
├── DESIGN.md                  # Design document
├── README.md                  # This file
├── package.json               # Dependencies
├── config/
│   └── matrix-config.json     # Configuration
└── src/
    ├── config.ts              # Configuration management
    ├── matrix-client.ts       # Matrix client wrapper
    ├── message-handler.ts     # Message processing (+ send dedupe)
    ├── markdown.ts            # Outgoing Markdown → HTML converter
    └── session-integration.ts # Session integration
```

### Building

The extension uses TypeScript and is loaded directly by Pi (via jiti), so no compilation is needed.

### Testing

```bash
# Offline suite (fake `mtx` binary — no homeserver needed):
node test/run.mjs         # repro + test-logic + test-gates
node test/repro.mjs       # loads index.ts exactly like Pi does
node test/test-logic.mjs  # client/handler/dedupe/markdown/config logic
node test/test-gates.mjs  # sendMilestones / autoConnect gates via factory
npm run test:live         # live E2E against the real homeserver
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues or questions:
- Check the troubleshooting section above
- Review the design document for architecture details
- Open an issue in the repository

## Version History

- **1.0.0**: Initial release
  - Basic Matrix integration
  - Message sending/receiving
  - Connection status in footer
  - Milestone broadcasting
  - Decision requests
