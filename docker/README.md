# Cold-install end-to-end harness

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
Both targets build on the same pinned Pi version (`PI_VERSION`, default
1.5.0); bump it deliberately with the release so a Pi change cannot break
the gate silently.

`make shell` drops an interactive shell into the image with the same cold
context, for a manual walkthrough in a Matrix client of your choice.

## Pointing at another homeserver

The defaults above are the only configuration the harness needs: the three
`PI_MATRIX_*` variables, plus `PI_MATRIX_ROOM` if you want a fixed room
alias instead of a fresh `e2e-<timestamp>` room per run. The live gate is
the maintainer's test homeserver; anything else works as long as account
creation and room creation are allowed for the agent account. E2EE rooms
should work with any spec-compliant server — if your server differs, the
first place to look is the connect phase in the `test:live` output.
