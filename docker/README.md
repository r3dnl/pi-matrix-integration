# Docker Container for testing Pi-Matrix-Integration

See [Testing README](../test/README.md) for context.

## Cold-install end-to-end harness

A container that starts from a clean machine image, installs Pi and this
extension exactly the way a user does, and proves it against a real
homeserver. Nothing from your host `$HOME` is mounted into the container,
the container runs as a non-root user, and credentials arrive only as
environment variables at run time.

## Prerequisites

- Docker with the compose plugin.
- A Matrix homeserver you may create accounts on, an account for the
  agent, and Node 22+ on the host for `npm ci` (the offline target reuses
  the host's `node_modules` and npm cache).

## Run the offline proof

This needs no homeserver and no credentials: the container has **no
network at all** — stricter than "only the homeserver reachable" — and
runs `npm test`. It fails if the registry turns out to be reachable, so a
green run proves the offline tier is really offline.

```bash
npm ci                  # once on the host: node_modules + npm cache
make e2e-offline
```

## Run the live proof

```bash
export PI_MATRIX_HOMESERVER=https://matrix.example.org
export PI_MATRIX_USERNAME=pi_agent
export PI_MATRIX_PASSWORD='<from your secret store>'
make e2e
```

The harness packs the checkout (`npm pack`), gates the packed content,
installs the package with `pi install`, asserts the cold context — exactly
one extension installed, no host config present — then logs in headlessly
through the extension's own login dialogue and runs `npm run test:live`.
The run logs out the installed-extension count so the cold context is
visible in the output.

`make e2e-npm` does the same install from the npm registry instead of the
local tarball, proving the published artifact rather than the checkout.
The scenario suite's per-scenario evidence is written to the repo's
`artifacts/` directory through a bind mount, so a `make e2e` run leaves
`artifacts/live-<run-id>/` behind for the demo file and the nightly upload.
Both targets build on the same pinned Pi version (`PI_VERSION`, default
1.5.0); bump it deliberately with the release so a Pi change cannot break
the gate silently.

`make shell` drops an interactive shell into the image with the same cold
context, for a manual walkthrough in a Matrix client of your choice.

## Image variants (planned — not yet implemented)

The image is one cold context with one shape. The plan is two build ARGs
that fork the shape without forking the Dockerfile:

| ARG | Values | Effect |
|---|---|---|
| `PI_SUBAGENTS` | `none` (default) · `tintinweb` · `nicobailon` | second `npm install -g` of that subagents extension; the entrypoint then derives the cold-context assertion as `1 + (dialect != none)` instead of hard-coding 1 |
| `WITH_FFMPEG` | `0` (default) · `1` | conditional `apt-get install ffmpeg`, enabling the voice-message leg inside the container |

Variants map onto them: A (default) = bare Pi + the package under test —
the release gate, unchanged; B = `PI_SUBAGENTS=tintinweb`; C =
`PI_SUBAGENTS=nicobailon` (the bridge auto-binds a dialect when both are
present; a per-variant container makes each one explicitly testable);
D = `WITH_FFMPEG=1` for manual voice walks — no live scenario sends voice
today, so variant D runs no extra test. Spawning a variant stays
`PI_SUBAGENTS=tintinweb make e2e`-style env passthrough; no compose
service matrix. The derivation keeps build and assertion in lockstep:
the extension count can never drift from what was actually installed.

## Giving the container a model

Pi reads a model endpoint from `<agent-dir>/models.json` only — there is no
environment variable for an arbitrary base URL. `docker/models.json` is
bind-mounted read-only at `/home/node/.pi/agent/models.json` for the `e2e`
service, so `make shell` starts with a usable model; pick it with `/model`
(which reloads the file). Point `baseUrl` at your server and list its model
ids — check them with `curl -s <base>/models`. Use the server's IP, not its
`.local` name: mDNS inside the container answers link-local IPv6 addresses the
bridge network cannot reach. An open endpoint needs a dummy `apiKey`; for an
authenticated one set `apiKey` to `"$NAME"` and pass that variable through
`compose.yaml`. The offline service stays provider-less on purpose — it must
not be able to reach a model.

## Pointing at another homeserver

The defaults above are the only configuration the harness needs: the three
`PI_MATRIX_*` variables plus the second-actor variables the scenario suite
requires (see [Developing](../docs/dev/developing.md), "Running the live
tier"), plus `PI_MATRIX_ROOM` if you want a fixed room alias instead of a
fresh `e2e-<timestamp>` room per run. The live gate is
the maintainer's test homeserver; anything else works as long as account
creation and room creation are allowed for the agent account. E2EE rooms
should work with any spec-compliant server — if your server differs, the
first place to look is the connect phase in the `test:live` output.
