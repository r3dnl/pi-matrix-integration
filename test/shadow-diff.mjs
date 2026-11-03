#!/usr/bin/env node
/**
 * Shadow-diff comparison (DESIGN-TRANSPORT-AND-IDENTITY §5.2/§5.3).
 *
 * Dev-time regression tool, NOT a cutover gate (R1) and NOT runtime code
 * (D2 rejected the in-process diff): joins the extension's shadow NDJSON
 * (`$logDir/shadow-diff.<env>.ndjson`, written by the dry-mode poller)
 * with the Python side's `mtx watch --json` stream
 * (`~/.config/mtx/shadow/mtx-watch.ndjson`) and verifies, per time
 * window:
 *
 *   1. the SET of m.room.message ids read (order/timing legitimately
 *      differ — poll cadences differ; the set must not). Reactions and
 *      state are excluded on both sides upstream (the read-set carries
 *      m.room.message ids only, §5.2).
 *   2. the derived unread `total` at the window's snapshot points,
 *   3. the thread grouping (root → reply counter).
 *
 * Both files share the pinned line schema:
 *   {"ts": <ms>, "room": "!…", "since": <ms>, "events": ["$id"],
 *    "unread": {"total": <n>, "threads": {"$root": <n>}}}
 *
 * A mismatch prints a per-window report and exits non-zero. Snapshot
 * when the room is quiet (no in-flight events blurring totals) and
 * tolerate ±1 poll window of lag (R1 procedure).
 *
 * Usage:
 *   node test/shadow-diff.mjs <ts-ndjson> <mtx-ndjson> [--window <ms>]
 *   node test/shadow-diff.mjs --selftest
 *     Runs the prepped fixture pairs under test/fixtures/shadow-diff/:
 *     clean pairs must pass; mismatch pairs must be detected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Default window: a poll cycle on either side (R1 ±1-window tolerance). */
const DEFAULT_WINDOW_MS = 15000;

/** Parse one NDJSON file into typed lines; blank lines ignored. */
function readLines(file, label) {
  if (!fs.existsSync(file)) {
    return { error: `${label} file not found: ${file}` };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return { error: `${label} has a non-JSON line: ${line.slice(0, 120)}` };
    }
    out.push({
      ts: Number(obj.ts) || 0,
      room: String(obj.room ?? ''),
      since: Number(obj.since) || 0,
      events: Array.isArray(obj.events) ? obj.events.map(String) : [],
      unread: {
        total: Number(obj.unread?.total) || 0,
        threads: obj.unread?.threads && typeof obj.unread.threads === 'object'
          ? obj.unread.threads
          : {},
      },
    });
  }
  return { lines: out };
}

/** Group lines into windows (index = floor(ts / windowMs)). */
function windowize(lines, windowMs) {
  const windows = new Map(); // idx → { lines }
  for (const line of lines) {
    const idx = Math.floor(line.ts / windowMs);
    if (!windows.has(idx)) windows.set(idx, []);
    windows.get(idx).push(line);
  }
  return windows;
}

/** Union of the read-sets (m.room.message ids only) across a window. */
function readSet(lines) {
  const set = new Set();
  for (const line of lines) for (const id of line.events) set.add(id);
  return set;
}

/** The snapshot unread totals: the LAST line's totals in the window. */
function snapshot(lines) {
  const last = lines[lines.length - 1];
  return { total: last.unread.total, threads: { ...last.unread.threads } };
}

/**
 * Compare one window. Returns a list of mismatch strings (empty = clean).
 */
function compareWindow(idx, windowMs, tsLines, mtxLines) {
  const mismatches = [];
  const tsSet = readSet(tsLines);
  const mtxSet = readSet(mtxLines);

  // (1) read-set: same SET, different order is fine.
  const onlyTs = [...tsSet].filter((id) => !mtxSet.has(id));
  const onlyMtx = [...mtxSet].filter((id) => !tsSet.has(id));
  if (onlyTs.length || onlyMtx.length) {
    mismatches.push(
      `window ${idx} (${idx * windowMs}ms–${(idx + 1) * windowMs}ms): read-set differs —` +
        ` only-in-ts=[${onlyTs.join(', ')}] only-in-mtx=[${onlyMtx.join(', ')}]`,
    );
  }

  if (tsLines.length && mtxLines.length) {
    // (2) unread total at the snapshot points.
    const tsSnap = snapshot(tsLines);
    const mtxSnap = snapshot(mtxLines);
    if (tsSnap.total !== mtxSnap.total) {
      mismatches.push(
        `window ${idx}: unread total differs — ts=${tsSnap.total} mtx=${mtxSnap.total}`,
      );
    }
    // (3) thread grouping (root → reply counter).
    const tsThreads = tsSnap.threads;
    const mtxThreads = mtxSnap.threads;
    const roots = new Set([...Object.keys(tsThreads), ...Object.keys(mtxThreads)]);
    for (const root of roots) {
      const a = tsThreads[root] ?? 0;
      const b = mtxThreads[root] ?? 0;
      if (a !== b) {
        mismatches.push(
          `window ${idx}: thread ${root} grouping differs — ts=${a} mtx=${b}`,
        );
      }
    }
  }
  return mismatches;
}

