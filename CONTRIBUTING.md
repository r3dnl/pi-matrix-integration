# Contributing

Thanks for taking the look. The dev loop is short; here is the whole of it.

## Setup

```bash
git clone https://github.com/r3dnl/pi-matrix-integration
cd pi-matrix-integration
npm ci
```

Pi itself must be installed for anything to run — this package is a Pi
extension, not a standalone app.

## Gates (what CI runs, in this order)

```bash
node tools/scan-secrets.mjs          # credential scan; --self-check proves it bites
npm run typecheck                    # strict TypeScript, noEmit
npm run lint                         # ESLint, minimal agreed baseline
npm test                             # offline unit + stubbed e2e tier (29 suites, < 120 s)
node test/docs-consistency.mjs       # docs links, surface and identifier checks
```

Everything above runs offline; CI is green when all of it is green.

## The test tiers

| Command | Proves |
| --- | --- |
| `npm test` | offline units plus the full cycle against the fake outbox — the gate on every push, under a 120-second budget |
| `npm run test:logic` | the deep behavioural suite, split by subsystem under `test/logic/` |
| `npm run test:live` | a real homeserver, a real model, assertions on what actually landed in the room |
| `npm run test:perf` | latency and context-size budgets; reserved until the performance stories land |

The live tier reads `PI_MATRIX_HOMESERVER`, `PI_MATRIX_USERNAME` and
`PI_MATRIX_PASSWORD` from the environment and refuses to run without them.
Use a homeserver you own and let the scripts create a fresh room per run.
`docs/dev/developing.md` explains why the tiers are a policy, not a
preference.

## Conventions

`AGENTS.md` is the working contract for coding agents — what they may and
may not change here. Read it before letting one touch this repository;
humans are held to the same scope discipline.

- Commit messages: Conventional Commits, lowercase imperative
  (`fix:`, `feat:`, `docs:`, `build:`, `test:`, `security:`).
- User-visible surface is sacred: configuration keys, `/matrix-*` command
  names and environment variables never change without a major bump. If a
  change is breaking, say so in the commit message body.
- `src/qr2025/` is vendored upstream code (QR sign-in prototype) and must
  not be edited — fix problems at the seam in `src/login.ts` instead.
- User documentation is written in plain, simple English, and carries no
  internal references. The docs gate enforces both.

`docs/dev/developing.md` covers the rest of the loop — architecture notes,
adding a dependency, releasing.
