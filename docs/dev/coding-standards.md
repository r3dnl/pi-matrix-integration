# Coding standards

Every rule below names its gate: the command, test or review step that enforces it. A rule with no gate is marked **(judgement)** — do not pretend otherwise, and do not add aspirational rules with no enforcement.

## Language

| Rule | Gate |
|------|------|
| TypeScript, strict mode, `noEmit`. Pi executes the sources, so there is no build output to keep in sync | `npm run typecheck` (being added in this release; until then **(judgement)**) |
| No `any` without a one-line reason next to it. Count reported in the PR body, never silenced by a rule disable | lint + review |
| Async work must be awaited or explicitly fire-and-forget with a comment saying why | `no-floating-promises` |
| No new module loads a second Matrix client. One identity, one writer | review, against the transport invariant |

## Logging and errors

| Rule | Gate |
|------|------|
| No ad-hoc `console.log` in `src/`. Runtime diagnostics go through the logger from `src/logger.ts`, so output lands in the log file the user is told about. Two exceptions, both structural: the logger's own console sink, and the startup lines that run before a log file exists (config migration, profile restore) | `grep -rn "console.log" src/` returns only `logger.ts` and the `[matrix]` startup lines |
| Never log an access token, password, passphrase, device id or room message body | code review + `test/security-boundary.mjs` |
| A tool result must not echo credentials or raw room content either | `test/security-boundary.mjs` |
| Transport and storage failures degrade: show it in the footer, log it, continue. Do not throw into Pi's event loop | review, against the soft-fail invariant |
| Reads of state files tolerate a missing or corrupt file; writes go to a temporary file and rename | the unread-model and threading tests |

## Comments

The tree carries roughly 1 900 line comments and 770 doc blocks. That is a deliberate choice: this extension is maintained by one person and read by agents, so the reasoning has to live next to the code. With that volume, stale comments are the main hazard, so:

| Rule | Gate |
|------|------|
| A comment says **why**, not what. A comment that restates the line below it is deleted | review |
| A reference must resolve to something that ships with the package — a file in `docs/`, or code by path and symbol. No pointer to a private document | `node test/docs-consistency.mjs` |
| `ponytail:` marks a shortcut with a stated ceiling. The ceiling must still be true; if the constraint has gone away, delete the marker along with the shortcut | review |
| No commented-out code. Delete it; git remembers | review |
| `@param` / `@returns` blocks that repeat the signature are removed | review |
| `KNOWN GAP` marks a real, verified limitation and must be mirrored in the architecture doc | review |
| No internal hostnames, account names or environment names anywhere in the shipped tree — examples use `matrix.example.org` | `test/docs-consistency.mjs` denies the known internal names; review catches new ones |

## Structure

| Rule | Gate |
|------|------|
| `src/integration.ts` is the only composition root. Modules receive dependencies; they do not reach into each other | review |
| Cross-module signalling goes through the domain events in `src/events.ts`, not a new import edge | review |
| One write path (`src/outbox.ts`), one read path (`src/inbound.ts`). Anything else is a second writer | review |
| Four files exceed 1 000 lines (`sdk-client.ts`, `config-utils.ts`, `integration.ts`, `ask-user-mirror.ts`). That is known debt; do not create a fifth | review |
| A `src/` module that is unreachable from the registration graph is deleted, not left commented | dead-code pass in review |
| A config key nothing reads is deleted, not documented | config-consistency test |

## Tests

| Rule | Gate |
|------|------|
| Behaviour changes come with a test in the right tier: deterministic in the offline tier, anything touching a real room in the live tier | review |
| Live tests assert on fetched room state, never on internal variables | review |
| No test framework. Add scripts to the shared runner in `test/_harness.mjs` | review |
| A live script fails loudly when its credentials are missing, naming the variable | the tier guard |

## Naming

| Rule | Gate |
|------|------|
| Modules are named for what they own (`threading.ts`, `outbox.ts`), not for a layer (`manager.ts`, `utils.ts`) | review |
| Public identifiers never carry the maintainer's internal project or environment names | the hostname and internal-name scan |
| A `/matrix-*` command's name says what it switches; two commands must not read the same in the palette | README command table + `/matrix-help` equality test |
| Config keys are dotted, lowercase and stable: a rename is a breaking change after 1.0.0 | review, semver gate at release |

Commands and configuration follow three rules, recorded in [architecture: configuration and room behaviour](architecture/configuration-and-room-behaviour.md#rules-that-govern-the-command-surface): the config file is the declarative surface, commands invoke functionality, and anything needed away from the terminal must be a command.

## Commits and review

| Rule | Gate |
|------|------|
| Conventional Commits with a scope: `fix(matrix): …`, `feat(matrix): …`, `docs(dev): …` | review |
| One unit per commit. A revert must undo one decision | review |
| No drive-by refactors inside a functional change | review |
| Before a release, `src/` walks the review checklist: dead, wrong, duplicate, wrong place, wrong type, vague name, speculative. One unit at a time, grep evidence per finding | the review document |
| Anything the reviewer flagged and the maintainer declined is written down with the reason | `docs/decisions/DECISION-LOG.md` |

## Definition of done, for any change

1. Gates green: `npm test`, `npm run test:logic`, and `npm run test:live` when the change is visible in a room.
2. User-visible behaviour documented in `docs/user/`, and any new invariant in the matching architecture topic.
3. `CHANGELOG.md` entry under Unreleased.
4. No comment left pointing at a document that does not ship.
