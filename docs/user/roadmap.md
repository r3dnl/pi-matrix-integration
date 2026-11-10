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
- [ ] release the `mtx` account tool — the live-tier account manifests
  (`test/live/accounts-manifest.example.json`) are written in its format;
  it is maintainer-local today, releasing it lets others provision their
  own live-tier test accounts
- [X] default to `"@tintinweb/pi-subagents"`


## Candidates for 0.10.0

- [ ] BUG - Decision Dialogue - sometimes with the lead-in user message gets shown before the ask_user_question dialogue (correct) and then repeats again after the dialogue has been answered (incorrect).
- [ ] BUG - `"pi-subagents"` fix (dependency upstream) -> this impacts also the summarizer thread that bleeds into the main terminal session (note: `"@tintinweb/pi-subagents"` recommended for now)
- [ ] IMPROVEMENT - Config writes must follow the `last-active-profile`
  pointer — only the active profile file may be seeded or rewritten. Observed
  2026-11-08: after a Pi restart the login prompt reappeared — the base
  `matrix-config.jsonc` had `credentialsPath` set to the
  `{pi-matrix-username}--{matrix-domain}` template default (a value the user
  never wrote; the profile file still carried the real path), so the restart
  lost the login. Addendum same day: the prompt itself was traced to the
  `parseJsonc` URL bug (comment sweep ate the `//` in an `http://` value —
  fixed, `test/config-contract.mjs`); the template `credentialsPath` in the
  base file remains real evidence that the base file received writes it
  should not have. Suspects are the config write sites that operate on a whole
  document rather than the active profile: the v1→v2 conversion writes
  (`src/config.ts:560/621/624`), the seed-keys write (`src/config.ts:687`) and
  the persist paths (`src/config-utils.ts:924/1104`). Planned shape: treat
  `last-active-profile` as the single pointer; a new config key gets seeded
  only into the file it names — never a scan-and-update-every-file sweep. On
  `/matrix-switch` the pointer moves; seeding then fills only keys that are
  missing in the newly active profile, and a key that already carries a value
  is never overwritten. Open question: once the base `matrix-config.jsonc`
  stops receiving writes, what is its intended role — pure fallback identity
  for the first login, or obsolete?
- [ ] TECH-DEB - delete config tiers 3 and 4 from `resolveConfigPath`
  (`src/config-utils.ts:611-620`). Today the resolver tries, in order: an
  explicit path, `<cwd>/.pi/matrix/matrix-config.json`(`.jsonc`),
  `<extension-dir>/config/`, `~/.pi/agent/extensions/pi-matrix-integration/config/`,
  and `~/.config/pi-matrix-integration/config.json`(`.jsonc`). Tiers 3 and 4
  are not a config surface a user can rely on: in a development install they
  are one and the same directory, and because the extension is a symlink into
  a source tree there, a config seeded at tier 3 is written into a git working
  tree. In the npm install most users get, `getExtensionDir()` resolves inside
  Pi's package cache (`~/.pi/agent/tmp/extensions/`), which Pi reinstalls
  whenever the registry has a newer matching version — so a room, a
  credentials path or a profile sitting there is deleted by an update with no
  error, and the session falls back to defaults — the same lost-login symptom
  the profile-pointer bug above produced. Pi itself documents no
  user-level config directory for extensions (its only persistence surface is
  the session transcript, per session rather than per machine), so these two
  tiers are this extension's own invention with no directory convention behind
  them. Shape: resolve to explicit path → project file → `~/.config` file →
  defaults, and document those as the whole surface. Decision first: whether a
  release should warn when a file exists at a deleted tier, or whether we simply
  drop it and let the moved file be found where it is expected.
- [ ] BUG / IMPROVEMENT - Thread mismatch detection: warn user if matrix messages come from a non-active thread (how to reproduce: start a new Pi session that spawns a fresh thread; in matrix open an old thread and send a message)
- [ ] IMPROVEMENT - `/matrix-status` shows the summarizer mode. Today a missing
  summarizer sub-agent drops the room into the in-session fallback silently: the
  warning is a log line only, so the room keeps working and nobody sees the
  degraded mode. Planned line: `summarizer: unavailable — in-session fallback
  (install a pi-subagents dialect)`.
- [ ] IMPROVEMENT - 2 pi agentic sessions on the same matrix room leads to delivery of "ghost" messages in one of the terminal sessions -> can this be avoided / detected?
- [ ] IMPROVEMENT - Prettier formatting for tables in Element X for phone/tablet
- [x] IMPROVEMENT - a better, standard welcome tour with a strict runbook that takes the user along in all features
- [ ] IMPROVEMENT - store matrix credentials under `{project-root}/.pi/matrix/credentials/...` *BUT WARN IF NOT GITIGNORED!*
- [ ] IMPROVEMENT - when resuming a session, mark the milestone in the thread with `🎯 Milestone: Pi resumed this session`
- [ ] IMPROVEMENT - poll for `@file` selector menu
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
- [ ] IMPROVEMENT - Command-surface redesign — recorded, not started. Known items: the duplicate `/matrix-summarize-thread` alias, the `matrix-toggle` / `matrix-thread-toggle` naming collision, and several commands that toggle state the config file already owns. Bound by three rules: the config file is the leading declarative description of behaviour; commands invoke functionality and never store preferences; anything a user needs away from the terminal must be a room-reachable command. Also: consider if `matrix_send_milestone`, `matrix_get_messages`, `matrix_update_thread_summary` are still needed, or we should just strip them.
- [ ] TBD - auto-upload of markdown/feature files as attachments for inspection.
- [ ] TBD - Activity-based summarizer watchdog: abort runs that stream nothing, instead of waiting out the completion budget.
- [ ] FEATURE - test and optimize for bridged clients (whatsapp, discord, ...)

## (post) v1.0 ideas

- [ ] FEATURE - Inter agent communication
- [ ] IMPROVEMENT - see archify project: with code of conduct etc
- [ ] FEATURE - QR code login (dependency upstream)
- [ ] Support `/new`, `/reload`, … from the room
- [ ] New Matrix client optimized for agentic coding (Pi) -> mobile agentic IDE
