# Changelog

All notable changes to `pi-matrix-integration` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to configuration keys or `/matrix-*` command names always
come with a major version bump.

## [Unreleased]

### Fixed

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
