# AGENTS.md — working contract for coding agents

You are working in `pi-matrix-integration`, a Pi extension that connects a
Pi session to a Matrix room. Read this first. Architecture lives in
`docs/dev/architecture/`; coding rules in `docs/dev/coding-standards.md`;
security boundaries in `SECURITY.md`. This file only constrains your
behaviour, and every rule here is checkable from a diff.

## The loop

```bash
npm ci
npm run typecheck && npm run lint   # the gate
npm test                             # offline tier: units + stubbed e2e
npm run test:docs                    # docs surface gate
npm run test:logic                   # deep behavioural suite
npm run test:live                    # 14 named scenarios against a real
                                     # homeserver; needs PI_MATRIX_HOMESERVER
                                     # plus two actors, each via a
                                     # credentials.json path, a token, or a
                                     # user + password (see
                                     # docs/dev/developing.md)
npm run test:live:judge               # per-release LLM judge on summary
                                     # quality; not part of any gate
npm run test:perf                    # reserved: fails until the perf stories land
npm run test:repro                   # single-bug reproduction
npm run prepack                      # publish guard: runs the typecheck
```

A change is done when every gate is green, `npm run test:live` passes
against the maintainer-supplied test account, the user-visible behaviour
is documented, `CHANGELOG.md` has an entry, and no comment or doc points
at a file that does not exist.

## Never (each of these ends the session, not the build)

1. **Never touch a real Matrix account.** The maintainer-supplied test
   account, named by the environment variables above and nothing else, is
   the only permitted target. No account discovery, no connecting to
   homeservers you were not given, no posting anywhere else.
2. **Never commit or emit a credential.** Nothing under `state/`,
   `config/` or `manifests/` enters git. No passwords, tokens or
   recovery keys inline — environment variables only. Never return or log
   an access token, password, device id or room message body in a tool
   result or test output; the credential scan runs in CI and will also
   catch you.
3. **Never widen what the room can trigger.** The room's command surface
   is what README documents, and room membership is its only access
   control. Adding a command, a tool, or a room-triggerable path is a
   scope widening — propose it, do not implement it.
4. **Never add a dependency, and never change the performance or context
   budgets.** Both are human decisions. If a task seems to need one, stop
   and ask.
5. **Never edit `src/qr2025/`.** Vendored upstream prototype, read-only.
   The one exception is deleting the directory when
   `node tools/check-vendored.mjs` reports it obsolete — and then the
   attribution moves, it does not disappear.
6. **Never rename a user-facing surface item** — config keys,
   `/matrix-*` commands, `PI_MATRIX_*` variables — without a major
   version bump and an approved change.

## Scope discipline

- One unit per commit. No drive-by refactors next to a fix.
- Propose before widening: if the task's approach grows, that growth is
  a proposal, not a licence.
- An open decision is a question to ask, not a licence to pick. Decisions
  live in the maintainer's planning space; when a doc marks something
  open, ask.

## How to ask

When any rule above conflicts with the task, stop at the point of
conflict, state what you did, what you were asked, and which rule binds,
and wait. A partial result with a named blocker beats a complete result
that broke rule 3, 4 or 6.
