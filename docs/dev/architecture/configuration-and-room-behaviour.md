# Configuration and room behaviour

Covers: how the extension finds its config, how profiles work, how the room drives the agent, and where the security boundary sits.

## Finding the configuration

`resolveConfigPath` in `src/config-utils.ts` walks a fixed list and returns the first file that exists. Both `.json` and `.jsonc` are accepted at each step, which is why a project config may be commented.

| Order | Location | Meaning |
|-------|----------|---------|
| 1 | the `configPath` value passed in | explicit override |
| 2 | `<cwd>/.pi/matrix/matrix-config.json[.c]` | project-local config, wins over everything below |
| 3 | `~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json[.c]` | the install's default config |
| 4 | `~/.config/pi-matrix-integration/config.json[.c]` | user-level config |

`isActiveConfigProjectLocal` tells the rest of the code which world it is in, because project-local and global configurations carry credentials in different places. `getActiveConfigDir` returns the directory of whichever file won, and that is where profile state is written.

The schema is `ConfigV2` in `src/config.ts`: an identity block, a connection block, a room block, logging, threading, sub-agents, and feature sections that each have their own `enabled` toggle. `resolveStartupConfigWithMigration` in `src/integration.ts` migrates an older file on startup rather than requiring a manual rewrite.

**Every key is overridable by environment variable.** There are 69 `PI_MATRIX_*` names in `src/` — `docs/user/configuration.md` is the generated reference. The convention matters more than the list: an environment value beats the file, which is how CI passes credentials without writing a file.

## Profiles

A profile is a named config file in the active config directory (`matrix-config.<profile>.json`), holding one homeserver, one agent account and one room. `/matrix-switch` swaps profiles at runtime without restarting Pi; the last choice is remembered so the next start comes back to it. This exists so switching between, say, a test homeserver at `matrix.example.org` and a production one is a profile change rather than an edit.

Credentials are never in a profile file. They live in a per-project, per-account store:

```text
~/.config/mtx/projects/<project>/accounts/<user>--<domain>/credentials.json
```

built by `getProjectCredentialsPath`, written with mode `0600`. A profile names who to log in as; the credential store holds the token.

## How the room drives the agent

```mermaid
sequenceDiagram
  participant U as Room member
  participant IN as inbound.ts
  participant MH as message-handler.ts
  participant CR as command-relay.ts
  participant PI as Pi session
  U->>IN: room event
  IN->>MH: single dispatch point
  MH->>PI: plain text, attributed as [Matrix]
  MH->>CR: message starting with /
  CR->>PI: invoke registered command
  PI-->>U: milestones, thread, answers
```

Four behaviours are worth knowing before you change anything here:

- **Attribution is not optional.** Anything that came from the room is marked `[Matrix]` in the terminal, so a session transcript always shows where input originated. `isPiMachineTraffic` in `src/message-handler.ts` keeps the extension from reading its own postings as user input.
- **Slash relay.** A room message that starts with `/` is offered to Pi's command registry, which means skills and other extensions' commands are reachable from the room. See the security note below.
- **Attach protocols.** `@` picks a file for inline inclusion (`src/file-attach.ts`, prefixes `PI_MATRIX_FILE_ATTACH_PREFIX` and `PI_MATRIX_FILE_PICKER_PREFIX`), `@@` attaches an artifact produced by the session (`src/artifact-attach.ts`). Two prefixes because two different intents.
- **Footer state.** `src/tui-footer.ts` shows connection status, the homeserver and the room, and whether threading is on, so the terminal always tells you what the extension believes.

## Answering questions from the room

`src/ask-user-mirror.ts` mirrors Pi's `ask_user_question` questionnaire into the thread and reconciles the answer, whichever surface completes first. The reply grammar is deliberately small: option numbers, `Custom: …` for free text, 👍/👎 for yes-no, and a review step that echoes what will be submitted before it is submitted. The mirror's state is flushed at `message_end` so a question cannot stay open in the room after the terminal has moved on.

Race semantics are part of the contract: the first complete answer wins, the losing surface is told it lost, and a partial answer never overrides a complete one.

## Sub-agent reporting

Delegated runs are reported into the thread so a phone user can follow fan-out. The problem is that the sub-agent packages do not agree on tool names or completion notices, so the extension puts a contract in the middle:

| Module | Role |
|--------|------|
| `src/subagent-provider.ts` | the contract: what a spawn looks like, what a completion looks like |
| `src/subagent-providers/` | one adapter per dialect — the `@tintinweb` shape and the `pi-subagents` shape |
| `src/subagent-providers/resolve.ts` | auto-detection: it tries a dialect and binds the one that actually answered, then tells you to set `subagents.provider` explicitly if you want determinism |
| `src/watchers.ts` | normalises `tool_call` / `tool_result` into spawn and identity records |
| `src/subagent-bus.ts` | posts the normalised records into the room, assigning palette colours |

Nothing here requires a sub-agent package. Without one, the features that need a spawn degrade — thread summarisation falls back to its in-session path, as described in [threads and summaries](threads-and-summaries.md).

## Security posture

Anything posted in a connected room becomes model input, and every registered command — including `/skill:` and other extensions' commands — is reachable from the room by any room member. There is no per-message authorisation in the Matrix client-server API that could narrow this, so:

- the room's **membership list is the security boundary**: invite-only, and the agent gets its own account, never yours;
- the relay adds no execution power of its own — it calls Pi's own command registry and must not skip Pi's own confirmation for anything that mutates your working tree. `test/security-boundary.mjs` asserts that, and `SECURITY.md` states the consequence in user terms.

The same document carries the dependency inventory and the disclosure contact.

## Rules that govern the command surface

When a `/matrix-*` command is added, renamed or removed, these three rules decide it:

1. The configuration file is the leading, declarative description of extension behaviour.
2. `/matrix-*` commands invoke functionality — they are not a place to store a preference.
3. Anything you need while away from the terminal must be reachable from the room, so it must exist as a command.

Rule 1 and rule 2 are why toggling behaviour at runtime and configuring it permanently are different surfaces. The redesign issue tracks the places where the current commands violate them.
