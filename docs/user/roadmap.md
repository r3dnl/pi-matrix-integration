# Roadmap

What the maintainers intend to build. Facts about what exists today are in
the [README](../../README.md); this page is intent, not status.

## Candidates for 0.9.1
- [x] EXPLAIN - role of the maintainer test harness -> the harness was
  later removed; `docs/dev/developing.md` documents the live tier that
  proves the release artifact today.
- [x] BUG - `agents/pi-matrix-integration-thread-summarizer.md` -> reference to extension `local-llm` (removed; the agent is tool-less and extension-less)
- [x] BUG - starting a new terminal session, and then beginning in matrix leads to a thread that does not capture the original ask to user, but instead has `🧵 New Conversation` (fixed: `src/inbound.ts` opens the root from the room with the ask as topic; `test/room-thread-root.mjs`)
- [x] BUG - opposite to the above: start with something like `/archify ...` and the message root is really long; I suspect when the contents of a file get attached (basically the full markdown) (fixed: `sanitizeThreadTopic` in `src/threading.ts` — first line, 120-char word-boundary cap)
- [x] state for unread is tracked in `unread-{env}.json` -> split per project? (done: a project-local config moves all state — `unread-<homeserver>.json`, seen files, thread map — to `<project>/.pi/matrix/state/`; the old `{env}` names predate the homeserver-domain keying)
- [x] remove the harness folder -> confusing for users (resolved: the
  container harness and its Makefile are gone. The nightly workflow runs
  the live tier directly; the cold-install check is a five-minute manual
  release step)
- [ ] default to `"@tintinweb/pi-subagents"`


## Candidates for 0.10.0

- [ ] BUG - `"pi-subagents"` fix (dependency upstream) -> this impacts also the summarizer thread that bleeds into the main terminal session (note: `"@tintinweb/pi-subagents"` recommended for now)
- [ ] BUG / IMPROVEMENT - Thread mismatch detection: warn user if matrix messages come from a non-active thread (how to reproduce: start a new Pi session that spawns a fresh thread; in matrix open an old thread and send a message)
- [ ] IMPROVEMENT - Prettier formatting for tables in Element X for phone/tablet
- [ ] IMPROVEMENT - a better, standard welcome tour with a strict runbook that takes the user along in all features
- [ ] IMPROVEMENT - store matrix credentials under `{project-root}/.pi/matrix/credentials/...` *BUT WARN IF NOT GITIGNORED!*
- [ ] FEATURE - concurrent sharing of one Matrix account across projects. Today the
  account directory holds the token, the Olm crypto store and `pi-matrix.lock`, so a
  second Pi session on the same `credentialsPath` fails soft by design (two Olm
  instances over one device fork the double-ratchet → "Unable to decrypt message").
  To run two projects at once on one identity: per-project `cryptoStoreDir` plus a
  distinct `deviceId` per project, and the lock must key on the store rather than the
  account dir. Scope question first: is one shared agent account a supported
  deployment, or should each project keep its own account (the current default)?
  FAQ: docs/user/per-project-setup.md.
- [ ] TECH-DEB - 1 central place for all icon constants, like 🧑 (and others as well)
- [ ] IMPROVEMENT - Command-surface redesign — recorded, not started. Known items: the duplicate `/matrix-summarize-thread` alias, the `matrix-toggle` / `matrix-thread-toggle` naming collision, and several commands that toggle state the config file already owns. Bound by three rules: the config file is the leading declarative description of behaviour; commands invoke functionality and never store preferences; anything a user needs away from the terminal must be a room-reachable command.
- [ ] TBD - auto-upload of markdown/feature files as attachments for inspection.
- [ ] TBD - Activity-based summarizer watchdog: abort runs that stream nothing, instead of waiting out the completion budget.
- [ ] FEATURE - test and optimize for bridged clients (whatsapp, discord, ...)

## (post) v1.0 ideas

- [ ] FEATURE - Inter agent communication
- [ ] IMPROVEMENT - see archify project: with code of conduct etc
- [ ] FEATURE - QR code login (dependency upstream)
- [ ] Support `/new`, `/reload`, … from the room
- [ ] New Matrix client optimized for agentic coding (Pi) -> mobile agentic IDE
