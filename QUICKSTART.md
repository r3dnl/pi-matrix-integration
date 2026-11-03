# Quick Start

Go from install to a working room in about ten minutes. You need: a working
Pi installation (Node 22 or newer), a Matrix homeserver you can create
accounts on, and a Matrix account for the agent (its own — never your
personal one).

## 1. Install the extension

```bash
pi install npm:pi-matrix-integration@1.0.0
```

(From git: `pi install git:github.com/r3dnl/pi-matrix-integration@v1.0.0`.
From a checkout: `pi install /path/to/pi-matrix-integration`.)

Optional but recommended — room-mode thread summaries and sub-agent
visibility need the `pi-subagents` extension:

```bash
pi install npm:pi-subagents
```

Apply the question-mirror patches (one command, idempotent; enables full
terminal ↔ room synchronisation of decision questionnaires):

```bash
sh ~/.pi/agent/npm/node_modules/pi-matrix-integration/patches/rpiv-ask-user-question/apply.sh
```

## 2. Prepare the room

1. Create the agent's account on your homeserver (see your server's
   documentation for account creation).
2. Create a room for the project and invite the agent. Keep it
   invite-only — room members can drive the agent.

## 3. Log in and connect

Start Pi in your project directory:

```bash
cd <project> && pi
```

In the Pi session:

```
/matrix-login      # probe homeserver, agent username + password, token stored
/matrix-connect    # connect to the room (first run asks which room)
/matrix-status     # prints server, room, user — connected
```

## 4. Verify both directions

```
/matrix-send "Hello from Pi"
```

…appears in the room. Then type `hello` in the room — a moment later it
shows in the terminal marked `[Matrix]`, and Pi answers it.

## 5. See what happens automatically

With defaults, once connected Pi automatically:

- posts a milestone line on session start, compaction, and model change,
- echoes your terminal-typed prompts as `🧑 User: …`,
- broadcasts each turn's final message as `💬 Pi: …`,
- opens a `🧵 <topic>` thread for the session and keeps its root summary
  updated as the conversation moves,
- shows the connection in the footer: `💬 (user:domain/#room 🧵 on)`.

When Pi raises a decision questionnaire, it appears in the terminal **and**
in the room. Answer wherever you are: option numbers, `Custom: …`, 👍/👎;
a review step confirms before Pi proceeds.

## Commands you will actually use

| Command | What it does |
|---------|--------------|
| `/matrix-status` | Show connection status |
| `/matrix-send Hello!` | Send a message to the room |
| `/matrix-messages 5` | Show the last 5 room messages |
| `/matrix-toggle` | Toggle the integration on/off |
| `/matrix-thread-toggle` | Toggle threading |
| `/matrix-help` | Post the end-user guide to the room |

The full surface (13 commands + 2 aliases) is in the
[README](README.md#commands).

## If something does not work

[docs/user/troubleshooting.md](docs/user/troubleshooting.md) walks the five
common failures: cannot connect, connected-but-silent, missing threads,
decryption problems, stale summaries. The extension log is
`<project>/.pi/matrix/state/pi-matrix.log` for a project-local config.

## Learn more

- [README](README.md) — the full picture
- [Configuration reference](docs/user/configuration.md) — every key, default, env override
- [Ask-user pairing](docs/user/ask-user-pairing.md) — phone + terminal questionnaires
- [Architecture](docs/dev/architecture/README.md) — how it is built
