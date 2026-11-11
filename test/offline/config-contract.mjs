// Reviews the config v2 change surface by executing the real modules and
// scanning the real sources. Prints findings only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPiJiti } from "../harness/_harness.mjs";

const EXT = path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const SRC = path.join(EXT, "src");
const findings = [];
const add = (dim, msg) => findings.push({ dim, msg });

const jiti = await createPiJiti(import.meta.url);
const configMod = await jiti.import(`${EXT}/src/config.ts`);
const configUtilsMod = await jiti.import(`${EXT}/src/config-utils.ts`);

const DEFAULTS_FLAT = configUtilsMod.DEFAULT_CONFIG;
const DEFAULTS_V2 = configMod.DEFAULT_CONFIG_V2;

// ---- parseJsonc: comment stripping must be string-aware -------------------
// The sttBaseUrl incident: the old regex sweep deleted the `//` inside
// "http://…" values, corrupting the document (un-loadable config, login
// prompt on restart). These checks pin that behavior.
{
  const { parseJsonc } = configUtilsMod;
  const cases = [
    ["url value survives", '{"u":"http://h:8002/v1"}', (o) => o.u === "http://h:8002/v1"],
    ["line comment stripped", "{\n// c\n\"a\":1}", (o) => o.a === 1],
    ["url in string, comment after", '{"u":"https://x//y"} // gone', (o) => o.u === "https://x//y"],
    ["block comment", '{"a":1 /* x\ny */ , "b":2}', (o) => o.a === 1 && o.b === 2],
    ["escaped quote", '{"a":"he said \\"//x\\""}', (o) => o.a === 'he said "//x"'],
    ["block opener inside string", '{"a":"/* not a comment"} // real', (o) => o.a === "/* not a comment"],
  ];
  for (const [name, src, pass] of cases) {
    try {
      if (!pass(parseJsonc(src))) add("parseJsonc", name);
    } catch (error) {
      add("parseJsonc", `${name} threw ${error.message}`);
    }
  }
}

// ---- helpers -------------------------------------------------------------
const leaves = (obj, pre = []) => {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v, [...pre, k]));
    else out.push({ path: [...pre, k], value: v });
  }
  return out;
};
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const allSrc = Object.fromEntries(srcFiles.map((f) => [f, read(f)]));
allSrc["index.ts"] = fs.readFileSync(path.join(EXT, "index.ts"), "utf8");

// ============================================================ DIM 1: duplicate keys from sed
for (const [f, src] of Object.entries(allSrc)) {
  const lines = src.split("\n");
  // duplicate interface members
  let iface = null, members = new Map();
  for (let i = 0; i < lines.length; i++) {
    const im = lines[i].match(/^export interface (\w+)/);
    if (im) { iface = im[1]; members = new Map(); continue; }
    if (iface && /^\}/.test(lines[i])) {
      for (const [name, first] of members) if (first.length > 1)
        add("D1 duplicate-key", `${f}: interface ${iface} declares '${name}' ${first.length}x (lines ${first.join(",")})`);
      iface = null; continue;
    }
    if (iface) {
      const mm = lines[i].match(/^\s{2}(\w+)(\??):/);
      if (mm) {
        if (!members.has(mm[1])) members.set(mm[1], []);
        members.get(mm[1]).push(i + 1);
      }
    }
  }
  // duplicate object keys inside each named section block of DEFAULT maps
  const blocks = src.split(/^(\s{2}|\s{4})(\w+): \{/gm);
  for (let i = 2; i < blocks.length; i += 3) {
    const body = blocks[i] ?? "";
    const seen = new Map();
    for (const m of body.matchAll(/^\s{4,}(\w+):/gm)) {
      if (!seen.has(m[1])) seen.set(m[1], 0);
      seen.set(m[1], seen.get(m[1]) + 1);
    }
    for (const [k, n] of seen) if (n > 1) add("D1 duplicate-key", `${f}: object key '${k}' repeated ${n}x in block starting '${blocks[i + 1]}'`);
  }
}

