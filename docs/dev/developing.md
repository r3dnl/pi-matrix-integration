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
| `npm test` | no | no | units and the full cycle against `test/harness/fake-outbox.mjs` — milestone out, message in, question mirror reply, thread summary write (`test/e2e-stub-cycle.mjs`). Budget: under 120 s wall time; the runner fails the tier past it |
| `npm run test:logic` | no | no | the deep behavioural suite, split by subsystem: `test/logic/00-core` (funnel, config, attach), `01-threading`, `02-transport-footer`, `03-sdk-crypto` |
| `npm run test:live` | yes | yes | the 14 named scenarios in `test/live/scenarios.mjs` against a real homeserver, asserting on room state fetched over the client-server API (never internal variables). `PI_MATRIX_HOMESERVER` from the environment; each actor authenticates via a credentials.json path (`PI_MATRIX_PRIMARY_CREDENTIALS` / `PI_MATRIX_SECOND_CREDENTIALS`), a token, or a user + password — missing ones fail the run by name |
| `npm run test:live:judge` | yes | yes | per-release LLM judge on the thread-summary the scenario run rewrote into the thread root; verdict saved next to the run evidence, not part of any gate |
| `npm run test:perf` | yes | yes | latency and context-size budgets; lands with the performance stories and fails loudly until then |
| `npm run test:repro` | varies | varies | a single bug reproduction, not part of any gate |

The tiers are a policy, not a preference: deterministic checks belong in the offline tier because they have to run on every push and must never be flaky. Anything that reads the room belongs in `test:live`, and `test:live` must assert on what actually landed in the room — fetched over the client-server API — not on internal variables. An assertion on internal state can pass while the room shows nothing, and that has already happened once here.

Scripts live in `test/` and use the hand-rolled harness in `test/harness/_harness.mjs`. There is no test framework on purpose: dozens of working scripts and one shared runner beat a migration nobody asked for. New offline units land in `test/offline/` — the runner discovers the directory; never invent a second runner.

Two environment seams make the offline tier hermetic. `PI_MATRIX_TEST_OUTBOX` set to a module path replaces the real transport with the module's exported outbox (the fake lives in `test/harness/fake-outbox.mjs`); `PI_MATRIX_TEST` marks the hermetic run and skips work that only makes sense against a live session. They are test-only; nothing user-facing reads them.

## Running the live tier against your own homeserver

The live scripts read the homeserver and the actors' credentials from the
environment; nothing secret is committed, and a hard-coded hostname or
account name in a test file is a defect, not a convention. The full setup —
the three test identities (agent, human seat, crypto reader), the
`docker/.env` environment file and its tracked sample, the evidence layout
and the failure triage — is the runbook: [test/README.md](../../test/README.md).

## What CI runs

Four workflows: the PR gate (`ci.yml`, no network, no secrets), the supply
chain gate (`deps.yml`), the live nightly (`live-nightly.yml` — the only
workflow that touches the network with credentials, `main` only), and the
release publish guard (`release.yml`). What each job runs, the five required
repository secrets and how the nightly derives the crypto reader without a
sixth one are in [test/README.md — GitHub Actions setup](../../test/README.md#4-github-actions-setup).

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

### Credentials never ship

The repository and the published tarball contain no credential of any kind, and
nothing in them identifies a real deployment. `tools/scan-secrets.mjs` enforces
both: credential-shaped literals and anything listed in the private-identifier
registry (see below). It runs in CI on the checkout and on the unpacked tarball,
and the nightly workflow re-runs it over the whole git object database and with
`gitleaks` as a second opinion. The live test tier reads its password from the
environment, never from a file.

### The private-identifier registry

Credentials are not the only leak. A hostname, a room id or a local path that
points at one real homeserver tells an attacker where to look, and it survives
even after the password is gone. `--registry <path>` reads one identifier per
line (`#` starts a comment) from a file that is never committed — by default
`.secrets/private-identifiers.txt`, gitignored — and fails the scan if any of
them appears, in the tree, the packed tarball, or history with `--history`.
`--self-check` plants a registry entry and proves the check bites. Keep the
registry (and any working note that names those identifiers) under `.secrets/`:
`npm run test:docs` scans every markdown file in the working tree, gitignored or
not, so a private note under `docs/` fails the docs gate by existing.

## How to ask for a change

Open an issue with the Pi version, the package version, your homeserver software, and a log excerpt with secrets stripped. `AGENTS.md` documents what an AI coding agent is and is not allowed to change here; read it before letting one edit this repository.

The `/matrix-*` command surface has a standing redesign on the backlog
(roadmap.md). Three rules bind it: the config file is the leading
declarative description of behaviour; commands invoke functionality and
are not where preferences get stored; anything a user needs away from the
terminal must be reachable from the room, so it must be a command. Do not
rename or remove a command outside that redesign — names are user-facing
surface and change only with a major bump.
