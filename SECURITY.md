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
messages, files, thread replies — becomes model input. Room membership is
the access control: the extension adds no allowlist of its own. Invite
only people you want talking to your agent, and prefer invite-only rooms.

**Credentials live outside the package.** Login tokens and passphrases are
stored in the local configuration directory (file mode `0600`) or read
from environment variables. No credential is ever bundled: the repository
and the published tarball are scanned on every push, and the scan also
runs against the unpacked npm artifact.

## Runtime dependencies

Five packages are installed with every version of this extension; all are
public npm packages with the upstream projects as maintainers:

- `matrix-js-sdk` and `@matrix-org/matrix-sdk-crypto-wasm` — Matrix client
  and encryption (Matrix.org Foundation)
- `matrix-encrypt-attachment` — encrypted file attachments (Matrix.org Foundation)
- `jsqr` and `qrcode` — QR sign-in and QR rendering

Optional integrations (`@juicesharp/rpiv-ask-user-question`, subagent
extensions, the voice engine) are declared as optional peers and only
load when installed. `src/qr2025/` is vendored upstream prototype code,
carrying its original headers and attribution in `NOTICE`.

A stricter supply-chain review (audited dependency inventory, lockfile
bot automation) is tracked as open work for this release; this file will
carry the inventory it produces.

## Out of scope

Issues that only affect homeservers you do not control, and reports
against optional peer packages maintained elsewhere, are handled by those
maintainers — we will help route them.