// ============================================================ DIM 2: the one v2->flat mapper is complete
// mapV2ToFlat (src/config-utils.ts) is the single v2 -> flat mapper. getEffectiveConfig
// (src/config.ts) returns loadConfig()'s output, so nothing else may translate v2.
const mapSrc = allSrc["config.ts"]; // migrateV1toV2 + getEffectiveConfig live here
const flatMapSrc = allSrc["config-utils.ts"]; // mapV2ToFlat + loadConfig live here
const mapBody = (() => {
  const s = flatMapSrc.indexOf("function mapV2ToFlat");
  const e = flatMapSrc.indexOf("\n}", s);
  return flatMapSrc.slice(s, e);
})();
// `const identity = (v2.piMatrixIdentity ?? {})` and
// `const subThreadsCfg = (threading.subThreads ?? {})` -> var -> v2 path
const varMap = new Map();
for (const m of mapBody.matchAll(/const\s+(\w+)\s*=\s*\(\s*(\w+)\.([\w.]+)\s*\?\?/g)) {
  varMap.set(m[1], varMap.has(m[2]) ? `${varMap.get(m[2])}.${m[3]}` : m[3]);
}
const emitted = new Map(); // flatKey (or `parent.child`) -> v2 path
{
  let under = null; // the nested block we are inside, e.g. `subagents`
  for (const line of mapBody.split("\n")) {
    const open = line.match(/^\s{4}(\w+):\s*(?:stripUndefined\(\{|\{)\s*$/);
    if (open) { under = open[1]; continue; }
    if (under && /^\s{4}(?:\}\)|\})/.test(line)) { under = null; continue; }
    const m = line.match(under ? /^\s{6}(\w+):\s*(.+?),?\s*$/ : /^\s{4}(\w+):\s*(.+?),?\s*$/);
    if (!m) continue;
    const ref = m[2].match(/(\w+)\.([\w.]+)/);
    if (!ref || !varMap.has(ref[1])) continue;
    emitted.set(under ? `${under}.${m[1]}` : m[1], `${varMap.get(ref[1])}.${ref[2]}`);
  }
}
const dupEmit = new Map();
for (const m of mapBody.matchAll(/^\s{4}(\w+):/gm)) dupEmit.set(m[1], (dupEmit.get(m[1]) ?? 0) + 1);
for (const [k, n] of dupEmit) if (n > 1) add("D2 duplicate emission", `${k} written ${n}x by mapV2ToFlat — last write wins, the earlier value is lost`);
const v2Leaves = leaves(DEFAULTS_V2).filter((l) => l.path[0] !== "configVersion");
for (const l of v2Leaves) {
  const want = l.path.join(".");
  const hit = [...emitted.values()].some((e) => e === want);
  if (!hit) add("D2 unmapped v2 param", `${want} (default ${JSON.stringify(l.value)}) is in DEFAULT_CONFIG_V2 but mapV2ToFlat never emits it`);
}

// ============================================================ DIM 3: emitted flat key must exist in MatrixConfig type + have a runtime consumer
const typesSrc = allSrc["types.ts"];
const matrixIface = typesSrc.slice(typesSrc.indexOf("export interface MatrixConfig"), typesSrc.indexOf("export interface PartialMatrixConfig"));
const typeKeys = new Set([...matrixIface.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
const DEF = new Set(Object.keys(DEFAULTS_FLAT));
// Identity fields resolved from the credentials file, deliberately absent from
// DEFAULT_CONFIG so a stale file value never outranks the real credentials.
const DERIVED = new Set(["userId", "homeserver"]);
const DEFINITION_FILES = new Set(["config.ts", "config-utils.ts", "types.ts"]);
for (const [flat, v2path] of emitted) {
  // A nested block (subagents.*) is read through a destructured alias
  // (`const s = cfg.subagents`), so a per-child grep misses every real reader.
  if (flat.includes(".")) continue;
  if (!typeKeys.has(flat)) add("D3 missing in MatrixConfig", `${flat} (from ${v2path}) emitted but not declared in interface MatrixConfig`);
  if (!DEF.has(flat) && !DERIVED.has(flat)) add("D3 missing flat default", `${flat} (from ${v2path}) emitted but absent from DEFAULT_CONFIG`);
  const consumers = [];
  for (const [f, src] of Object.entries(allSrc)) {
    if (DEFINITION_FILES.has(f)) continue;
    const re = new RegExp(`\\b(?:cfg|config|this\\.deps\\.cfg|this\\.opts|opts|deps\\.cfg)\\.${flat}\\b`, "g");
    const hits = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
    for (const [ln] of hits) consumers.push(`${f}:${ln}`);
  }
  if (consumers.length === 0) add("D3 dead flat key", `${flat} (from ${v2path}) has no runtime consumer outside config/types files`);
}

// ============================================================ DIM 6: migration completeness
const migSrc = mapSrc.slice(mapSrc.indexOf("export function migrateV1toV2"), mapSrc.indexOf("export function getEffectiveConfig"));
const produces = new Set([...migSrc.matchAll(/^\s{4,}(\w+):/gm)].map((m) => m[1]));
for (const l of v2Leaves) {
  const leaf = l.path[l.path.length - 1];
  if (!produces.has(leaf)) add("D6 migration gap", `migrateV1toV2 never produces '${leaf}' (v1 value for it cannot survive conversion)`);
}
const readsV1 = new Set([...migSrc.matchAll(/oldConfig\.(\w+)/g)].map((m) => m[1]));
for (const k of DEF) {
  if (k === "configVersion") continue;
  if (!readsV1.has(k) && !JSON.stringify(migSrc).includes(`"${k}"`))
    add("D6 v1 value dropped on conversion", `DEFAULT_CONFIG key '${k}' is never read by migrateV1toV2 — a user's custom value is lost when a v1 file converts`);
}

// Findings already known at the time this contract was written. The test
// fails only on NEW violations, so it can guard the schema without
// inheriting the pre-existing debt as a permanent red.
const KNOWN = [
  // v1 keys dropped by decision during the v2 design; no v2 successor.
  // v2-era flat names. migrateV1toV2 reads the v1 ANCESTOR key instead
  // (messagePrefix, finalMessageMaxLength, broadcastUserMessageIcon,
  // mediaAttachMaxBytes, artifactAttachPrefix), so these names never appear
  // in a genuine v1 file and cannot be read there.
  /DEFAULT_CONFIG key 'piTerminalMatrixMessagePrefix'/,
  /DEFAULT_CONFIG key 'maxFinalMessageLength'/,
  /DEFAULT_CONFIG key 'remoteFilePicker'/,
  /DEFAULT_CONFIG key 'fileSearchMethod'/,
  /DEFAULT_CONFIG key 'userMessageIcon'/,
  /DEFAULT_CONFIG key 'filePickerPrefix'/,
  /DEFAULT_CONFIG key 'maxBytesUpload'/,
];
const fresh = findings.filter((f) => !KNOWN.some((re) => re.test(f.msg)));

// ---- report --------------------------------------------------------------
const byDim = {};
for (const f of findings) (byDim[f.dim] ??= []).push(f.msg);
console.log(`\nCONFIG CONTRACT — ${findings.length} findings across ${Object.keys(byDim).length} dimensions\n`);
for (const [dim, msgs] of Object.entries(byDim)) {
  console.log(`## ${dim} (${msgs.length})`);
  for (const m of [...new Set(msgs)].slice(0, 25)) {
    const known = KNOWN.some((re) => re.test(m));
    console.log(`  ${known ? "known" : "NEW "} - ${m}`);
  }
  const uniq = new Set(msgs).size;
  if (uniq > 25) console.log(`  ... ${uniq - 25} more`);
  console.log("");
}
if (fresh.length) {
  console.log(`CONFIG CONTRACT FAILED — ${fresh.length} new violation(s) of ${findings.length} total`);
  process.exit(1);
}
console.log(`CONFIG CONTRACT PASSED — ${findings.length} finding(s), all in the known list`);
