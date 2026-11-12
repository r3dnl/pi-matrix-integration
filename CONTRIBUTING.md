# Contributing

Thanks for taking the look. I'd appreciate checking in with
[me](https://github.com/vargo) so we can discuss how to contribute.

Before a change starts: the user-visible surface — configuration keys, `/matrix-*` command names, `PI_MATRIX_*` environment variables — never moves without a major version bump.

## Setup

```bash
git clone https://github.com/r3dnl/pi-matrix-integration
cd pi-matrix-integration
npm ci
```

Pi itself must be installed for anything to run — this package is a Pi
extension, not a standalone app.

## Where everything else is written

[docs/dev/README.md](docs/dev/README.md) is the index of the developer
documentation, and the single place those details are kept:

- [Developing](docs/dev/developing.md) — the daily loop: what to run when,
  what CI runs and in which order, the test tiers and why that split is a
  policy rather than a preference, and how a release is cut.
- [Coding standards](docs/dev/coding-standards.md) — every rule with the
  gate that enforces it, plus branching, commit prefixes and semver
  practice.
- [AGENTS.md](AGENTS.md) — the working contract for coding agents: the
  loop, the never-rules, scope discipline. Humans are held to the same
  scope discipline.
- [SECURITY.md](SECURITY.md) — the trust boundary, and how to disclose a
  vulnerability.

Write the change, run the gates [Developing](docs/dev/developing.md)
lists, open it against `main`.
