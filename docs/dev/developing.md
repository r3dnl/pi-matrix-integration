# Developing

You are reading the development half of the docs. If you only want to run the extension, read the README and `docs/user/`.

## What you need

- Node 22 or newer.
- Pi installed and working. The extension is loaded by Pi as a TypeScript source package — there is no build step and no `dist/` directory. Pi executes the `.ts` files.
- A Matrix homeserver you may create accounts on, and an account for the agent. Use an account of the agent's own, never your personal one, and an invite-only room.
- Optional: a sub-agent package (`@tintinweb/pi-subagents` or `pi-subagents`). Several features are better with one and degrade without it.

## The loop

```bash
npm install                 # five runtime dependencies; see SECURITY.md
npm test                    # deterministic suite, no homeserver, no model
npm run test:logic          # the large behavioural suite, same constraints
npm run test:live           # needs a real homeserver (see below)
```

There is no build, so there is nothing to compile before you can try a change: point Pi at the checkout and it loads it.

```bash
pi -e ./          # load this checkout as a package for one run
```

Then in Pi: `/matrix-login` to authenticate the agent account, `/matrix-connect` to attach the room, `/matrix-status` to confirm, `/matrix-help` for the command list.

The remaining gate is the strict typecheck (`npm run typecheck`). The release artifact itself is proven by the live scenario tier (`npm run test:live`) plus the manual cold-install check in the release checklist below.

## The test tiers

| Command | Needs network | Needs a model | What it proves |
|---------|--------------|---------------|----------------|
| `npm test` | no | no | units and the full cycle against `test/fake-outbox.mjs` — milestone out, message in, question mirror reply, thread summary write (`test/e2e-stub-cycle.mjs`). Budget: under 120 s wall time; the runner fails the tier past it |
| `npm run test:logic` | no | no | the deep behavioural suite, split by subsystem: `test/logic/00-core` (funnel, config, attach), `01-threading`, `02-transport-footer`, `03-sdk-crypto` |
| `npm run test:live` | yes | yes | the 14 named scenarios in `test/live/scenarios.mjs` against a real homeserver, asserting on room state fetched over the client-server API (never internal variables). `PI_MATRIX_HOMESERVER` from the environment; each actor authenticates via a credentials.json path (`PI_MATRIX_PRIMARY_CREDENTIALS` / `PI_MATRIX_SECOND_CREDENTIALS`), a token, or a user + password — missing ones fail the run by name |
| `npm run test:live:judge` | yes | yes | per-release LLM judge on the thread-summary the scenario run rewrote into the thread root; verdict saved next to the run evidence, not part of any gate |
| `npm run test:perf` | yes | yes | latency and context-size budgets; lands with the performance stories and fails loudly until then |
| `npm run test:repro` | varies | varies | a single bug reproduction, not part of any gate |

The tiers are a policy, not a preference: deterministic checks belong in the offline tier because they have to run on every push and must never be flaky. Anything that reads the room belongs in `test:live`, and `test:live` must assert on what actually landed in the room — fetched over the client-server API — not on internal variables. An assertion on internal state can pass while the room shows nothing, and that has already happened once here.

Scripts live in `test/` and use the hand-rolled harness in `test/_harness.mjs`. There is no test framework on purpose: 34 working scripts and one shared runner beat a migration nobody asked for. Add a new script to the offline tier's discovery rather than inventing a second runner.

Two environment seams make the offline tier hermetic. `PI_MATRIX_TEST_OUTBOX` set to a module path replaces the real transport with the module's exported outbox (the fake lives in `test/fake-outbox.mjs`); `PI_MATRIX_TEST` marks the hermetic run and skips work that only makes sense against a live session. They are test-only; nothing user-facing reads them.

## Running the live tier against your own homeserver

The live scripts read the homeserver and the agent's credentials from the environment. Nothing secret is committed, and nothing secret belongs in a script — when you see a hard-coded hostname or account name in a test file, that is a defect to fix, not a convention to copy.

```bash
export PI_MATRIX_HOMESERVER=https://matrix.example.org
# each actor presents, in order of preference: a credentials.json path (the
# same account-file layout /matrix-login writes), a token, or a password.
export PI_MATRIX_PRIMARY_CREDENTIALS=~/.config/mtx/accounts/pi_agent--example.org/credentials.json
# (or: PI_MATRIX_USERNAME=pi_agent + PI_MATRIX_PASSWORD='<from your secret store>')
# the scenarios need a second actor — "the human" who posts into the room:
export PI_MATRIX_SECOND_CREDENTIALS=~/.config/mtx/accounts/you--example.org/credentials.json
# (or: PI_MATRIX_SECOND_TOKEN='<access token>', or PI_MATRIX_SECOND_USER=you +
#     PI_MATRIX_SECOND_PASSWORD='<from your secret store>')
npm run test:live
```

The scenario suite creates one fresh room per run, drives the real extension
seams, and writes per-scenario evidence to `artifacts/live-<run-id>/` (the
the live-nightly workflow uploads it). Once per
release, judge the summary quality too: point `PI_MATRIX_JUDGE_BASE_URL` /
`PI_MATRIX_JUDGE_MODEL` at any OpenAI-compatible server and run
`npm run test:live:judge`. The human confirmation pass for each scenario is
`test/live/README.md`.

A test homeserver that only speaks `http://` on a non-local address needs
an explicit opt-in as well: `PI_MATRIX_ALLOW_INSECURE_HTTP=1`. Without it
the login dialogue refuses `http://` unless the address is loopback or a
`.local` name, or a human confirms the risk in the dialogue. Nothing else
changes; the variable never applies to `https://`. Create a fresh room per
run (the scripts do) so reruns cannot interfere, and expect the suite to
write messages to that room.

