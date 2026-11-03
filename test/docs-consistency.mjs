/**
 * Documentation consistency gate.
 *
 * Four checks, all cheap and all catching real mistakes in this tree:
 *
 *   1. Internal links resolve — every relative path and #anchor used in the
 *      markdown actually exists in the shipped tree.
 *   2. No internal identifier ships — maintainer-only hostnames, account
 *      names and environment names must not appear in source, docs or README.
 *      Examples use matrix.example.org instead.
 *   3. No review-ticket labels in source comments — a comment must name the
 *      event it means, not the id its planning tree minted for it.
 *   4. No references that go stale in place — a comment that points at a line
 *      number or a commit sha resolves to nothing once the history or the
 *      layout moves. Point at a symbol name instead.
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

const DOC_ROOTS = ['README.md', 'QUICKSTART.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'docs']

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
// Every shipped file is held to the rule: docs are written for publication,
// the source-comment scrub removed every historical reference, and the
// user-facing rewrite cleared README.md and QUICKSTART.md. No file has an
// excuse any more.
const STRICT = [
  'README.md', 'QUICKSTART.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json',
  ...walk('docs').filter(f => f.endsWith('.md')),
  ...walk('src').filter(f => /\.(ts|mjs)$/.test(f)),
  ...walk('index.ts'),
]

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

// --- 3. review-ticket labels in source comments ---
// Ids like FINDING-<n>, a BUG-<NAME> branch tag, a reviewer-table row, a
// backlog number or a migration phase number resolve to nothing for anyone
// outside the tree that minted them. The reason behind the id is public; the
// id is not. The `A<major>.<minor>-<nnnn>` form is a dependency's local
// patch-kit scheme: it names a hunk that exists only in a patched
// node_modules, never in the published package a reader installs.
const TICKET_LABEL =
  /\b(?:FINDING|REVIEW)-\d+\b|\bBUG-[A-Z][A-Z-]{4,}\b|\breviewer row [A-Z]?\d+\b|\bbacklog #\d+|\bphase[- –]?\d+\b|\b[A-Z]\d phase \d|\bD\d+\b|\bU-\d+\b|\bG\d+\b|\boption [A-Z]\b|\bfeedback round \d|\b[A-Z]{4,}-(?:DECISION|DESIGN|PLAN)\b|\bgate, G\d|\bA\d+\.\d+-\d{4}\b/i

const SOURCE_FILES = [...walk('src').filter(f => /\.ts$/.test(f)), 'index.ts']
let labelHits = 0
for (const file of SOURCE_FILES) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!/^\s*(\/\/|\/?\*+|\/\*)/.test(line)) return // comments only, never code
    const m = TICKET_LABEL.exec(line)
    if (m) {
      fail(`${file}:${i + 1}: comment cites the internal ticket "${m[0]}"`)
      labelHits++
    }
  })
}

// --- 4. references that go stale in place ---
// `markdown.ts:159` named the right place the day it was written and nothing
// after. A commit sha is the same failure with a longer fuse: this repo's
// history starts at its own first commit, so a sha copied in from the tree the
// code came from resolves to no object here. Symbol names are the durable form.
// src/qr2025/ is excluded: it is vendored Matrix.org code and its header sha is
// the upstream spec tip the files were taken from, which is provenance.
const OUR_SOURCE = SOURCE_FILES.filter((f) => !f.includes('qr2025'))
const LINE_POINTER = /[\w./-]+\.(?:ts|mjs|js|json):\d+/
const COMMIT_SHA = /(?![#\w.])[0-9a-f]{7,40}(?![\w.])/gi
let staleHits = 0
for (const file of OUR_SOURCE) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!/^\s*(\/\/|\/?\*+|\/\*)/.test(line)) return // comments only, never code
    const pointer = LINE_POINTER.exec(line)
    if (pointer) {
      fail(`${file}:${i + 1}: comment points at a line number "${pointer[0]}" — name the symbol instead`)
      staleHits++
      return
    }
    const sha = COMMIT_SHA.exec(line)
    if (sha) {
      fail(`${file}:${i + 1}: comment cites a commit sha "${sha[0]}" — this repo's history does not contain it`)
      staleHits++
    }
  })
}

// --- 5. the documented surface equals the registered surface ---
// The README command table and the alias line must name exactly what
// src/commands.ts registers (commands + aliases), and every PI_MATRIX_*
// environment name in the docs must exist in the code — and every key of
// the code's env mapping must appear in the configuration reference.
{
  const commandsSrc = fs.readFileSync(path.join(ROOT, 'src/commands.ts'), 'utf8')
  const registered = new Set()
  for (const m of commandsSrc.matchAll(/registerCommand\(\s*"([^"]+)"/g)) registered.add(m[1])

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const cmdSection = readme.split(/^### Commands$/m)[1]?.split(/^### /m)[0] ?? ''
  const documented = new Set()
  for (const m of cmdSection.matchAll(/`(\/(?:matrix-[a-z-]+|pi-help))(?:[^`]*)`/g)) documented.add(m[1].slice(1))
  for (const name of registered) {
    if (!documented.has(name)) fail(`README documents no /${name} though src/commands.ts registers it`)
  }
  for (const name of documented) {
    if (!registered.has(name)) fail(`README documents /${name} but src/commands.ts does not register it`)
  }
  // The /matrix-help guide is the room's own copy of the surface: it must
  // mention every registered command (room-reachability means nothing if
  // the room cannot discover it) and no command that does not exist.
  const helpSrc = fs.readFileSync(path.join(ROOT, 'src/matrix-help.ts'), 'utf8')
  const inHelp = new Set()
  for (const m of helpSrc.matchAll(/\/(matrix-[a-z-]+|pi-help)\b/g)) inHelp.add(m[1])
  for (const name of registered) {
    if (!inHelp.has(name)) fail(`/matrix-help guide never mentions /${name} though src/commands.ts registers it`)
  }
  for (const name of inHelp) {
    if (!registered.has(name)) fail(`/matrix-help guide mentions /${name} but src/commands.ts does not register it`)
  }

  const configUtils = fs.readFileSync(path.join(ROOT, 'src/config-utils.ts'), 'utf8')
  const envMap = new Set()
  for (const m of configUtils.matchAll(/^\s*(PI_MATRIX_[A-Z0-9_]+): '/gm)) envMap.add(m[1])
  // raw reads outside the mapping table (e.g. the sub-agent provider override)
  for (const f of walk('src').filter(f => f.endsWith('.ts'))) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/process\.env\.(PI_MATRIX_[A-Z0-9_]+)/g)) envMap.add(m[1])
  }
  // test seams and developer-facing keys are documented under docs/dev, not
  // in the user configuration reference
  const devDocs = walk('docs/dev').filter(f => f.endsWith('.md'))
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')

  const ref = fs.readFileSync(path.join(ROOT, 'docs/user/configuration.md'), 'utf8')
  const readmeEnv = new Set()
  for (const f of ['README.md', 'QUICKSTART.md', 'docs/user/configuration.md', 'docs/user/troubleshooting.md', 'docs/user/ask-user-pairing.md']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    for (const m of text.matchAll(/\bPI_MATRIX_[A-Z0-9_]+\b/g)) {
      if (!envMap.has(m[0])) fail(`${f}: documents ${m[0]} which no code reads`)
      readmeEnv.add(m[0])
    }
  }
  for (const name of envMap) {
    if (!readmeEnv.has(name) && !devDocs.includes(name)) fail(`docs/user/configuration.md does not document ${name}`)
  }
}

// --- 6. AGENTS.md names exactly the npm scripts that exist ---
// The working contract's loop must be runnable: every command it prints
// exists, and every script the package has appears in the contract.
{
  const scripts = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts))
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
  const named = new Set()
  for (const m of agents.matchAll(/npm run ([a-z][a-z:-]+)/g)) named.add(m[1])
  if (/^\s*npm test/m.test(agents)) named.add('test')
  for (const name of named) {
    if (!scripts.has(name)) fail(`AGENTS.md names \`npm run ${name}\` but package.json has no such script`)
  }
  for (const name of scripts) {
    if (!named.has(name)) fail(`package.json script ${name} is missing from AGENTS.md's loop`)
  }
}

console.log(`checked ${markdown.length} markdown files (${linkCount} internal links); identifier scan: ${STRICT.length} files strict (${strictHits.length} hits); ticket-label scan: ${SOURCE_FILES.length} files (${labelHits} hits); stale-reference scan: ${OUR_SOURCE.length} files (${staleHits} hits); surface: README commands + /matrix-help guide + AGENTS.md commands + PI_MATRIX_* keys cross-checked against src/`) 
if (failures > 0) {
  console.log(`\n${failures} documentation-consistency failure(s)`)
  process.exit(1)
}
console.log('OK  links resolve, no internal identifiers or stale references in the shipped tree')
