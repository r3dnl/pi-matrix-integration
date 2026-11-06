# Security Policy

## Reporting a vulnerability

Report security issues privately through
[GitHub security advisories](https://github.com/r3dnl/pi-matrix-integration/security/advisories/new)
— not a public issue. If the advisory form is unavailable, open a private
issue titled "security" and put nothing sensitive in the title or the
first comment; the details can follow in private comments.

What to include:

1. The extension version (`package.json`) and your Pi version.
2. Your homeserver software and whether the room is end-to-end-encrypted.
3. What you did, what you expected, and what the agent did — the room
   event ids involved help most.
4. Anything else, with tokens, passwords, room addresses and message
   bodies stripped.

Expected response: an acknowledgement within three working days and a
status update (fixed, declined, or needs coordination with the Matrix
homeserver or the Pi host) within ten. Never post a working exploit in a
public issue, even after reporting privately.

## What this extension touches

`pi-matrix-integration` connects a running Pi coding agent to a Matrix
room. Two boundaries are worth understanding before you install it.

**A connected room is an input channel to your agent.** Anyone who can
post in the room can talk to the agent, and everything posted there —
messages, files, thread replies — becomes model input. That includes
slash commands: every command this extension registers is reachable from
the room by any room member, as are the commands of every other
installed extension. Matrix membership is the access control: the extension adds no allowlist
of its own. Invite only people you want talking to your agent, keep the
room invite-only, and let the agent use its own account. The relay that
forwards room commands adds no execution power of its own: it goes
through Pi's own command registry, so Pi's confirmations for destructive
actions still run, and the inbound rate limit (30 human messages per
minute, excess dropped with a visible room notice) stops a flooding room
from queueing unbounded work.

**What the room cannot do.** Files arriving from the room are never
written to disk by the extension: media downloads live in memory, are
used for transcription, and are gone afterwards. A room message can
never install code, register a command, change configuration, or touch
your filesystem — the only file paths the extension reads are the ones
you ask it to attach, and those are confined to the working directory
(symlink-safe). Prompted tool approvals are Pi's, unchanged by the room
path.

**Login in the clear is a decision, not an accident.** The login dialogue
requires https; an `http://` homeserver is refused unless it is local
(loopback or `.local`) or you confirm the risk explicitly in the
dialogue. Credential requests never follow a redirect to a different
host — the login fetch refuses it.

**Credentials live outside the package.** Login tokens and passphrases are
stored in the local configuration directory (file mode `0600`) or read
from environment variables. No credential is ever bundled: the repository
and the published tarball are scanned on every push, and the scan also
runs against the unpacked npm artifact.

## Keeping the third-party surface small

Every dependency is code you run and attack surface you inherit, so the
direction of travel is always fewer, never more:

- **Five runtime dependencies, and adding one is a human decision.** An
  agent or contributor adding a package without a decision recorded has
  broken the working contract (`AGENTS.md` rule 4). If a feature cannot
  be built with what is installed plus the standard library, that is
  usually the answer.
- **Nothing is installed that the runtime does not load.** Host packages
  are declared peers your Pi already provides and are never fetched by
  this package; optional integrations (voice, sub-agents) load only when
  you installed them yourself.
- **Freshness is gated, not blind.** Updates arrive weekly through
  Renovate with a seven-day minimum age (a package published hours ago is
  never auto-adopted), majors only as human-reviewed PRs, and every CI
  run re-checks `npm audit` and registry signatures for the production
  tree against the committed lockfile.
- **Vendored code is frozen with an expiry probe.** `src/qr2025/` is
  never updated in place; a weekly check reports the moment upstream
  ships what it stands in for, and the copy gets deleted, not synced.

## Runtime dependencies

Five packages are installed with every version of this extension. All are
public npm packages, verified registry-signed on every CI run, and every
install is reproducible from the committed lockfile (a CI contract test
reinstalls the production tree from the lockfile alone and rejects any
package it cannot account for).

| Package | Release in use | Why it is needed | Upstream maintainer |
| --- | --- | --- | --- |
| `matrix-js-sdk` | 42.4.0 (2026-09) | Matrix client: sync, send, receive, E2EE orchestration | Matrix.org Foundation C.I.C. (Element) |
| `@matrix-org/matrix-sdk-crypto-wasm` | 18.9.0 (2026-09) | the encryption engine the SDK drives; loaded **from the installed package only**, never fetched remotely (contract-tested offline) | Matrix.org Foundation C.I.C. |
| `matrix-encrypt-attachment` | 1.0.3 (2022-04) | decrypts encrypted file attachments (`m.file` events) | Matrix.org Foundation C.I.C. |
| `jsqr` | 1.4.0 (2021-04) | decodes the QR code during sign-in-with-QR | npm maintainers `jefff`, `templaedhel` |
| `qrcode` | 1.5.4 (2024-08) | renders the QR code for the other sign-in participant | npm maintainers `soldair`, `vigreco` |

Two notes: 

**1. Encrypted attachments:** files posted to
the room are decrypted locally with `matrix-encrypt-attachment` (the
Matrix spec's AES-CTR + SHA-256 attachment scheme); keys come from the
event itself and are never logged — the plaintext body of a message or
file is treated as model input only and never posted back. The package
has seen no release since 2022; it is small, spec-stable, and maintained
inside the Matrix.org org — if that changes, a replacement is a decision
we will make deliberately, not silently.

**2. QR encode/decode:** `jsqr` + `qrcode` are kept rather than hand-rolled
because this is crypto-adjacent code we do not want to own; both are
small and stable.

## Optional integrations 

- `@juicesharp/rpiv-ask-user-question`, subagent extensions, the voice engine
-> are declared as optional peers and only load when installed.
- The host-provided packages (`pi-coding-agent`,`pi-tui`, `typebox`) are declared 
peers your Pi install supplies — the extension never installs them itself.
- `src/qr2025/` is vendored upstream prototype code, carrying its original headers
and attribution in `NOTICE`.

## Out of scope

Issues that only affect homeservers you do not control, and reports
against optional peer packages maintained elsewhere, are handled by those
maintainers — we will help route them.
