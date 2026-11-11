# Changelog

All notable changes to `pi-matrix-integration` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to configuration keys or `/matrix-*` command names always
come with a major version bump.

## [Unreleased]

### Added

- A transcribed voice message now answers in the room: `🗣️ <transcript>`
  with the engine named underneath — the configured remote model id, or the
  local model directory suffixed `(local)` — so the sender sees what was
  understood and by what. The echo follows the same threading logic as any
  other send: into the voice message's thread, or the thread the message
  opens (see Fixed). The session injection is unchanged.
- Voice transcription can now use a remote STT endpoint first: setting
  `matrixToPiVoiceTranscription.sttBaseUrl` (env `PI_MATRIX_STT_BASE_URL`,
  plus `sttModel`/`PI_MATRIX_STT_MODEL`) POSTs the voice clip to an
  OpenAI-shaped `{base}/audio/transcriptions` — e.g. an mlx-audio server on
  the LAN — before the local Whisper engine runs. Any remote failure
  (timeout, non-200, empty text, unreachable) falls back to the local
  chain: the endpoint is an optimization, never a dependency. Unset by
  default — local-only, exactly the old behavior.
- A voice message that cannot be transcribed now answers the sender in the
  room — `⚠️ Voice message not transcribed: <reason>` — instead of being
  dropped with only a bridge-log line. Reasons are classified
  (missing/corrupt media, failed download, ffmpeg not installed, too long,
  no speech, engine unavailable); internal error detail stays in the log.
  The README now lists `ffmpeg` as a pre-requisite: it is the one system
  binary voice transcription needs (ogg/opus → PCM for the local Whisper).

### Changed

- `/matrix-help` (and its alias `/pi-help`) is now a reference card instead of
  a prose walkthrough — the guided version is `/matrix-introduction-tour`, so
  the guide no longer re-explains features. It lists what the room accepts
  (plain text, `/commands`, `@` picker, `@@` attach, voice notes, the decision
  reply grammar, `help`) and every command the extension registers in a table
  whose last column says where the answer shows up: room or terminal. That
  split was the guide's blind spot — typing `/matrix-status` from the room
  looks like silence. It closes by saying where behavior is actually changed:
  the config file, the `~/.config` file that covers projects without one, the
  `PI_MATRIX_*` overrides — and links the configuration reference for the key
  list rather than copying it, so there is one source to keep current. Which
  tiers to name was worth the argument: the README called
  `~/.config/pi-matrix-integration/` the global location and the first cut of
  this change replaced it with the extension directory, which is worse. That
  directory only exists in a development install, where the extension is a
  symlink into a source tree; an npm-installed extension is cached under
  `~/.pi/agent/tmp/extensions/` and reinstalled whenever the registry has a
  newer matching version, so a file written inside the package does not
  survive an update. Pi documents no user-level config directory for
  extensions — its only persistence surface is the session transcript, per
  session rather than per machine. The guide and README now name the two
  tiers a normal user can actually rely on, and `docs/user/configuration.md`
  says why its tiers 3 and 4 are not a place to keep config. Formatting is
  markdown (two GFM tables, code spans) rather than plain prose, so the
  `sendFormatted` gate renders it and plain-text clients keep it readable;
  the guide stays HTML-free by design.
- The introduction tour shows instead of tells, and stays a dummy
  interaction. The decisions step no longer embeds a look-alike of a
  questionnaire: it explains, then the tour opens a REAL questionnaire on the
  ask-user mirror — questionnaire, tappable poll, living review and all —
  under a synthetic tool-call id, so the room's answer ends the demo instead
  of resolving a parked tool call and never enters the answer channel. An
  unanswered demo expires after 10 minutes, and a real decision or a replayed
  tour supersedes it; either way the count of open decisions the demo's
  post took is released. The sub-agent step is followed by the two lines the
  production formatters build (`⚡ Spawn subagent…`, tinted by type, then
  `⚡ Agent result:`), built from the live `piMatrixSubagents` settings; no
  bus record is written, so `/matrix-subagents` still lists only real spawns.
  No model turn starts for any of it — the same guarantee as before, now
  pinned by `test/login-wiring-check.mjs`.
- Every introduction-tour step now has the same shape: a bold blue topic
  line, part A (what the feature is) and a green part-B line saying exactly
  what to type to try it (`Try it: /matrix-help`). Steps are no longer
  numbered, literals render as `code`, and the tour carries two fenced
  blocks — a Matrix message event as `json` and the `TourEntry` type behind
  the tour itself as `ts` — so Element's syntax highlighting shows. The
  slash-command step states the split the room cannot guess: a room-typed
  command runs in the terminal and most answer there only, so the step
  contrasts `/matrix-help` (arrives here) with `/matrix-status` (terminal
  only), and the controls step lists both groups. Sub-agents and threads now
  say how to provoke them: ask Pi for a sub-agent, or start a fresh session
  with `/new` and watch a new thread open. The tour closes with what to do
  next: type a message about the topic you want to talk about. The script grew
  from 9-to-11 steps to 12-to-15 (the three existing config toggles, plus the
  two sub-agent demo lines behind `piMatrixSubagents.enabled`). Each step ships
  pre-built HTML as `formatted_body`, so the formatting survives
  `sendFormatted: false` — the plain body carries the same words.
