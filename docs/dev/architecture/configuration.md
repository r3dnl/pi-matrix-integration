# Configuration

Covers: how the extension finds its config file, and how profiles let one
install hold several homeserver/account/room combinations.

## Finding the configuration

`resolveConfigPath` in `src/config-utils.ts` walks a fixed list and returns the first file that exists. Both `.json` and `.jsonc` are accepted at each step, which is why a project config may be commented.

| Order | Location | Meaning |
|-------|----------|---------|
| 1 | the `configPath` value passed in | explicit override |
| 2 | `<cwd>/.pi/matrix/matrix-config.json[.c]` | project-local config, wins over everything below |
| 3 | `~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json[.c]` | the install's default config |
| 4 | `~/.config/pi-matrix-integration/config.json[.c]` | user-level config |

`isActiveConfigProjectLocal` tells the rest of the code which world it is in, because project-local and global configurations carry credentials in different places. `getActiveConfigDir` returns the directory of whichever file won, and that is where profile state is written.

The schema is `ConfigV2` in `src/config.ts`: an identity block, a connection block, a room block, logging, threading, sub-agents, and feature sections that each have their own `enabled` toggle. `resolveStartupConfigWithMigration` in `src/integration.ts` migrates an older file on startup rather than requiring a manual rewrite.

**Every key is overridable by environment variable.** There are 69 `PI_MATRIX_*` names in `src/` — `docs/user/configuration.md` is the generated reference. The convention matters more than the list: an environment value beats the file, which is how CI passes credentials without writing a file.

## Profiles

A profile is a named config file in the active config directory (`matrix-config.<profile>.json`), holding one homeserver, one agent account and one room. `/matrix-switch` swaps profiles at runtime without restarting Pi; the last choice is remembered so the next start comes back to it. This exists so switching between, say, a test homeserver at `matrix.example.org` and a production one is a profile change rather than an edit.

Credentials are never in a profile file. They live in a per-project, per-account store:

```text
~/.config/mtx/projects/<project>/accounts/<user>--<domain>/credentials.json
```

built by `getProjectCredentialsPath`, written with mode `0600`. A profile names who to log in as; the credential store holds the token.
