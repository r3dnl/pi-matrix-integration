# Developer documentation

Index of everything a developer or coding agent reads in this repo.

## Getting started and daily loop

| Document | Covers |
|----------|--------|
| [Developing](developing.md) | the dev loop: setup, what to run when, how CI is laid out, architecture pointers |
| [Coding standards](coding-standards.md) | every rule with its enforcement gate, plus branching, releases and semver practice |
| [AGENTS.md](../../AGENTS.md) | the working contract for coding agents: the loop, the never-rules, scope discipline |

## Architecture

[architecture/README.md](architecture/README.md) is the tree root — read
it before a change that crosses modules; each topic ends with its
invariants.

| Document | Covers |
|----------|--------|
| [Design principles](architecture/DESIGN-PRINCIPLES.md) | the cross-cutting rules and what enforces each |
| [Transport, identity and state](architecture/transport-and-state.md) | the Pi ↔ extension ↔ homeserver chain, login and credentials, encryption keys, on-disk state |
| [Threads and summaries](architecture/threads-and-summaries.md) | session-to-thread mapping, summary cadence, the loop guards |
| [Configuration](architecture/configuration.md) | config resolution order, profiles, credential store |
| [Room behaviour](architecture/room-behaviour.md) | how the room drives the agent, questionnaire mirror, sub-agent dialects, security posture, command-surface rules |

## Testing

| Document | Covers |
|----------|--------|
| [test/README.md](../../test/README.md) | the QA runbook: the three rings, setup, GitHub Actions, triage |
| [test/live/README.md](../../test/live/README.md) | the live-tier walkthrough: one line per named scenario |

## Repository root

| Document | Covers |
|----------|--------|
| [README.md](../../README.md) | what the extension is, commands, user-facing surface |
| [QUICKSTART.md](../../QUICKSTART.md) | install to connected room in one sitting |
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | the dev loop for outside contributors |
| [SECURITY.md](../../SECURITY.md) | the trust boundary, dependency inventory, disclosure contact |
| [CHANGELOG.md](../../CHANGELOG.md) | release history in Keep a Changelog style |

User-facing documentation lives under [docs/user/](../user/).
