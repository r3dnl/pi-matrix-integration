# Changelog

All notable changes to `pi-matrix-integration` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to configuration keys or `/matrix-*` command names always
come with a major version bump.

## [1.0.0] - 2026-11-03

First public release.

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
