# Changelog

All notable changes to `pi-matrix-integration` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to configuration keys or `/matrix-*` command names always
come with a major version bump.

## [Unreleased]

### Fixed
- A conversation that starts in the Matrix room (flat message, new session)
  now opens the thread with the ask as its topic; previously the first reply
  created a bare `🧵 New Conversation` root and the original message stayed
  outside the thread.
- Thread root titles are sanitized: first line, collapsed whitespace, capped
  at 120 characters on a word boundary — a prompt carrying an attached
  markdown document (e.g. `/archify …`) no longer produces a page-long root.
- The shipped thread-summarizer agent definition no longer references a
  maintainer-local `local-llm` extension path (it runs tool-less and
  extension-less; the model comes from `piMatrixThreading.summarizeModel`).
- Lifecycle milestones (session start/stop, compaction, model and
  thinking-level changes, TODO progress) no longer bleed a raw-JSON
  `Details:` tail into the room. Since the milestone-payload fix they carried
  internal routing markers (`{"type":"session"}` …) in the metadata bag, and
  the formatter printed whatever was attached. The markers — nothing reads
  them — are gone from the call sites; a payload sent via
  `matrix_send_milestone` still arrives as a `Details:` block.

### Changed
- `subagents.provider` now defaults to `"tintinweb"` (`@tintinweb/pi-subagents`).
  The `"auto"` setting still probes and flips to the `nicobailon` package
  when `@tintinweb` is silent, but that package carries an upstream
  wake-handling bug (roadmap 0.10), so the flip is no longer the default.
- The cold-install proof is a named release step: `npm run test:release`
  installs the packed tarball in a clean container and runs the live tier
  there (Docker plus the `PI_MATRIX_*` test credentials; the nightly
  workflow already runs it). The harness itself is unchanged; every
  Docker mention is now gone from the user-facing docs —
  `docs/dev/developing.md` remains the developer reference.

### Documentation
- `docs/dev/developing.md`: the release checklist gained the cold-install
  proof step; the user-facing docs no longer reference the harness.

## [0.9.0] - 2026-11-04

First public beta — the 1.0.0 feature set, published for real-world trial.
Breaking changes between this and 1.0.0 will be recorded here.

### Added

- Connect a running Pi session to a Matrix room: `/matrix-connect` walks a
  guided login (password or QR sign-in where the homeserver supports it)
  and can create the room for you.
- Send work to the agent from the room: chat messages reach the running
  session, with `/matrix-*` commands for status, connection and control.
- Outgoing progress: milestones, final answers and decisions appear in the
  room as the session works; the `sendMilestones` and `sendFinalMessages`
  toggles choose what is posted.
- Question mirror: when Pi asks a question through `ask_user_question`,
  the question is posted into the room and the answer comes back from
  there — you can drive the session from your phone.
- Threads: milestones and summaries group into Matrix threads; a scheduled
  thread summarizer keeps each thread's root post current
  (`@juicesharp/rpiv-ask-user-question` and a subagent extension are
  optional for the full experience — see `docs/user/ask-user-pairing.md`).
- File round-trip: attach a file to your message and the agent sees it;
  request a file and the agent uploads it back.
- Voice: hold-to-talk voice messages when the optional voice engine is
  installed.
- Multi-profile support: run several room sessions from one Pi install
  (`/matrix-switch`).
