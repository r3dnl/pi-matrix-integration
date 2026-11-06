# tools/ — release-safety scripts

Nothing here is part of the extension. These are standalone gates that run
in CI (or by hand) before anything is published.

**SCQ**

- **Situation:** This project publishes an npm package that talks to Matrix
  servers, so it handles access tokens and a vendored copy of upstream SDK
  code.
- **Complication:** Humans paste passwords into docs, `npm pack` can
  silently ship or drop the wrong files, and the vendored SDK snapshot can
  quietly become obsolete when upstream finally ships the missing feature.
- **Question:** How do we catch those three failure modes automatically,
  before anything is published?
- **Answer:** Three small gate scripts in this directory, wired into
  `.github/workflows/`.

## scan-secrets.mjs

Searches every code, config, and markdown file for anything that looks
like a real credential — `password: "..."`, `access_token: "..."`, API
keys. Obvious placeholders (`your_...`, `example`) and a small pinned list
of known-fake test values are allowed. It scans both the git checkout and
the built tarball, so a stray file entry cannot publish a secret the
checkout scan missed. A `--self-check` mode plants a fake secret to prove
the scanner actually bites.

```
node tools/scan-secrets.mjs                 # scan the git tree
node tools/scan-secrets.mjs --dir package   # scan an unpacked tarball
node tools/scan-secrets.mjs --self-check    # prove the scan bites
```

Runs in `ci.yml` and `release.yml`.

## check-tarball.mjs

Rehearses the release: runs `npm pack` into a temp folder and checks the
contents three ways.

1. Nothing shipped that is not in package.json's `files` allowlist.
2. Nothing allowlisted that is missing — a stale entry after a rename
   means content silently vanished from the package.
3. A fixed required set (`package.json`, `index.ts`, `LICENSE`, `NOTICE`,
   `CHANGELOG.md`, `README.md`, `QUICKSTART.md`, the ask-user-question
   patch) is present.

```
node tools/check-tarball.mjs            # packs into a temp dir itself
node tools/check-tarball.mjs <dir>      # checks an already-unpacked package dir
```

Runs in `ci.yml` and `release.yml`.

## check-vendored.mjs

`src/qr2025/` is a hand-copied snapshot of Matrix SDK prototype code
(MSC4388 QR sign-in), kept only because the real packages lack the secure
QR sign-in feature. This script imports the *installed* SDK packages and
asks: do they export the missing classes yet? If yes, the copy is obsolete
and the script fails with instructions to delete it. It checks named
exports, not text greps, so an upstream refactor cannot fool it into a
false pass.

```
node tools/check-vendored.mjs
```

Known gap: its header comment claims it "runs weekly in
`.github/workflows/live-nightly.yml`" — it does not. No workflow calls it,
so the weekly expiry check never actually runs.
