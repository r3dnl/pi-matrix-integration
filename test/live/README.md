# Live scenario suite — human walkthrough

`npm run test:live` runs the 14 scenarios headlessly against a real
homeserver and writes evidence to `artifacts/live-<run-id>/`. A machine
assertion proves the room received the right thing; this file proves what a
human sees in Element. Do this pass once per release, next to a scenario run,
and record what you saw for the demo file.

## Before you start

1. Export the live credentials (see `docs/dev/developing.md`, "Running the
   live tier"). The suite drives three actors:
   - **agent** — `PI_MATRIX_HOMESERVER`, plus `PI_MATRIX_USERNAME` and
     `PI_MATRIX_PASSWORD`.
   - **second actor** (the human seat) — `PI_MATRIX_SECOND_TOKEN`, or
     `PI_MATRIX_SECOND_USER` + `PI_MATRIX_SECOND_PASSWORD`.
   - **reader** (crypto) — on an E2EE-by-default homeserver the suite
     also reads through a real encrypting client:
     `PI_MATRIX_READER_CREDENTIALS` (see developing.md).

   Any of these may instead come from a `credentials.json` path —
   `PI_MATRIX_PRIMARY_CREDENTIALS` / `PI_MATRIX_SECOND_CREDENTIALS` —
   the same file shape the extension's login commands write.

   The two throwaway accounts are provisioned via an mtx manifest;
   template: `test/live/accounts-manifest.example.json`.
2. Run `npm run test:live` and keep the run's room name from the first log
   line (`live-e2e-<id>`).
3. Open that room in Element **with the second actor's login** — the phone
   user's view. Never the agent account: the point is what a room-only
   reader sees.

## Walkthrough (one line per scenario)

| # | Scenario | What to look for in Element |
|---|----------|------------------------------|
| 1 | milestone out | a `🎯 Milestone:` line in the room mainline |
| 2 | TODO progress | a `🎯 Milestone: TODO progress: …` line |
| 3 | turn-final | a `💬 Pi:` line with the turn's final answer |
| 4 | message in | your own posted question sits there attributed; the terminal (agent machine) shows it as `[Matrix] …` |
| 5 | ask_user mirrored | the questionnaire post appears; reply `1` in the room — the terminal-side question resolves |
| 6 | answered-first-wins | after the terminal answered, your room reply does NOT start a second answer — the questionnaire closes silently |
| 7 | thread per session | two `🧵 New Conversation` roots, each session's traffic under its own root |
| 8 | summary rewrite | tap the thread root: it now shows `# Topic`, `## Main discussion points`, `## Main decisions` — an edit of the original root, not a new post |
| 9 | survives /compact | a `🎯 … compacted context` milestone appears; tap the root again — the summary is still there |
| 10 | survives restart | after the suite reconnected, a new milestone posts fine; the root's summary is untouched |
| 11 | commands from room | typing `/matrix-help` in the room dispatches like typing it in the terminal — the room receives the help surface; `/skill:` invocations relay the same way (execution inside the live session: run one interactively once per release) |
| 12 | attachment round trip | a `probe.txt` file appears in the room — download it, the bytes match; a `@path` file reference pulls a workspace file's content into the session |
| 13 | footer status | on the agent machine, the Pi footer shows `[matrix] 💬` while connected (✗ while down) |
| 14 | scripted tour | the fixed 9-message tour sequence lands in the room in order (welcome → talk → 🎯 milestone → commands → voice → decision → sub-agents → threads → controls); nothing reaches the terminal agent while it plays |

## Manual sdk checks

Three hand-run checks walk the raw sdk transport outside the suite (not in
CI, run them when you touched `src/sdk-client.ts` or the crypto stack):
`sdk-send.mjs` (one room send + read-back through the production
`SdkOutbox` — the encrypted send/receive gate), `sdk-smoke.mjs` (connect
path: rust-crypto init, `/sync`, alias resolution, delivery start),
`sdk-passphrase.mjs` (at-rest store passphrase check: a resume with the
same passphrase must succeed, a wrong one must be reported).
Same credentials as the suite, same throwaway accounts.

## Record

For the demo file note: homeserver used, Node version, run id, anything that
looked different from the table above. Room state is the contract — if
Element shows it, the feature works for a phone user.
