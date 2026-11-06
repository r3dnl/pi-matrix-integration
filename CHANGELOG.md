# Changelog

All notable changes to `pi-matrix-integration` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Breaking changes to configuration keys or `/matrix-*` command names always
come with a major version bump.

## [Unreleased]

### Fixed

- A thread-summary pass that runs in the room-facing session (no summarizer
  sub-agent installed) no longer broadcasts its closing line — "Root
  unchanged.", "Up to date." — into the room every pass. The broadcast mute
  covered only the pass's first turn; it now covers the whole run, so a pass
  leaves exactly one room event: the thread-root edit. A message typed at the
  terminal while a pass runs lifts the mute, so a real question is never
  swallowed.

