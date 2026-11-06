# pi-matrix-integration

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/pi-matrix-integration.svg)](https://www.npmjs.com/package/pi-matrix-integration)
[![CI](https://github.com/r3dnl/pi-matrix-integration/actions/workflows/ci.yml/badge.svg)](https://github.com/r3dnl/pi-matrix-integration/actions/workflows/ci.yml)

## _Own your agentic stack, also on the road_

A Pi coding agent extension that connects a [Pi](https://pi.dev/) session to a [Matrix](https://matrix.org/) chat room. Pi posts what it is doing into the room — milestones, questions, final answers — as it works. You reply from the room to steer it: from your phone, tablet or PC - with [Element](https://element.io/) or  [Whatsapp, Discord, Slack, Telegram etc](https://matrix.org/ecosystem/bridges/), without touching the terminal (though you can work from both at once).

![Demo: a Pi session on a laptop posts milestones into a Matrix room; the same session is steered from a phone running Element](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-overview.gif)

## Install

```sh
pi install npm:pi-matrix-integration
```

Restart your Pi session. Until the npm publish lands, install the beta from git: `pi install git:github.com/r3dnl/pi-matrix-integration@v0.9.0`.

You need a Matrix account of the agent's own — not your personal one — on any server with password login (tested against Synapse).

## Quick start

1. Create the agent's own account on your homeserver, create a room and invite it. Only room members can drive the agent — keep the room invite-only.
2. Run `/matrix-login` in a Pi session: the dialogue probes your homeserver, logs in, and stores the access token in a credentials file (`~/.config/mtx/accounts/…`, mode `0600`).
3. Run `/matrix-connect` — the first run asks which room to use.
4. Run `/matrix-status`: it prints the connected server, room and user.
5. Type something in the terminal and watch it appear in the room as `🧑 User: …`.
6. Run `/matrix-introduction-tour` in the terminal, or `//matrix-introduction-tour` from the room, to walk every feature.

## What you get

| | Why it's great |
|---|---|
| **Full autonomy** | Your own Pi harness, your own messaging server — fully integrated, no SaaS in between. |
| **Live progress feed** | The room gets milestones (`🎯`), TODO progress, session/compact/model events and each turn's final answer (`💬 Pi: …`) — you know what the agent is doing from anywhere. |
| **Two-way control, full attribution** | Reply in the room and Pi picks it up; terminal input echoes to the room as `🧑 User: …`; room input shows in the terminal as `[Matrix] …`. No ambiguity about where any input came from. |
| **Decision dialogues on both surfaces** | The [`ask_user_question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) questionnaire is mirrored into the room; answer on either side — first answer wins ([pairing](docs/user/ask-user-pairing.md)). |
| **One session = one thread, kept current** | Each session opens a `🧵 <topic>` thread; its root is rewritten in place with topic, points and decisions — surviving `/compact` and restarts, readable by a phone-only user. |
| **Commands from the room** | `/matrix-*`, other extensions' commands and `/skill:` calls run when typed in the room — the full surface, membership-gated. (Pi built-ins like `/new` stay terminal-only.) |
| **Files between terminal and room** | `@` picks a workspace file for the agent from the room; `@@` attaches files the agent sends back. Markdown ↔ HTML formatting is translated both ways. |
| **Sub-agent visibility** | Background spawns and their results post to the room and fold into their spawn lines. |
| **Security by default** | End-to-end encryption support, secure terminal login, agent-owned account, credentials in a `0600` file. |

## Examples

**Steer from your phone:**

```
room  › ship the fix, run the tests first
terminal  [Matrix] ship the fix, run the tests first
room  🎯 Milestone: TODO progress: 2 of 3 done
room  💬 Pi: Tests green — pushing branch fix/auth-ttl.
```

![Demo: steer pi terminal session from Element X on phone; see milestones show](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-steer-from-phone.gif)

**Attach a file to Pi session:**

Since we don't have direct access to the file picker in the TUI, the matrix room shows files to choose pick from.
```
room  › what does @docs/spec.md say about retries?
terminal  [Matrix] what does docs/spec.md say about retries? (content attached)
```

![Demo: Attach a file to the Pi terminal session with fuzzy file picker](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-attach-file-to-terminal.gif)

**Upload a file to the matrix room:**

Want to see the contents of a project file? Upload it to the room - again with fuzzy file picker:
```
room >
terminal
room >
```

![Demo: Upload a file as an attachment to the Matrix room - again with fuzzy file picker](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-upload-file-to-matrix.gif)


**Answer a decision from the couch:**

```
room  🎯 Question: Ship now?  1) yes  2) not yet
phone › 1
terminal: questionnaire resolves, work proceeds.
```

Room reply grammar: option number(s)/label(s) (`2`, `2 3` for multi, `Custom: free text`), yes/no as `👍`/`👎`; a review step posts before proceeding — `confirm` to go.

![Demo: ask_user_question answered from the room while the terminal waits](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-ask-user.gif)

**Organize Pi sessions as Matrix threads**

Keep things organized by running a Pi terminal session as a threaded conversation.

![Demo: starting a new session results in a new, threaded conversation in Matrix](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-threads.gif)

**Watch your session get summarized**

The root message of a Matrix threaded conversation gets updated with a summary as the Pi session progresses.

![Demo: watch how the Matrix root message becomes the session summary, and gets updated as the Pi session progresses -> with key milestones, recent activity, latest & next, and Main Decisions](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-thread-summarization.gif)

**See subagents spawn and check back in**

![Demo: be notified when a subagent spawns, and when it checks back in with the result](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-sub-agent-events.gif)

**Remote terminal command invocation**

![Demo: ](https://raw.githubusercontent.com/r3dnl/pi-matrix-integration/main/docs/assets/demo-terminal-command.gif)

---

## Configuration

Precedence: **environment variables > config file > defaults**. Config lives at `<project>/.pi/matrix/matrix-config.json`(`.jsonc`) (or `~/.config/pi-matrix-integration/` globally); every key has a `PI_MATRIX_<UPPER_SNAKE>` override. A commented example with every key, enum value and default: [docs/user/matrix-config.example.jsonc](docs/user/matrix-config.example.jsonc).

| Setting | What it does | Default |
|---|---|---|
| `sendMilestones.enabled` | post progress milestones to the room | `true` |
| `sendFinalMessages.enabled` | post each turn's final answer (`💬 Pi: …`) | `true` |
| `piMatrixThreading.summaryCadence` | thread-summary pass every N messages (`0` = off) | `10` |
| `piMatrixThreading.useLlmForSummaries` | LLM summary vs. zero-cost heuristic line | `true` |
| `piMatrixRoom.endToEndEncryption` | encrypt rooms the extension creates | `true` |

One trap worth knowing early: a profile-suffixed file (`matrix-config.<profile>.jsonc`) is only read while that profile is active — the bare `matrix-config.json` is the live config.

---

## Reference

- [Commands](#commands) — the full surface the extension registers, table below.
- [Configuration reference](docs/user/configuration.md) — every key, default, effect and environment override.
- [Per-project setup](docs/user/per-project-setup.md) — one project : one room, the recommended layout, the `~/.pi` FAQ.
- [Ask-user pairing](docs/user/ask-user-pairing.md) — the question mirror's terminal patch.
- [Troubleshooting](docs/user/troubleshooting.md) — cannot connect, connected-but-silent, missing threads, decryption, stale summaries.
- [Roadmap](docs/user/roadmap.md) — what's coming in 1.0.0 and beyond.
- [Security posture](SECURITY.md) — what the room can do, what it cannot, how to report a vulnerability.
- [Developing](docs/dev/developing.md) · [Coding standards](docs/dev/coding-standards.md) · [Architecture](docs/dev/architecture/README.md) — for contributors and coding agents.

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

Aliases: `/pi-help` (= `/matrix-help`), `/matrix-summarize-thread` (= `/matrix-thread-summarize`).

Every extension command is reachable from the room: any room member can type it and it runs against your session, and the room relays slash commands from every installed extension (`/skill:*` included). There is no per-user allowlist — Matrix room membership is the access control. Pi's own built-in commands (`/new`, `/reload`) stay terminal-only. The three model-facing tools (`matrix_send_milestone`, `matrix_get_messages`, `matrix_update_thread_summary`) let Pi use the room on its own.

## Related

- [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) — the decision dialogues; this extension prompts for the one pairing patch it needs.
- [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents) — recommended sub-agent package: room-mode thread summaries and sub-agent visibility ride on a sub-agent extension being installed.
- [Element](https://element.io/) — threads are a Labs feature in Element X (iOS); Element Desktop shows threads in a panel.

## License

MIT — see [LICENSE](LICENSE). Attribution for Apache-2.0 dependencies: [NOTICE](NOTICE).
