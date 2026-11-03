#!/usr/bin/env node
// Credential scan (release story 4): no credential-shaped literal may
// exist anywhere in the public tree or the published tarball.
//
//   node tools/scan-secrets.mjs                 # scan the git tree
//   node tools/scan-secrets.mjs --dir package   # scan an unpacked tarball
//   node tools/scan-secrets.mjs --self-check    # prove the scan bites
//
// CI runs all three: tree scan first, then the same scan over the
// `npm pack` tarball unpacked, so a stray `files` entry cannot publish a
// credential the checkout scan missed. Exit 1 lists every hit as
// file:line. Documentation is scanned too — docs are where a real server
// password is most likely to be pasted.

import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";

// A key-ish name, then a short gap, then an assignment of a value ≥6 chars.
const PATTERN =
  /(access_token|password|passphrase|api_?key|secret)\W{0,4}[:=]\W{0,2}(["']?)([^\s"',]{6,})/gi;
// Values that are placeholders by their own spelling (`your_…`, `${…}`, …).
const PLACEHOLDER = /^(your|xxx|example|null|undefined|true|false|process|config|this|\$\{|\[|\{|\()/i;
// Known-fake fixture values, pinned by the release plan (story 4). These
// are the only credential-shaped literals allowed in the shipped tree;
// growing this list is a review decision, never a silent edit to green CI.
const ALLOWED = new Set([
  "syt_tok_123",
  "syt_fixture_access_token",
  "correct",
  // self-describing fakes used by the offline test tier:
  "test-passphrase",
  "deliberately-wrong",
  "fake-token",
]);
const EXTENSIONS = /\.(ts|js|mjs|cjs|json|jsonc|md|yml|yaml)$/;
// In code files an UNQUOTED value is always a variable, member access or
// type name (`passphrase: string`, `access_token: r.access_token`) — never
// a literal. Docs and YAML configs are different: `password: hunter2` is a
// real literal there, so unquoted values count in those files.
const CODE_FILE = /\.(ts|js|mjs|cjs)$/;
const BARE_CODE_REF = /^[A-Za-z_$][\w$.]*$/;
// This scanner quotes the fake values and the pattern; it never scans itself.
const SELF = "tools/scan-secrets.mjs";

function listFiles(root, fromGit) {
  if (fromGit) {
    return cp
      .execSync("git ls-files .", { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .map((f) => path.join(root, f));
  }
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(root);
  return out;
}

export function scanFile(absPath, relPath) {
  const hits = [];
  let text;
  try {
    text = fs.readFileSync(absPath, "utf8");
  } catch {
    return hits;
  }
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(text))) {
    const [, key, quote, raw] = m;
    // Trailing punctuation is never part of the value (`string;`, `flows.some(`).
    const value = raw.replace(/[.,;:)?\]}(]+$/g, "");
    if (!quote && CODE_FILE.test(relPath) && BARE_CODE_REF.test(value)) continue;
    if (PLACEHOLDER.test(value) || ALLOWED.has(value)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    hits.push(`${relPath}:${line}: ${key} = ${value.slice(0, 4)}*** (len ${value.length})`);
  }
  return hits;
}

function scan(root, fromGit) {
  const hits = [];
  for (const abs of listFiles(root, fromGit)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!EXTENSIONS.test(rel) || rel === SELF) continue;
    hits.push(...scanFile(abs, rel));
  }
  return hits;
}

function selfCheck() {
  // One planted fake must bite, one placeholder must not — the scan that
  // cannot report cannot gate. Assert-based; exits non-zero on regression.
  const dir = fs.mkdtempSync("/tmp/scan-selfcheck-");
  const file = path.join(dir, "planted.json");
  fs.writeFileSync(
    file,
    'homeserver: "https://example.test"\npassword: "Pp_planted_fake_9"\napi_key: "your_api_key_here"\n',
  );
  const found = scanFile(file, "planted.json");
  fs.rmSync(dir, { recursive: true, force: true });
  if (!found.some((h) => /password/.test(h))) {
    throw new Error(`self-check: planted fake not detected (${found})`);
  }
  if (found.some((h) => /api_?key/.test(h))) {
    throw new Error(`self-check: placeholder flagged (${found})`);
  }
  console.log("scan-secrets self-check OK: planted fake caught, placeholder ignored");
}

const args = process.argv.slice(2);
if (args.includes("--self-check")) {
  selfCheck();
} else {
  const dirIdx = args.indexOf("--dir");
  const root = dirIdx >= 0 ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const hits = scan(root, dirIdx < 0);
  for (const h of hits) console.error(h);
  if (hits.length) {
    console.error(`scan-secrets: ${hits.length} credential-shaped literal(s) — build fails (story 4)`);
    process.exit(1);
  }
  console.log(`scan-secrets: clean (${root})`);
}
