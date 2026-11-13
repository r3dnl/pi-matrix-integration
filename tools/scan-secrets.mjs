#!/usr/bin/env node
// Credential and identity scan (release story 4): no credential-shaped
// literal may exist anywhere in the public tree or the published tarball, and
// nothing may identify one real deployment.
//
//   node tools/scan-secrets.mjs                     # scan the git tree
//   node tools/scan-secrets.mjs --dir package       # scan an unpacked tarball
//   node tools/scan-secrets.mjs --history           # scan every git object
//   node tools/scan-secrets.mjs --registry <path>   # add a private-identifier list
//   node tools/scan-secrets.mjs --self-check        # prove the scan bites
//
// CI runs the tree scan, the self-check and the tarball scan on every push.
// `--history` walks the whole object database (reachable and not), which is
// too slow for a per-push gate, so the nightly workflow runs it instead — the
// tree scan cannot see a credential that a later commit deleted.
//
// Every file is scanned, not a whitelist of extensions: the places a real
// password actually gets pasted (`*.env.example`, fixtures, patches, scripts)
// are exactly the ones an extension list skips. Binaries and oversized files
// are skipped by content, not by name.
//
// Findings never echo the matched value. A scanner that prints a credential
// prefix turns the CI log into the leak it was meant to prevent.

import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";

