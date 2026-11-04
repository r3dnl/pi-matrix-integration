/**
 * Tarball content gate (release story 16): the packed tarball must carry
 * exactly what the `files` allowlist in package.json declares — nothing
 * outside it, and everything the user needs inside it. One source for both
 * halves: the allowlist itself. `npm pack` is what publishes, so packing
 * the same way here is the honest rehearsal.
 *
 *   node tools/check-tarball.mjs            # packs into a temp dir itself
 *   node tools/check-tarball.mjs <dir>      # checks an already-unpacked package dir
 *
 * Exit 0 = clean; non-zero lists every violation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const unpacked = process.argv[2];
let dir = unpacked;
let tmp = null;
if (!dir) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "targate-"));
  execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: ROOT, stdio: "ignore" });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  execFileSync("tar", ["xzf", path.join(tmp, tgz), "-C", tmp], { stdio: "ignore" });
  dir = path.join(tmp, "package");
}

const patterns = pkg.files ?? [];
// npm's `files` also carries `!pattern` negations (art excluded from the
// tarball but kept in the repo); the gate mirrors that semantics: a
// negation neither covers a shipped path nor demands an existence check.
const includes = patterns.filter((f) => !f.startsWith("!"));
const excludes = patterns.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
const globRe = (g) =>
  new RegExp(
    "^" +
      (g.match(/\*\*|\*|[^*]+/g) ?? [])
        .map((p) => (p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );
const covered = (rel) =>
  includes.some((f) => rel === f || rel === path.dirname(f) || rel.startsWith(`${f}/`)) &&
  !excludes.some((g) => globRe(g).test(rel));

const walk = (d, acc = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(path.relative(dir, p).split(path.sep).join("/"));
  }
  return acc;
};

const problems = [];

// 1. nothing outside the allowlist (package.json itself is npm's own entry)
for (const rel of walk(dir)) {
  if (rel === "package.json") continue;
  if (!covered(rel)) problems.push(`shipped but not in the files allowlist: ${rel}`);
}

// 2. the allowlist's own entries really exist (a stale entry means the pack
//    silently lost a directory that was renamed or deleted)
for (const f of includes) {
  if (!fs.existsSync(path.join(dir, f))) problems.push(`allowlisted but missing from the tarball: ${f}`);
}

// 3. the set a cold install and the license rules depend on
const required = [
  "package.json",
  "index.ts",
  "LICENSE",
  "NOTICE",
  "CHANGELOG.md",
  "README.md",
  "QUICKSTART.md",
  "patches/rpiv-ask-user-question/apply.sh",
];
for (const f of required) {
  if (!fs.existsSync(path.join(dir, f))) problems.push(`required file missing from the tarball: ${f}`);
}

if (tmp) fs.rmSync(tmp, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`tarball content gate: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("tarball content gate OK: allowlist containment, allowlist completeness, required set");
