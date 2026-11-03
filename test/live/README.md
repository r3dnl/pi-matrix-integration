# Live scenario suite — human walkthrough

`npm run test:live` runs the 13 scenarios headlessly against a real
homeserver and writes evidence to `artifacts/live-<run-id>/`. A machine
assertion proves the room received the right thing; this file proves what a
human sees in Element. Do this pass once per release, next to a scenario run,
and record what you saw for the demo file.

## Before you start

1. Export the live credentials (see `docs/dev/developing.md`, "Running the
   live tier"): `PI_MATRIX_HOMESERVER`, `PI_MATRIX_USERNAME`,
   `PI_MATRIX_PASSWORD` for the agent account, plus the second actor
   (`PI_MATRIX_SECOND_TOKEN`, or `PI_MATRIX_SECOND_USER` +
   `PI_MATRIX_SECOND_PASSWORD`).
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

## Record

For the demo file note: homeserver used, Node version, run id, anything that
looked different from the table above. Room state is the contract — if
Element shows it, the feature works for a phone user.
