# Per-project setup (1 project : 1 room)

**The extension auto-creates the project configuration and state files, but this is to explain what happens.**

This extension follows Pi's mechanism for making extensions global, or project-local:
> Placement for /reload: Put extensions in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local) for auto-discovery. Use pi -e ./path.ts only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with /reload.

## Recommendation

Each project gets its own room and its own agent credentials. The extension
derives the project from the working directory Pi starts in, so the layout
below is per-project by construction. The general case (one agent account,
one room per project) is enough for most users; giving each project its own
agent account is an advanced option that fully isolates rooms and history.

## Set up once per project

```bash
mkdir -p <project>/.pi/matrix
# write the project's matrix-config.json (or run /matrix-login from the project):
# roomId, userId, credentialsPath for this project's room + agent account
```

Then start Pi from the project directory:

```bash
cd <project> && pi
```

## What to verify on first run

1. the session-start milestone lands in **this project's room** (flat, in
   the room main line — not a thread),
2. `<project>/.pi/matrix/state/` appears with `thread-map.json` and the
   project's own `pi-matrix.log`,
3. a session in a *different* project never touches this project's state,
4. after a Pi restart the project's state and (if used) its active profile
   restore from `<project>/.pi/matrix/`.

## FAQ: running Pi from `~/.pi`

When running Pi in `~/.pi` (so `.pi` is the project name) this leads to 
So from `~/.pi` the extension looks at `~/.pi/.pi/matrix/`. 
It is also possible to use `~/.pi/matrix/`instead, create a symlink:
```bash
mkdir -p ~/.pi/.pi
ln -s ~/.pi/matrix ~/.pi/.pi/matrix
```

## FAQ: can two projects share one credentials file?

Not at the same time. The path is yours to point anywhere — nothing checks
that a credentials file belongs to a project — but the **account directory**
(the folder holding `credentials.json`) can only be live in one Pi session:

- the E2EE crypto store defaults to `<account-dir>/store`, next to the token.
  Two sessions start two Olm accounts on one device, the double-ratchet
  forks, and the room fills with "Unable to decrypt message".
- `pi-matrix.lock` in the same directory records the holder pid. The second
  session refuses to connect with:
  `Matrix account … is already in use by another live pi session (pid N)
  — one Matrix account/device per pi session. … Stop the other session or
  give this one its own account/device. Not connecting.`

So sharing works for *sequential* use — finish in one project, then start the
other — and is refused for concurrent use rather than silently corrupting E2EE.

Do not "fix" this by moving the state directory. State is already per-project:
when the active config is `<project>/.pi/matrix/matrix-config.json`(`.jsonc`),
the thread map, the per-server unread and seen watermarks, and the log all live
in `<project>/.pi/matrix/state/` regardless of where credentials sit. That
isolation is what keeps two projects from clobbering each other's event ids
(a real bug once: five projects on one global seen-events file produced
duplicate deliveries). It does not touch the Olm store or the account lock.

To run two projects concurrently, give each its own agent account — see
Recommendation above. Sharing one identity across live sessions is tracked as
an open item in [roadmap.md](../dev/roadmap.md).

## Keeping it safe

- The project directory holds state, not secrets — credentials live in the
  account directory `credentialsPath` points at (mode `0600`), which is
  outside the project unless you deliberately move it. If you do, make sure
  it is gitignored.
- Room membership is the access control: keep each project's room
  invite-only. See [SECURITY.md](../../SECURITY.md).

Full key reference: [configuration.md](configuration.md) · commented
example: [matrix-config.example.jsonc](matrix-config.example.jsonc).