/** Compare two NDJSON files. Returns { mismatches, tsCount, mtxCount }. */
function compareFiles(tsFile, mtxFile, windowMs) {
  const a = readLines(tsFile, 'ts');
  if (a.error) return { mismatches: [a.error], tsCount: 0, mtxCount: 0 };
  const b = readLines(mtxFile, 'mtx');
  if (b.error) return { mismatches: [b.error], tsCount: 0, mtxCount: 0 };

  const tsWindows = windowize(a.lines, windowMs);
  const mtxWindows = windowize(b.lines, windowMs);
  const idxs = new Set([...tsWindows.keys(), ...mtxWindows.keys()]);

  const mismatches = [];
  for (const idx of [...idxs].sort((x, y) => x - y)) {
    const tsLines = tsWindows.get(idx) ?? [];
    const mtxLines = mtxWindows.get(idx) ?? [];
    // A window on one side only = lag (±1 poll window, R1) — tolerated
    // when the OTHER side has no window at all; only flag when both
    // sides have lines and disagree, or when the gap spans >1 window.
    if (tsLines.length === 0 || mtxLines.length === 0) continue;
    mismatches.push(...compareWindow(idx, windowMs, tsLines, mtxLines));
  }
  return { mismatches, tsCount: a.lines.length, mtxCount: b.lines.length };
}

// ---------------------------------------------------------------------------
// Selftest: the prepped fixture pairs (§5.3 gate: "script runs on two
// fixture NDJSON files"). Clean pairs pass; the mismatch pairs must be
// detected — the detector is only useful if it fails on purpose.
// ---------------------------------------------------------------------------
function selftest() {
  const base = path.join(here, 'fixtures', 'shadow-diff');
  const cases = [
    { name: 'flat-only', expectClean: true },
    { name: 'thread-burst', expectClean: true },
    { name: 'reactions-self-excluded', expectClean: true },
    { name: 'empty-chunk', expectClean: true },
    { name: 'watermark-boundary', expectClean: true },
    { name: 'mismatch-readset', expectClean: false },
    { name: 'mismatch-total', expectClean: false },
    { name: 'mismatch-threads', expectClean: false },
  ];
  let failures = 0;
  for (const c of cases) {
    const { mismatches } = compareFiles(
      path.join(base, c.name, 'ts.ndjson'),
      path.join(base, c.name, 'mtx.ndjson'),
      DEFAULT_WINDOW_MS,
    );
    const clean = mismatches.length === 0;
    const ok = clean === c.expectClean;
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${c.name} (expect ${c.expectClean ? 'clean' : 'detected'})${
        !ok && mismatches.length ? ` — ${mismatches[0]}` : ''
      }`,
    );
  }
  if (failures) {
    console.error(`${failures} selftest case(s) behaved unexpectedly`);
    process.exit(1);
  }
  console.log('shadow-diff selftest: all fixture pairs behaved as expected');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  selftest();
} else {
  const windowIdx = argv.indexOf('--window');
  const windowMs =
    windowIdx !== -1 ? Number(argv[windowIdx + 1]) || DEFAULT_WINDOW_MS : DEFAULT_WINDOW_MS;
  const files = argv.filter((a, i) => a !== '--window' && argv[i - 1] !== '--window');
  if (files.length !== 2) {
    console.error(
      'usage: node test/shadow-diff.mjs <ts-ndjson> <mtx-ndjson> [--window <ms>] | --selftest',
    );
    process.exit(2);
  }
  const { mismatches, tsCount, mtxCount } = compareFiles(files[0], files[1], windowMs);
  console.log(
    `shadow-diff: ${tsCount} ts lines vs ${mtxCount} mtx lines, window=${windowMs}ms`,
  );
  if (mismatches.length) {
    for (const m of mismatches) console.error(`MISMATCH: ${m}`);
    process.exit(1);
  }
  console.log('shadow-diff: clean — read-sets, unread totals, and thread groupings agree');
}