- The introduction tour is scripted. `/matrix-introduction-tour` and the
  `/matrix-login` tour offer now play a fixed 9-to-11-step runbook
  (`src/tour.ts`) — every message exact, posted by code in a fixed order,
  the same sequence in every room (conditional steps follow the live
  `remoteFilePicker` / `fileAttach` / `voiceTranscription` toggles). The
  LLM is no longer in the tour loop: no prompt is injected, the agent is
  never woken, and its own echo guard drops the tour's room events on the
  way in. Previously one canned prompt let the agent improvise the content,
  count and order of tour messages fresh every run.

### Fixed

- A question queued while the previous run settled is no longer swallowed
  when a thread-summary directive opens the next run. The run-scoped
  summary mute armed on the directive and the escape hatch only lifted on a
  human `message_end` arriving after the mute — so the agent answered in the
  terminal and the room got nothing (the third recurrence of the
  "agent went quiet" family, reported 2026-11-10). Human input is now
  recorded on arrival regardless of mute state and a directive-started run
  begins already-lifted when a question is pending: the answer ships, the
  summary's leftover report-out stays booked as bookkeeping.

- A decision poll that throws no longer eats the decision. `postPoll` was
  awaited unguarded, so a poll transport that raised (rather than returning
  `{success: false}`) escaped `onPrompt` and took the whole questionnaire
  with it — the table, the reply grammar and the terminal's copy of the
  question. A poll is an extra affordance over the text grammar, so a failure
  now costs only that question's poll: the room logs it and still posts the
  questionnaire.

- Voice messages now thread like text. Previously the transcript echo was
  forced flat (room root) even when the voice message sat in a thread, and
  a first-message voice note opened a thread whose topic was the recording
  filename (`🧵 voice-message-recording.ogg`). Now: a voice message inside a
  thread gets its transcript echoed into that same thread, and a voice
  message that opens a new thread names the transcript (with the normal
  120-char word cut) as the topic — same as a typed ask or a `@{file}`
  attachment. The `⚠️` failure notices route the same way.

- `parseJsonc` no longer deletes `//` inside string values. The comment
  sweep was a plain regex, so a config value containing a URL (`"sttBaseUrl":
  "http://…"`) corrupted the document: unterminated string, un-loadable
  config, the active-profile pointer silently falling back to the
  placeholder identity, a login prompt on restart, and a failed
  `/matrix-switch`. Stripping is now a string-aware one-pass scanner
  (line + block comments, escaped quotes); pinned by six checks in
  `test/config-contract.mjs`.

- The leftover closing line of a thread-summary pass whose broadcast mute was
  lifted by a mid-pass room question no longer dispatches a wasted summary
  pass. In the no-subagent fallback the pass and the human answer share one
  run, and no signal separates the pass's "Root unchanged." from the answer
  — so the lifted run now books every final as non-content (the existing
  wake-answer mechanism): each message still reaches the room, none re-arms
  the summary. A summary is delayed at most one post, never lost — the
  content-based cadence gate catches up.
- A question sent from the Matrix room while a thread-summary pass is running
  in the room-facing session no longer loses its answer. The pass's broadcast
  mute lifted only for terminal-typed input; a relayed room message is
  injected as a custom message, failed that check, and the turn answering it
  was dropped in silence. A room relay is now recognised as human input like
  a terminal message, so the answer broadcasts normally; the pass's own
  directive and wake notices still cannot lift the mute. Muted drops now also
  log the first 80 characters of the swallowed text, so a quiet-agent report
  is answerable from the log alone.
- A milestone sent with details no longer dumps raw JSON into the room. The
  `matrix_send_milestone` tool's `details` object was printed under the
  milestone as an indented `Details: { … }` block — unreadable at a glance, bad
  on a phone, and a value the JSON writer refuses (a circular structure) threw
  inside the formatter and lost the milestone. Facts now render as up to four
  `- key: value` bullet lines under the milestone (markdown, so the room shows a
  list and plain-text clients keep the facts), the parameter says what it is
  for, and the outgoing-metadata bag is routing-only again.
- `piMatrixThreading.threadSummaryEvery` below 1 no longer
  spins the Fibonacci summary schedule forever (`summaryDue` step is
  `min(a, cap)` = 0); such a cadence now simply never fires the summarizer.
- Account-lock reclaim during connect no longer hot-spins when a stale
  `pi-matrix.lock` file cannot be deleted (read-only or permissioned state
  dir): after 5 failed reclaim attempts the session logs the give-up and
  does not connect, like every other lock conflict path.
- A thread-summary pass that runs in the room-facing session (no summarizer
  sub-agent installed) no longer broadcasts its closing line — "Root
  unchanged.", "Up to date." — into the room every pass. The broadcast mute
  covered only the pass's first turn; it now covers the whole run, so a pass
  leaves exactly one room event: the thread-root edit. A message typed at the
  terminal while a pass runs lifts the mute, so a real question is never
  swallowed.
- A rejected thread-summary edit no longer posts the summary as a second,
  separate room message. The edit is retried once; if the server still refuses,
  the pass gives up quietly and leaves the root and its delta watermark
  untouched, so the next pass folds the same messages in. The old fallback put a
  copy of the summary beside a stale root and marked those messages as already
  summarized — a gap the root never recovered.
