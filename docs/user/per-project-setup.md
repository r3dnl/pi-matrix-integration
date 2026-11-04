# Per-project setup (1 project : 1 room)

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

Pi derives the project-local path from the working directory, so from
`~/.pi` the extension looks at `~/.pi/.pi/matrix/`. To use `~/.pi/matrix/`
instead, create a symlink:

```bash
mkdir -p ~/.pi/.pi
ln -s ~/.pi/matrix ~/.pi/.pi/matrix
```

## Keeping it safe

- The project directory holds state, not secrets — credentials live in the
  account directory `credentialsPath` points at (mode `0600`), which is
  outside the project unless you deliberately move it. If you do, make sure
  it is gitignored.
- Room membership is the access control: keep each project's room
  invite-only. See [SECURITY.md](../../SECURITY.md).

Full key reference: [configuration.md](configuration.md) · commented
example: [matrix-config.example.jsonc](matrix-config.example.jsonc).
