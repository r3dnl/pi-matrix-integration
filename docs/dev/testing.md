# Test setup and runbook

One page for everything that runs tests: which identities you need, where
the environment lives, what to run locally, the cold-install container, and
the GitHub Actions setup. What each tier proves and why it is scoped the way
it is lives in [developing.md — The test tiers](developing.md#the-test-tiers);
this page is the setup and the commands.

## The three test identities

The live tier drives a real homeserver with three distinct identities. They
are throwaway accounts on a test homeserver only — AGENTS.md rule 1 permits
no other target.

| Actor | Env vars | What it does |
|---|---|---|
| **Agent (primary)** | `PI_MATRIX_USERNAME` + `PI_MATRIX_PASSWORD` (or `PI_MATRIX_PRIMARY_CREDENTIALS`) | The extension identity under test. It logs in, joins the room, posts and relays. |
| **Human seat** | `PI_MATRIX_SECOND_USER` + `PI_MATRIX_SECOND_PASSWORD` (or `PI_MATRIX_SECOND_TOKEN`) | Plays the human: posts into the room so the inbound path has something to read. Also the Synapse admin identity the room sweep uses for purges. |
| **Crypto reader** | `PI_MATRIX_READER_USER` + `PI_MATRIX_READER_PASSWORD` (or `PI_MATRIX_READER_CREDENTIALS`) | A separate *device* that decrypts Megolm so the assertions can read room bodies. **Not the second user.** Needed whenever the homeserver auto-encrypts new rooms; the CI nightly derives it from the primary account's login (a fresh device per run). |

Provision the accounts with the manifest shape in
[test/live/accounts-manifest.example.json](../../test/live/accounts-manifest.example.json).

## The local environment: `docker/.env`

`docker/.env` is the single place the local harness reads its secrets from.
It is git-ignored; copy the tracked sample and fill it in:

```bash
cp docker/.env.example docker/.env   # then edit the values
source docker/.env                   # loads the exports into your shell
npm run test:live
```

`docker compose` reads `docker/.env` by itself for `${VAR}` interpolation, so
`make e2e` works without sourcing — but if your compose version does not
expand `$VAR` references inside the file, write the reader values out in
full instead of `$PI_MATRIX_USERNAME`-style references.

If the suite was run without the reader against an encrypting homeserver,
you will have seen the cascade described in the triage section below.

## What to run

The daily loop (every push must be green on all of it):

```bash
npm ci
npm run typecheck && npm run lint   # the gate
npm test                             # offline tier: units + stubbed e2e
npm run test:docs                    # docs surface gate
npm run test:logic                   # deep behavioural suite
```

Beyond the loop:

```bash
source docker/.env
npm run test:live                    # 14 scenarios against the test homeserver
npm run test:live:judge              # release-time LLM judge on summary quality
                                     # (needs PI_MATRIX_JUDGE_BASE_URL / _MODEL)
npm run test:repro                   # single-bug reproduction, not a gate
npm run test:perf                    # reserved: fails until the perf stories land
```

The live suite creates one fresh room per run, asserts on room state fetched
over the client-server API (never internal variables), and writes per-run
evidence to `artifacts/live-<run-id>/` — per-scenario JSON plus the SDK log.
The human confirmation walkthrough per scenario is
[test/live/README.md](../../test/live/README.md).

An `http://`-only test homeserver on a non-local address additionally needs
`PI_MATRIX_ALLOW_INSECURE_HTTP=1` (never applies to `https://`).

## The cold-install container (`make`)

`docker/` + `Makefile` carry the release-story harness: a clean container
installs Pi and the extension the way a user does and proves it against the
real homeserver. Credentials arrive as environment variables at run time —
nothing secret lives in these files or the image. Full notes:
[docker/README.md](../../docker/README.md).

| Target | What it proves |
|---|---|
| `make build` | builds the harness image (Pi version pinned via `PI_VERSION`, default in the Makefile) |
| `make e2e` | cold install from the local tarball → log in → run the live tier inside the container |
| `make e2e-npm` | same, installed from the npm registry (proves the published artifact) |
| `make e2e-offline` | `npm test` with no network at all (run `npm ci` on the host first — `node_modules` rides along) |
| `make shell` | interactive container for the manual walkthrough |
| `make clean` | tear down images and volumes |

Keep the container's Pi pin and the nightly's `PI_MATRIX_TEST_PI_PKG` story
in mind when Pi releases move: `make e2e` proves *the pinned version*, not
whatever is latest.

Test rooms pile up on the test homeserver between runs; sweep them:

```bash
source docker/.env
node docker/sweep-test-rooms.mjs     # purges agent-created e2e-*/live-e2e-*/optout-*
                                     # rooms older than SWEEP_TTL_DAYS (default 7)
```

## GitHub Actions setup

Four workflows live in `.github/workflows/`:

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | every push / PR | `gate`: credential scan (plus a self-test that the scan can bite), typecheck, lint, `npm test`, docs-consistency. `manifest`: `npm ci --omit=dev` in a clean tree, the dependency contract, the secret scan on the unpacked tarball, the tarball file allowlist |
| `deps.yml` | schedule + lockfile changes | `npm audit --omit=dev` (fails on high/critical), registry signature verification |
| `live-nightly.yml` | daily 04:30 UTC + manual dispatch, `main` only | `npm run test:live`; `npm run test:perf` (continue-on-error until the perf stories land). Evidence uploaded; a failing run opens (or reuses) one tracking issue |
| `release.yml` | version tag | the `prepack` publish guard, then publish |

The nightly is the only workflow that touches the network with credentials.
It never runs on a fork or a PR — the secrets are repository secrets, visible
only to the scheduled run on `main`.

### The required secrets (five, exact case)

GitHub → Settings → Secrets and variables → Actions:

- `PI_MATRIX_HOMESERVER` — the https URL of the test homeserver
- `PI_MATRIX_USERNAME` + `PI_MATRIX_PASSWORD` — the agent account
- `PI_MATRIX_SECOND_USER` + `PI_MATRIX_SECOND_PASSWORD` — the human seat
  (`PI_MATRIX_SECOND_TOKEN` is read too, but tokens expire; passwords do not)

No reader secret is needed: the workflow sets `PI_MATRIX_READER_USER` /
`PI_MATRIX_READER_PASSWORD` from the primary account's secrets, minting a
fresh reader device per run. A stateless runner must never carry a stored
`device_id` with an empty crypto store — that registers a new identity under
the old device and Olm key shares can never be unwrapped (the failure shows
as `NoOlm` / withheld-key in the reader log). A fresh device per run is the
path a first local run takes, so it is the path CI takes.

The workflow also sets `PI_MATRIX_TEST_PI_PKG` to the devDependency-installed
Pi package — on a runner there is no `pi` on `PATH`, so the harness points
the seam at `node_modules/@earendil-works/pi-coding-agent` explicitly.

## Triage signatures

- **`This room is configured to use encryption, but your client does not
  support encryption`** in `artifacts/live-<run-id>/pi-matrix-http-sdk.log`,
  followed by a cascade of timeouts (questionnaire, thread roots, restart
  post) and `sdk transport unavailable`: the reader env pair is missing and
  the homeserver auto-encrypts new rooms. Early scenarios may pass — their
  sends left before the first sync revealed the room's encryption. Fix:
  export `PI_MATRIX_READER_USER` + `PI_MATRIX_READER_PASSWORD` (see the
  sample file) and rerun.
- **Empty `""` bodies in the timeout evidence** — the same diagnosis from
  the reading side: a non-crypto reader cannot see Megolm event bodies.
- **`nightly live gate failed` issue opened** — read the uploaded
  `live-nightly-<run>` artifact; the per-scenario JSON names the marker and
  the last-seen room bodies.
