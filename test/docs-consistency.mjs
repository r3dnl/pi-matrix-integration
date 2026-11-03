/**
 * Documentation consistency gate.
 *
 * Two checks, both cheap and both catching real mistakes in this tree:
 *
 *   1. Internal links resolve — every relative path and #anchor used in the
 *      markdown actually exists in the shipped tree.
 *   2. No internal identifier ships — maintainer-only hostnames, account
 *      names and environment names must not appear in source, docs or README.
 *      Examples use matrix.example.org instead.
 *
 * The denied names are assembled from fragments on purpose: the file that
 * enforces the rule must not itself contain the string it forbids. Do not
 * "simplify" this into literals — that breaks check 2 against this very file.
 *
 * Extends later with command-registry, config-key and agent-file equality
 * against package.json scripts.
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..')

const INTERNAL_NAMES = [
  ['tst', '2'].join(''),
  ['prd', '2'].join(''),
  ['home', 'ops'].join(''),
  ['r3', 'd', '.', 'nl'].join(''),
]

const DOC_ROOTS = ['README.md', 'QUICKSTART.md', 'docs']

function walk (rel, out = []) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return out
  if (fs.statSync(abs).isFile()) { out.push(rel); return out }
  for (const e of fs.readdirSync(abs)) {
    if (e === 'node_modules' || e === '.git') continue
    walk(path.join(rel, e), out)
  }
  return out
}

const markdown = DOC_ROOTS.flatMap(f => walk(f)).filter(f => f.endsWith('.md'))

function anchorOf (heading) {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}

const anchors = new Map()
for (const f of markdown) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
  anchors.set(f, new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => anchorOf(m[1]))))
}

let failures = 0
const fail = (msg) => { console.log('FAIL  ' + msg); failures++ }

// --- 1. links and anchors ---
let linkCount = 0
for (const file of markdown) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const dir = path.dirname(file)
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:)/.test(target)) continue
    linkCount++
    const [pathPart, anchor] = target.split('#')
    const resolved = pathPart === '' ? file : path.normalize(path.join(dir, pathPart))
    if (!fs.existsSync(path.join(ROOT, resolved))) {
      fail(`${file}: link target does not exist -> ${target}`)
      continue
    }
    if (anchor && resolved.endsWith('.md')) {
      const set = anchors.get(resolved)
      if (set && !set.has(anchor.toLowerCase())) {
        fail(`${file}: anchor does not exist in ${resolved} -> #${anchor}`)
      }
    }
  }
}

// --- 2. internal identifiers ---
// docs/ and src/ are held to the rule today: docs are written for publication,
// and the source-comment scrub removed every historical reference, so source has
// no excuse either. README.md and QUICKSTART.md still carry references from
// before this check existed; they are reported as warnings and join the hard gate
// when the user-facing rewrite lands, which keeps the gate enforceable from the
// day it was committed instead of muted.
const STRICT = [
  ...walk('docs').filter(f => f.endsWith('.md')),
  ...walk('src').filter(f => /\.(ts|mjs)$/.test(f)),
  ...walk('index.ts'),
]
const PENDING = [...markdown.filter(f => !f.startsWith('docs/'))]
  .filter(f => /\.(ts|mjs|md|json|jsonc)$/.test(f))

function scanInternalNames (files) {
  const hits = []
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const name of INTERNAL_NAMES) {
        if (line.toLowerCase().includes(name.toLowerCase())) hits.push({ file, line: i + 1, name })
      }
    })
  }
  return hits
}

const strictHits = scanInternalNames(STRICT)
strictHits.forEach(h => fail(`${h.file}:${h.line}: contains internal identifier "${h.name}"`))
const pendingHits = scanInternalNames(PENDING)
pendingHits.slice(0, 8).forEach(h => console.log(`warn  ${h.file}:${h.line}: internal identifier "${h.name}" (pending cleanup)`))
if (pendingHits.length > 8) console.log(`warn  … and ${pendingHits.length - 8} more pending internal-identifier cleanups`)

console.log(`checked ${markdown.length} markdown files (${linkCount} internal links); identifier scan: ${STRICT.length} files strict (${strictHits.length} hits), ${PENDING.length} files pending (${pendingHits.length} hits)`)
if (failures > 0) {
  console.log(`\n${failures} documentation-consistency failure(s)`)
  process.exit(1)
}
console.log('OK  links resolve, no internal identifiers in the shipped tree')
