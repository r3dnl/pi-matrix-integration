# Troubleshooting

Work top-down: connection first, then room membership, then the feature you
are missing. The extension log is the first thing to read — see the last
section.

## Cannot connect

`/matrix-status` shows the last failure.

- **Wrong or unreachable homeserver.** `/matrix-login` probes the server
  before asking for a password. If the probe fails, re-enter the homeserver.
  Check the base URL resolves to a `/_matrix` endpoint (the login dialogue
  tests it).
- **`400` at connect with a valid token.** A configured `deviceId` that is
  not the device the access token belongs to is rejected. The log says
  `configured deviceId ... differs from the credentials file's device_id`.
  Remove `deviceId` from the config (and `PI_MATRIX_DEVICE_ID` from the
  environment); the credentials file carries the right one.
- **Password login refused.** The extension logs in with
  `m.login.password`. Homeservers that disabled password login (SSO-only)
  need a password flow enabled for the agent's account.
- **`already in use by another live pi session (pid N)`.** The account lock,
  working as designed. The directory that holds `credentials.json`
  (`~/.config/mtx/projects/<project>/accounts/<user>--<domain>/`) carries a
  `pi-matrix.lock` naming the holder's pid, and a second session on the same
  account refuses to connect instead of degrading: two Olm accounts on one
  device fork the double ratchet, and the room fills with "Unable to decrypt
  message". Fix the collision, not the lock file.
  - Stop the holder: `ps -p <N>` names the process, then quit that Pi or run
    `/matrix-disconnect` in it. The lock goes away on `/matrix-disconnect` and
    on process exit, so one account used by two projects *one after the other*
    is fine — retry this session with `/matrix-connect`.
  - A crashed holder leaves nothing to clean up. The holder pid is dead, so the
    next connect deletes the stale lock by itself. Deleting `pi-matrix.lock` by
    hand is correct only after you confirmed that pid is gone: with two live
    sessions you have not freed the account, you have let a second Olm account
    start and corrupt the room's keys.
  - Two sessions at the same time is a legitimate need. Give each project its
    own Matrix account or device — see
    [per-project setup](per-project-setup.md).
  - `STILL held by THIS process (pid …) after 30 s` is a different case: a
    client orphaned inside one Pi process, usually a `/reload` or account switch
    whose predecessor did not release. Restart that Pi session.

## Connected, but nothing arrives in the terminal

- **Wrong room.** `/matrix-status` prints the connected room. Send
  `/matrix-send hello` — if the message appears in the room you watch, Pi is
  talking to a different room. Fix `roomId`.
- **The agent is not in the room.** The agent must be invited. Membership is
  also the security boundary: only members can drive the agent.
- **Messages are dropped as too old.** On connect the server backfills recent
  history; anything older than `maxMessageAgeMinutes` (default 30) is dropped
  so it is not injected as live input. The log warns per dropped burst.
- **Machine traffic filter.** Messages that look like another Pi instance's
  output (milestone/thread/user icons) are ignored on purpose. Two sessions
  in one room with different icons can confuse this — give each project its
  own room.

## Threads not visible

Threads are per-client. Element Web/Desktop shows threads in a Labs flag or
the thread panel; Element X shows them as a Labs feature. If the room looks
flat, check the client's thread support before suspecting the extension —
`/matrix-status` and the log show the thread roots being created.

## E2EE: cannot decrypt history

Decryption depends on the crypto store and the device identity. Losing either
loses old messages for good.

- Do not delete the crypto store directory (see
  [configuration](configuration.md)); keep it out of container images that
  are rebuilt from scratch.
- Do not set `deviceId` to a value that differs from the credentials file —
  see the `400` case above. The Olm keys belong to the stored device.
- A freshly re-created agent account cannot decrypt rooms' old history; this
  is normal Matrix behaviour, not a bug.

## Thread summaries not updating

- **`summarizeSource: "room"` without `pi-subagents`.** Room-mode summaries
  run through the `pi-subagents` extension. Without it, the extension falls
  back to summarizing in the current session. Install `pi-subagents` if you
  want summaries that survive `/compact` and restarts.
- **Cadence.** The cadence counts YOUR messages (terminal and room), never
  the agent's own output. The first passes happen early (Fibonacci ramp: 1,
  1, 2, 3, 5, 8 …) and settle at `threadSummaryEvery` (default 10). A quiet
  thread simply has no new human material — agent chatter alone will not
  produce a pass.
- **A failed pass never clobbers.** If the summarizer returns empty or
  errors, the root keeps its last good summary — the root looking stale while
  the log records passes is the summarizer failing; read the log for the
  error.
- **Timeout.** A run gets `threadSummarizeRunTimeoutMs` (default 30 minutes)
  to finish — a completion budget for slow models, not a stall detector. On a
  fast summarizer model you can lower it.

## The terminal question dialog does not follow room replies

Stock dependency behaviour. See
[ask-user pairing](ask-user-pairing.md) — one command fixes it.

## Reading the log

Default: `.pi/matrix/logs/pi-matrix.log` relative to the project; a
project-local config co-locates it to `<project>/.pi/matrix/state/pi-matrix.log`.

```bash
tail -f <project>/.pi/matrix/state/pi-matrix.log
```

The SDK's own output goes to `pi-matrix-http-sdk.log` next to it, never to
the Pi terminal. Raise `logLevel` to `DEBUG` while diagnosing.