// A key-ish name, then a short gap, then an assignment of a value ≥6 chars.
// The gap is captured so `<REPLACE-ME>` is recognised as a placeholder: the
// `<` is a non-word character, so without it the value group starts at the
// letter after the bracket and the placeholder reads as a literal.
const PATTERN =
  /(access_token|password|passphrase|api_?key|secret)\W{0,4}[:=](\W{0,2})(["']?)([^\s"',]{6,})/gi;
// Values that are placeholders by their own spelling (`your_…`, `${…}`,
// `<REPLACE-ME>` — the angle-bracket convention the docker example files use).
const PLACEHOLDER = /^(your|xxx|example|null|undefined|true|false|process|config|this|\$\{|\[|\{|\(|<)/i;
// An UPPER_SNAKE name used as the value (`PI_MATRIX_PASSWORD`) is documentation
// pointing at an environment variable, not a credential. Real tokens mix case
// or are base64/hex; nothing a homeserver issues looks like a shell variable.
const ENV_NAME = /^[A-Z][A-Z0-9_]{5,}$/;
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
// In code files an UNQUOTED value is always a variable, member access or
// type name (`passphrase: string`, `access_token: r.access_token`) — never
// a literal. Docs and YAML configs are different: `password: hunter2` is a
// real literal there, so unquoted values count in those files.
const CODE_FILE = /\.(ts|js|mjs|cjs)$/;
const BARE_CODE_REF = /^[A-Za-z_$][\w$.]*$/;
// Binary by extension, then a content check: a NUL byte in the first 8 KB.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|mp4|webm|mov|mp3|wav|ogg|wasm|node|so|dylib|dll|bin|dat)$/i;
const MAX_BYTES = 8 * 1024 * 1024;
// This scanner quotes the fake values and the pattern; it never scans itself.
const SELF = "tools/scan-secrets.mjs";
// Where the private-identifier registry lives by default. Never committed:
// the point is that the values it holds are not supposed to be public.
const REGISTRY_DEFAULT = ".secrets/private-identifiers.txt";

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
      // Third-party trees are not our artifact; the tarball never
      // contains them, a checkout always does.
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(root);
  return out;
}

function isBinary(absPath) {
  if (!fs.existsSync(absPath)) return true; // a dangling symlink, like an unreadable file
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The credential-shaped-literal detector, over text already in memory. */
export function scanText(text, relPath) {
  const hits = [];
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(text))) {
    const [, key, gap, quote, raw] = m;
    // Trailing punctuation is never part of the value (`string;`, `flows.some(`).
    const value = raw.replace(/[.,;:)?\]}(]+$/g, "").replace(/>+$/, "");
    if (!quote && CODE_FILE.test(relPath) && BARE_CODE_REF.test(value)) continue;
    // `<REPLACE-ME>` in any spelling. Only a real `<` counts — a closing
    // bracket on its own would let a secret ending in `>` walk past.
    if (gap.includes("<") || raw.startsWith("<")) continue;
    if (ENV_NAME.test(value)) continue;
    if (PLACEHOLDER.test(value) || ALLOWED.has(value)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    hits.push(`${relPath}:${line}: ${key} assigned a ${value.length}-char literal`);
  }
  return hits;
}

/** Registry detector: identifiers from a file that is itself never committed. */
export function scanRegistry(text, relPath, identifiers) {
  const hits = [];
  identifiers.forEach((id, i) => {
    const at = text.indexOf(id);
    // One report per (content, entry): a hostname repeated across a spike
    // script is one finding, not forty, and the log stays readable.
    if (at === -1) return;
    const line = text.slice(0, at).split("\n").length;
    const total = text.split(id).length - 1;
    hits.push(`${relPath}:${line}: registry entry #${i + 1} (${id.length} chars) appears ${total}× in this content`);
  });
  return hits;
}

export function loadRegistry(p) {
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export function scanFile(absPath, relPath, identifiers) {
  let text;
  try {
    const st = fs.statSync(absPath);
    if (st.size > MAX_BYTES || BINARY_EXT.test(absPath) || isBinary(absPath)) return [];
    text = fs.readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  return scanText(text, relPath).concat(scanRegistry(text, relPath, identifiers));
}

function scan(root, fromGit, identifiers) {
  const hits = [];
  for (const abs of listFiles(root, fromGit)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel === SELF) continue;
    hits.push(...scanFile(abs, rel, identifiers));
  }
  return hits;
}

/**
 * Every blob in the object database, reachable or not: `git ls-files` only
 * ever sees the tip, so a credential committed once and deleted still twice
 * stays publishable-by-clone. Blob ids without a recorded path (rewritten or
 * unreachable objects) are reported by id alone.
 */
function scanHistory(cwd, identifiers) {
  const paths = new Map();
  const objects = cp.execSync("git rev-list --objects --all", { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  for (const line of objects.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0 && !paths.has(line.slice(0, sp))) paths.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const check = cp.execSync(`git cat-file --batch-all-objects --batch-check`, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const hits = [];
  let blobs = 0;
  for (const line of check.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type !== "blob" || Number(size) > MAX_BYTES) continue;
    blobs++;
    const rel = paths.get(sha) || `blob:${sha}`;
    if (rel === SELF) continue;
    let text;
    try {
      text = cp.execSync(`git cat-file blob ${sha}`, { cwd, encoding: "utf8", maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    hits.push(...scanText(text, rel).concat(scanRegistry(text, rel, identifiers)));
  }
  return { hits, blobs };
}

function selfCheck(identifiers) {
  // One planted fake must bite, one placeholder must not — the scan that
  // cannot report cannot gate. Assert-based; exits non-zero on regression.
  const dir = fs.mkdtempSync("/tmp/scan-selfcheck-");
  try {
    // A `.env.example` is the file type an extension whitelist used to skip.
    const planted = path.join(dir, "planted.env.example");
    fs.writeFileSync(
      planted,
      'HOMESERVER=https://example.test\npassword="Pp_planted_fake_9"\nAPI_KEY="your_api_key_here"\nREADER_PASSWORD=<DEMO-READER-PASSWORD>\nJUDGE_API_KEY=PI_MATRIX_JUDGE_API_KEY\nSECRET="Rot3ry_Master_Key"\n',
    );
    const found = scanFile(planted, "planted.env.example", identifiers);
    if (!found.some((h) => /password/.test(h))) throw new Error(`self-check: planted fake not detected (${found})`);
    if (found.some((h) => /api_?key/i.test(h))) throw new Error(`self-check: placeholder flagged (${found})`);
    // `<REPLACE-ME>` is a placeholder in any spelling. The `<` is a non-word
    // character, so it can land in the gap between key and value — which once
    // made the value group start after the bracket and read as a real literal.
    if (found.some((h) => /PASSWORD assigned/.test(h)))
      throw new Error(`self-check: angle-bracket placeholder flagged (${found})`);
    // An UPPER_SNAKE value names an environment variable, it is not a secret.
    if (found.some((h) => /JUDGE_API_KEY assigned/.test(h)))
      throw new Error(`self-check: env-var-name value flagged (${found})`);
    if (!found.some((h) => /SECRET assigned/.test(h)))
      throw new Error(`self-check: mixed-case planted secret missed (${found})`);

    // A registry entry must bite, and the value must never be echoed.
    const canary = "canary.invalid.host.example";
    const idHits = scanRegistry(`room: "#r:${canary}"`, "planted.md", [canary]);
    if (!idHits.length) throw new Error("self-check: registry identifier not detected");
    if (idHits.some((h) => h.includes(canary))) throw new Error("self-check: the scan echoed the identifier it matched");
    if (scanRegistry(`room: "#r:quiet.example.test"`, "planted.md", [canary]).length)
      throw new Error("self-check: registry flagged a value it does not contain");
    if (scanText(`password: "Pp_planted_fake_9"`, "planted.md").some((h) => h.includes("Pp_planted")))
      throw new Error("self-check: the scan echoed a credential value");

    // A binary must be skipped, not decoded.
    const bin = path.join(dir, "planted.bin");
    fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]));
    if (scanFile(bin, "planted.bin", []).length) throw new Error("self-check: binary file was scanned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const note = identifiers.length ? `, registry loaded (${identifiers.length} entries)` : ", no registry file present";
  console.log(`scan-secrets self-check OK: planted fake caught, placeholder ignored, registry bites, values masked${note}`);
}

const args = process.argv.slice(2);
const regIdx = args.indexOf("--registry");
const registryPath = path.resolve(
  regIdx >= 0 ? args[regIdx + 1] : path.join(process.cwd(), REGISTRY_DEFAULT),
);
const identifiers = loadRegistry(registryPath);

if (args.includes("--self-check")) {
  selfCheck(identifiers);
} else if (args.includes("--history")) {
  const { hits, blobs } = scanHistory(process.cwd(), identifiers);
  for (const h of hits) console.error(h);
  if (hits.length) {
    console.error(`scan-secrets --history: ${hits.length} finding(s) in ${blobs} blobs — history is dirty`);
    process.exit(1);
  }
  console.log(`scan-secrets --history: clean (${blobs} blobs, ${identifiers.length} registry entries)`);
} else {
  const dirIdx = args.indexOf("--dir");
  const root = dirIdx >= 0 ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const hits = scan(root, dirIdx < 0, identifiers);
  for (const h of hits) console.error(h);
  if (hits.length) {
    console.error(`scan-secrets: ${hits.length} credential-shaped literal(s) — build fails (story 4)`);
    process.exit(1);
  }
  console.log(`scan-secrets: clean (${root}, ${identifiers.length} registry entries)`);
}