## What CI runs

Four workflows live in `.github/workflows/`:

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | every push / PR | `gate`: credential scan (plus a self-test that the scan can bite), typecheck, lint, `npm test`, docs-consistency. `manifest`: `npm ci --omit=dev` in a clean tree, the dependency contract, the secret scan on the unpacked tarball, and the tarball file allowlist |
| `deps.yml` | schedule + lockfile changes | `npm audit --omit=dev` (fails on high/critical), registry signature verification |
| `live-nightly.yml` | daily 04:30 UTC + manual dispatch, `main` only | `npm run test:live` and `npm run test:perf` against a real homeserver using repository secrets; evidence uploaded, a failing run opens (or reuses) one tracking issue |
| `release.yml` | version tag | the `prepack` publish guard, then publish |

The nightly is the only workflow that touches the network with credentials,
and it never runs on a fork or a pull request — the secrets are repository
secrets, exposed only to this scheduled run on `main`.

### Setting up the nightly's secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository
secret**, one secret per name (exact case):

- `PI_MATRIX_HOMESERVER` — the https URL of your test homeserver
- `PI_MATRIX_USERNAME` + `PI_MATRIX_PASSWORD` — the primary (agent) test
  account
- `PI_MATRIX_SECOND_USER` + `PI_MATRIX_SECOND_PASSWORD`, or
  `PI_MATRIX_SECOND_TOKEN` — the human-seat account (the workflow reads the
  token variable too, but a token stops working when the session it belongs
  to expires; a password does not)

These are throwaway test identities — provision them with the manifest
shape in `test/live/accounts-manifest.example.json`.
If the nightly homeserver auto-encrypts new rooms (a default-encryption
Synapse), the suite reads through the crypto reader — a persistent device
whose identity the extension shares room keys with, so it needs a stable
`device_id` + `access_token`, never a password login (that would mint a
new device every run). The workflow already supports it: store the reader
account's whole `credentials.json` as a secret named
`PI_MATRIX_READER_CREDENTIALS_JSON`, and `live-nightly.yml` writes it to
`runner.temp` and points `PI_MATRIX_READER_CREDENTIALS` at it. An unset
secret leaves the file unwritten and the suite takes the plain-reader path.
Maintenance loop: if the reader's token ever dies (revocation, soft
logout), run `npm run test:live` once locally — it re-mints and rewrites
the local file — then refresh the secret with the new content.

## Architecture

Read [docs/dev/architecture/README.md](architecture/README.md) before a change that crosses modules. It states the invariants — one identity and one writer, event bus over cross-imports, atomic state writes — and each topic ends with the invariants that must not break.

The short version of the module map: `src/integration.ts` is the composition root and subscribes every Pi lifecycle event; `src/lifecycle.ts` holds the session state machine; `src/outbox.ts` is the only write path; `src/inbound.ts` is the only read path.

## Adding a dependency

1. Ask whether the standard library or an installed dependency already does it. Five runtime dependencies is the current total and each one is justified in `SECURITY.md`.
2. Never put a Pi host-provided package (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) in `dependencies` — they are `peerDependencies` at `"*"`. A physical copy can bypass Pi's module mapping and create duplicate registries.
3. Add a row to `SECURITY.md`: why it is needed, who maintains it, when it last released.
4. Check `renovate.json` covers it, and note that majors of `matrix-js-sdk` and `@matrix-org/matrix-sdk-crypto-wasm` move as one pair.

## Vendored code

`src/qr2025/` is vendored from a `matrix-js-sdk` pull request, Apache-2.0, headers intact, provenance in `NOTICE`. Do not edit those files. `tools/check-vendored.mjs` fails when the installed SDK starts exporting what the secure channel needs — at that point delete `src/qr2025/` and keep the attribution.

## Releasing

1. Update `CHANGELOG.md` (Keep a Changelog) and bump `version` in `package.json`.
2. Confirm `npm pack --dry-run` ships what you expect: sources, `agents/`, the docs and `NOTICE` — nothing from `state/`, `config/` or `manifests/`.
3. Run `npm test` and `npm run test:live` once, fully.
4. Cold-install smoke, by hand (five minutes): `npm pack`, `pi install`
   the tarball against a clean Pi install (fresh $HOME or a fresh user
   account), start a session, run `/matrix-login`. This is the check that
   gates the artifact users actually receive; the live tier it exercises
   is covered by the nightly workflow on its own.
5. Tag `v<version>` and publish. The published tarball must be reproducible from the tag.

Breaking changes to config keys or command names require a major bump. Both are user-facing surface.

### Credentials never ship — and one accepted risk

The repository and the published tarball contain no credential of any kind.
`tools/scan-secrets.mjs` enforces that in CI on the checkout and on the
unpacked tarball; the live test tier reads its password from the
environment, never from a file. The development history that predates this
repository's first commit still contains passwords for **test-only
accounts on a private test server the owner controls**. They were verified
unreachable from the public internet and deliberately not rotated; the
private history is not part of any published artifact. If that test server
is ever exposed beyond the owner's own devices, rotate those accounts first.

## How to ask for a change

Open an issue with the Pi version, the package version, your homeserver software, and a log excerpt with secrets stripped. `AGENTS.md` documents what an AI coding agent is and is not allowed to change here; read it before letting one edit this repository.

The `/matrix-*` command surface has a standing redesign on the backlog
(docs/user/roadmap.md). Three rules bind it: the config file is the leading
declarative description of behaviour; commands invoke functionality and
are not where preferences get stored; anything a user needs away from the
terminal must be reachable from the room, so it must be a command. Do not
rename or remove a command outside that redesign — names are user-facing
surface and change only with a major bump.
