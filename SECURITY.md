# Security Policy

## Reporting a vulnerability

Report security issues privately through
[GitHub security advisories](https://github.com/r3dnl/pi-matrix-integration/security/advisories/new)
— not a public issue. Expected response: an acknowledgement within three
working days and a status update (fixed, declined, or needs coordination
with the Matrix homeserver or the Pi host) within ten.

## What this extension touches

`pi-matrix-integration` connects a running Pi coding agent to a Matrix
room. Two boundaries are worth understanding before you install it.

**A connected room is an input channel to your agent.** Anyone who can
post in the room can talk to the agent, and everything posted there —
messages, files, thread replies — becomes model input. That includes
slash commands: every command this extension registers is reachable from
the room by any room member, as are the commands of every other
installed extension. Room membership is the access control: the extension
adds no allowlist of its own. Invite only people you want talking to your
agent, keep the room invite-only, and let the agent use its own account.

**Credentials live outside the package.** Login tokens and passphrases are
stored in the local configuration directory (file mode `0600`) or read
from environment variables. No credential is ever bundled: the repository
and the published tarball are scanned on every push, and the scan also
runs against the unpacked npm artifact.

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

Two notes reviewers ask for. **Encrypted attachments:** files posted to
the room are decrypted locally with `matrix-encrypt-attachment` (the
Matrix spec's AES-CTR + SHA-256 attachment scheme); keys come from the
event itself and are never logged — the plaintext body of a message or
file is treated as model input only and never posted back. The package
has seen no release since 2022; it is small, spec-stable, and maintained
inside the Matrix.org org — if that changes, a replacement is a decision
we will make deliberately, not silently.

**QR encode/decode:** `jsqr` + `qrcode` are kept rather than hand-rolled
because this is crypto-adjacent code we do not want to own; both are
small and stable.

Optional integrations (`@juicesharp/rpiv-ask-user-question`, subagent
extensions, the voice engine) are declared as optional peers and only
load when installed. The host-provided packages (`pi-coding-agent`,
`pi-tui`, `typebox`) are declared peers your Pi install supplies — the
extension never installs them itself. `src/qr2025/` is vendored upstream
prototype code, carrying its original headers and attribution in `NOTICE`.

## Out of scope

Issues that only affect homeservers you do not control, and reports
against optional peer packages maintained elsewhere, are handled by those
maintainers — we will help route them.
