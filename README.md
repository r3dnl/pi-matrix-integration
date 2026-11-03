# Pi Matrix Integration Extension

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/pi-matrix-integration.svg)](https://www.npmjs.com/package/pi-matrix-integration)
[![npm downloads](https://img.shields.io/npm/dm/pi-matrix-integration.svg)](https://www.npmjs.com/package/pi-matrix-integration)

A Pi coding agent extension that connects a Pi session to a Matrix chat room. Pi reports what it is doing into the room, and you drive it from the room — from your phone, without touching the terminal.

## What makes pi-matrix-integration great

From the user's perspective:

- **Your phone becomes the cockpit for the agent.** The room gets a live feed of the session: milestones (`🎯`), TODO progress, session start/compact/model-change events, and each turn's final message (`💬 Pi: …`). You see what the agent is doing without being at the terminal.
- **Two-way control with full attribution.** Reply in the room and Pi picks it up; in the terminal, every Matrix-origin message is marked `[Matrix]` — no ambiguity about where input came from.
- **Decision dialogues on both surfaces.** The `ask_user_question` questionnaire is mirrored into the room; answer in the terminal *or* in the room — whichever completes first wins, with a simple reply grammar (option numbers, `Custom: …`, 👍/👎, review step before proceeding). See [ask-user pairing](docs/user/ask-user-pairing.md).
- **One session = one conversation thread, auto-summarized.** Each Pi session opens a `🧵 <topic>` thread whose root message gets rewritten in place with topic, main points and decisions. Summaries survive `/compact` and Pi restarts: in `room` source mode the LLM summarizes from the room's own history, so a phone-only user can reconstruct the whole conversation.
- **Sub-agent traffic in the room.** Spawns and results of background sub-agents are posted and folded into their spawn lines; finished runs wake an idle session without spamming the room.
- **Per-project configuration.** Each project directory can carry its own room, agent credentials, and state — "1 project : 1 room" with no code changes, every key overridable via environment variables.

**Starting principle and recommendation** for organizing Pi ↔ Matrix:

1. **(requirement) Pi Agent gets its own Matrix account.** The agent needs its own identity on the server, separate from your personal account.
2. **(recommended) One project : one Pi session.** A Pi session runs in the project root.
3. **(recommended) One Pi project instance : one Matrix room.** Each project (its Pi harness, session history, and context) gets its own room — the room is the project's shared, persistent record.
4. **(recommended) One Pi session : one conversation thread.** Every session opens its own `🧵` thread under the room; the room mainline stays clean, and each thread gets summarized as the conversation moves forward.

*Threads are a Labs feature in Element X (at least on iOS); the best experience is Element Desktop, which shows a thread in a separate panel.*

## Features

- **Milestone Broadcasting**: Pi automatically sends milestone updates to the room
- **Decision Dialogues**: the `ask_user_question` mirror — the terminal questionnaire is mirrored into the room, and a reply on either surface proceeds the decision
- **Message Attribution**: Matrix-origin messages are clearly marked in the terminal session
- **Connection Status**: real-time connection status in the terminal footer
- **Two-Way Communication**: full bidirectional messaging between Pi and Matrix
- **Threads**: each session opens its own thread, summarized as it moves
- **Organized Structure**: [1 project : 1 room] → [1 session : 1 thread]

Checklist:
- [x] Pi interacts over a Matrix chatroom with the user
- [x] milestone updates streamed to the room
- [x] the chatroom answers decision questionnaires
- [x] terminal shows the origin of every input
- [x] footer shows connection, server, room
- [x] `@` file picker from the room, `@@` file attach from the terminal
- [x] slash `/{cmd}` and `/skill:<name>` commands from the room
- [x] fuzzy search feedback for files, commands and skills
- [x] threads with automatic summaries

## Installation

You need a working Pi installation and a Matrix account of your own (any
server that supports password login; tested against Synapse).

```bash
# From npm (the Pi package gallery lists it as pi-matrix-integration):
pi install npm:pi-matrix-integration@1.0.0

# From a git tag:
pi install git:github.com/r3dnl/pi-matrix-integration@v1.0.0

# From a local checkout:
pi install /path/to/pi-matrix-integration
```

Optional: install the `pi-subagents` extension to get room-mode thread
summaries and sub-agent visibility (see below). The terminal-synchronisation
patches for the question mirror ship in this package; apply them with one
command after each install or update —
[ask-user pairing](docs/user/ask-user-pairing.md).

### Setup

1. **Have a homeserver and create the agent's own account.** Use your own
   server (see its documentation for account creation). Create a dedicated
   account for the agent — do not share your personal account.
2. **Create a room and invite the agent.** Only room members can drive the
   agent, so keep the room invite-only.
3. **Log in:** run `/matrix-login` in a Pi session. The dialogue probes your
   homeserver, asks for the agent's username and password, logs in, and
   stores the access token in a credentials file
   (`~/.config/mtx/accounts/…`, mode `0600`).
4. **Connect:** run `/matrix-connect`. The config resolves `roomId`; the
   first run asks which room to use if nothing is configured yet.
5. **Verify:** run `/matrix-status` — it prints the connected server, room,
   and user.

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/matrix-login` | Log in to Matrix (new account or re-auth) and reconnect |
| `/matrix-connect [profile]` | Connect to the Matrix room (optionally switching profile first) |
| `/matrix-disconnect` | Disconnect from the Matrix room |
| `/matrix-toggle` | Toggle Matrix integration on/off |
| `/matrix-status` | Show Matrix connection status |
| `/matrix-switch [profile]` | Switch server/room/user profile at runtime (no arg → menu) |
| `/matrix-send <message>` | Send a message to the Matrix room |
| `/matrix-messages [limit]` | Show recent messages from the Matrix room |
| `/matrix-thread-toggle` | Toggle threading (footer thread icon: bright = on, faded = off) |
| `/matrix-thread-summarize` | Run a thread-summary pass now |
| `/matrix-subagents` | List sub-agent spawns (running + settled) — advanced |
| `/matrix-introduction-tour` | Walk the room through an introduction tour |
| `/matrix-help` | Send a concise end-user guide to the room |

Aliases: `/pi-help` (= `/matrix-help`), `/matrix-summarize-thread`
(= `/matrix-thread-summarize`).

**Every command is reachable from the room.** Any room member can type
these commands into the room and they run against your session — and the
room relays slash commands from every installed extension, not just this
one (`/skill:*` and friends included). There is no per-user allowlist:
Matrix room membership is the access control. Keep the room invite-only
and let the agent use its own account.

### Tools

The extension registers three tools that Pi can use:

| Tool | Description |
|------|-------------|
| `matrix_send_milestone` | Send a milestone or status update to the room |
| `matrix_get_messages` | Retrieve recent messages from the room |
| `matrix_update_thread_summary` | Replace the active thread root's summary |

Decision questions are not a separate tool: the `ask_user_question` dialogue
is mirrored into the room by this extension, and a room reply proceeds it.

### Automatic Features

- **Milestones**: session start, TODO progress, compaction and model-change events go to the room as you work
- **Final messages**: each turn's final reply is broadcast (`💬 Pi: …`)
- **User echo**: a terminal-typed prompt appears in the room as `🧑 User: …` (never for room-relayed input)
- **Footer status**: connection status in the terminal footer

## Examples

### Basic Usage

```
# In a Pi session:
/matrix-connect
/matrix-send "Starting work on the feature"
/matrix-status
/matrix-disconnect
```

### Decision Flow

```
User asks Pi for a choice (or Pi raises a decision point)
# Pi shows the questionnaire in the terminal AND mirrors it into the room
# You answer on either surface; whichever completes first wins
Pi: Proceeding with refactoring...
```

Room reply grammar (also posted with the questionnaire): option number(s)
or label(s) ("2", "2 3" multi, "Q2: 3", "Custom: free text"), yes/no
options via emoji ("👍"/"👎", or "✅"/"❌"), and once every question is
answered a review step is posted: "Qn: x" / "Custom: text" to correct,
"confirm" / "👍" to proceed. Details:
[ask-user pairing](docs/user/ask-user-pairing.md).

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

Precedence: **environment variables > config file > defaults**. The config
file resolves as the first existing of: explicit path,
`<project>/.pi/matrix/matrix-config.json`(`.jsonc`), extension `config/`,
install location, `~/.config/pi-matrix-integration/`. Every key has an
environment override named `PI_MATRIX_<UPPER_SNAKE>`; booleans accept
`true`/`1`.

```bash
# example overrides
PI_MATRIX_HOMESERVER=matrix.example.com
PI_MATRIX_USER=@pi_agent:example.com
PI_MATRIX_ROOM=#pi-updates:example.com
PI_MATRIX_SEND_FINAL_MESSAGES=true
```

The full key reference — every key, default, effect, and environment
override — is [docs/user/configuration.md](docs/user/configuration.md).
Security posture — what the room can do, what it cannot, how to report a
vulnerability — is [SECURITY.md](SECURITY.md).

One trap worth knowing early: a profile-suffixed config file
(`matrix-config.<profile>.jsonc`) is only read when that profile is active.
The bare `matrix-config.json` is the live config.

### Per-project setup (1 project : 1 room)

Each project gets its own room and its own agent credentials. Set up once
per project:

```bash
mkdir -p <project>/.pi/matrix
# write the project's matrix-config.json (or run /matrix-login from the project):
# roomId, userId, credentialsPath for this project's room + agent account
```

Then start Pi from the project directory:

```bash
cd <project> && pi
```

What to verify on first run:

1. the session-start milestone lands in **this project's room** (flat, in
   the room main line — not a thread),
2. `<project>/.pi/matrix/state/` appears with `thread-map.json` and the
   project's own `pi-matrix.log`,
3. a session in a *different* project never touches this project's state,
4. after a Pi restart the project's state and (if used) its active profile
   restore from `<project>/.pi/matrix/`.

**FAQ: Running Pi from `~/.pi`**
Pi derives the project-local path from the working directory, so from
`~/.pi` the extension looks at `~/.pi/.pi/matrix/`. To use `~/.pi/matrix/`
instead, create a symlink:

```bash
mkdir -p ~/.pi/.pi
ln -s ~/.pi/matrix ~/.pi/.pi/matrix
```

### Thread Summarizer

Each session's `🧵 <topic>` root message is rewritten in place, every
`threadSummaryEvery` messages, and once more at session end.

| key | default | practical effect |
|---|---|---|
| `threadSummaryByLlm` | `true` | `false` = a zero-cost heuristic line instead of an LLM pass |
| `threadSummaryEvery` | `10` | one pass every Nth message; `0` = cadence off (teardown only) |
| `threadSummaryFib` | `true` | trigger points ramp 1, 1, 2, 3, 5, 8… up to the cadence, so young threads summarize sooner |
| `threadSummaryOnFinal` | `true` | a pass runs right after the turn's final message lands in the thread |
| `threadSummarizeSource` | `"room"` | `"room"` = summarize from the thread's own Matrix history (survives `/compact`/restarts, needs `pi-subagents`); `"session"` = from the Pi session context (richer, degraded by `/compact`) |
| `threadSummarizeLimit` | `40` | cap on new messages fed into one pass |
| `threadSummarizeModel` | *(inherited)* | model pin for the summarizer run |
| `threadSummarizeRunTimeoutMs` | `1800000` | completion budget for one run — sized for slow models; lower it only where the summarizer model is fast |

A failed or empty pass never clobbers the last good summary. Environment
overrides and the remaining keys:
[configuration reference](docs/user/configuration.md).

**Recommendation** — keep the defaults (`room` + LLM + every 10 + limit 40);
pin a small model in `threadSummarizeModel` if cadence passes matter. Use
`"session"` only for long coding sessions where the summary must reflect
session decisions rather than what was typed in the room — and accept that
`/compact` degrades the material the next pass sees.

## Architecture

```
┌────────────────────────────── Pi session ──────────────────────────────┐
│  commands · footer status · terminal questionnaire (ask_user_question) │
└───────────────┬────────────────────────────────────────────┬───────────┘
        inject room input                         event mirror
                │                                              │
┌───────────────▼────────────────────────────────────────────▼───────────┐
│                        pi-matrix-integration                           │
│  message handler (format, dedupe, attribution)                         │
│  threading + summarizer (thread map, cadence, LLM passes)              │
│  ask-user mirror (dual-surface questionnaires)                         │
│  sub-agent bridge (spawns, results, wake guard)                        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ matrix-js-sdk (Client-Server + E2EE)
┌───────────────────────────────▼────────────────────────────────────────┐
│                     Homeserver (Synapse or compatible)                 │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                     Matrix clients: Element, FluffyChat, …
```

Reads and writes go directly to the homeserver over Client-Server HTTP from
inside the extension — no external process on the message path. The official
`matrix-js-sdk` provides the sync loop, reconnect with backoff, and E2EE
(Olm/Megolm via bundled Rust-crypto WASM, file-backed store with `0700`/`0600`
permissions, stable device identity).

- **Outgoing (Pi → room):** session events are formatted (markdown → HTML
  where supported), deduplicated, and posted — milestones flat, session
  content into the session's thread.
- **Incoming (room → Pi):** the sync loop delivers room events; machine
  traffic and stale backfill are filtered; genuine input is injected into
  the session marked `[Matrix]`. Slash commands and `/skill:` names from the
  room run as commands.

The developer documentation maps this in detail:
[architecture](docs/dev/architecture/README.md).

## Security

- **The agent gets its own account.** Do not give the extension your
  personal credentials.
- **The room membership list is the security boundary.** Anyone in the room
  can use the full command surface Pi registers, including other
  extensions' commands and `/skill:` invocations. Keep the room
  invite-only.
- **Anything posted in the connected room becomes model input.** Do not use
  a public room. Machine-traffic filtering reduces echo loops; it is not an
  access control.
- **Credentials** live in the credentials file (mode `0600`), separate from
  config and state; they are never logged.

## Troubleshooting

Common failures — cannot connect, connected-but-silent, missing threads,
decryption problems, stale summaries — are walked through in
[docs/user/troubleshooting.md](docs/user/troubleshooting.md).

## Roadmap

Planned, not in 1.0.0:

- Auto-upload of markdown/feature files as attachments for inspection.
- Command-surface redesign — recorded, not started; tracked as a GitHub
  issue when the repository is created. Known items: the duplicate
  `/matrix-summarize-thread` alias, the `matrix-toggle` /
  `matrix-thread-toggle` naming collision, and several commands that
  toggle state the config file already owns. Bound by three rules: the
  config file is the leading declarative description of behaviour;
  commands invoke functionality and never store preferences; anything a
  user needs away from the terminal must be a room-reachable command.
- Activity-based summarizer watchdog: abort runs that stream nothing,
  instead of waiting out the completion budget.

## For developers

Three test tiers, declared in `package.json`:

| Command | What it is |
|---------|------------|
| `npm test` | the offline tier — deterministic units and the full conversation cycle against a fake outbox, no homeserver, no network, under a 120-second budget. This is the gate on every push |
| `npm run test:live` | a real homeserver and room; needs `PI_MATRIX_HOMESERVER`, `PI_MATRIX_USERNAME`, `PI_MATRIX_PASSWORD` and refuses to run without them |
| `npm run test:perf` | latency and context-size budgets; reserved for the performance work and fails loudly until it lands |

- [Developing](docs/dev/developing.md) — setup, the loop, the test tiers, releasing
- [Coding standards](docs/dev/coding-standards.md) — the rules and the gate that enforces each one
- [Architecture](docs/dev/architecture/README.md) — the map, the invariants, and why they are there

## License

MIT License — see [LICENSE](LICENSE). Attribution for Apache-2.0
dependencies: see [NOTICE](NOTICE).
