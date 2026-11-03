/**
 * v1 -> v2 conversion, end to end.
 *
 * The contract check (config-contract.mjs) reads migrateV1toV2 as TEXT, so it
 * can say "the migration mentions this key" without ever proving a user's file
 * converts and still loads with their values. This suite executes it: a real
 * v1 `.json` goes in, a `.jsonc` comes out, and the loader is asked what the
 * user configured.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { DEFAULT_CONFIG, loadConfig } = await jiti.import(`${EXT_DIR}/src/config-utils.ts`);
const {
  DEFAULT_CONFIG_V2,
  migrateV1toV2,
  convertAllConfigs,
  ensureProjectConfig,
  getEffectiveConfig,
} = await jiti.import(`${EXT_DIR}/src/config.ts`);

const { check, finish } = makeCheck("CONFIG-MIGRATION");

// ---------------------------------------------------------------------------
// 1. A genuine v1 file, every parameter set to a NON-default value.
//
// The keys in V1_NAMES are the trap: v2 renamed them, and two of them changed
// MEANING. v1 `fileAttach` was the `@` picker toggle (now `remoteFilePicker`)
// and v1 `artifactAttach` was the outbound `@@` attach (now `fileAttach`), so a
// migration that reads the new names off a v1 file swaps the two features.
// ---------------------------------------------------------------------------
const V1_NAMES = {
  piTerminalMatrixMessagePrefix: "messagePrefix",
  maxFinalMessageLength: "finalMessageMaxLength",
  remoteFilePicker: "fileAttach", // v1 meaning: the @ picker
  fileSearchMethod: "artifactSearch",
  userMessageIcon: "broadcastUserMessageIcon",
  filePickerPrefix: "fileAttachPrefix", // v1 meaning: the @ picker prefix
  sendSessionStartStopMilestones: "sendSessionMilestones",
  sendCompactionMilestones: "sendCompactMilestones",
  sendModelChangeMilestones: "sendModelMilestones",
  fileAttachPrefix: "artifactAttachPrefix",
  maxBytesUpload: "mediaAttachMaxBytes",
};

// Keys with a closed vocabulary: perturbing them by type would produce a value
// the code rejects, so each gets one real alternative.
const OVERRIDE = {
  roomId: "#custom-room:example.org",
  credentialsPath: `${os.homedir()}/.config/mtx/accounts/pi--example.org/credentials.json`,
  logPath: "/tmp/pi-matrix-migration.log",
  logLevel: "DEBUG",
  e2ee: "off",
  attachEncryption: "off",
  threadPendingRoute: "latest",
  threadSummarizeSource: "session",
  deviceId: "PI_MIGRATION_1",
  cryptoStoreDir: "/tmp/pi-migration-crypto",
  storePassphrase: "test-passphrase",
  threadSummarizeModel: "claude-test",
};

/** A distinctive value per key: booleans flip, numbers shift, strings extend. */
function perturb(value) {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (typeof value === "string") return `${value}-mig`;
  return undefined;
}

const EXPECTED = {}; // what the converted v2 config must report, by v2-era name
const v1File = {};

for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
  const value =
    key in OVERRIDE ? OVERRIDE[key]
    : def === undefined ? `custom-${key}`
    : perturb(def);
  if (value === undefined) continue;
  const v1Key = V1_NAMES[key] ?? key;
  v1File[v1Key] = value;
  EXPECTED[key] = value;
}

// The nested v1 `subagents` object. postMode has a closed vocabulary.
v1File.subagents = {
  enabled: false,
  spawnMessages: false,
  summarizeResultIntoSpawnLine: false,
  postMode: "all",
  colorByType: true,
  colorPalette: { explore: "#00ff00" },
  plainMarker: "##",
  // provider (DESIGN-SUBAGENT-PROVIDER §4): non-default dialect value — the
  // round-trip must carry it, not drop it or pin it to the default.
  provider: "nicobailon",
};
EXPECTED.subagents = { ...v1File.subagents };

// v1-era outbound/picker toggles that the v2 schema split apart. `fileAttach`
// above is the PICKER; the outbound attach came from `artifactAttach`.
v1File.artifactAttach = true;
EXPECTED.fileAttach = true;
// displayStdoutOnStartup / matrixLoginEnabled were introduced as flat keys
// BEFORE v2, so a "v1" file written by this build really can hold them.
v1File.displayStdoutOnStartup = true;
EXPECTED.displayStdoutOnStartup = true;
v1File.matrixLoginEnabled = false;
EXPECTED.matrixLoginEnabled = false;

// ---------------------------------------------------------------------------
// 2. migrateV1toV2 -> .jsonc -> loadConfig: every value must survive.
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-migrate-"));
const project = path.join(tmp, "project");
const cfgDir = path.join(project, ".pi", "matrix");
fs.mkdirSync(cfgDir, { recursive: true });

const v1Path = path.join(cfgDir, "matrix-config.json");
const v2Path = path.join(cfgDir, "matrix-config.jsonc");
fs.writeFileSync(v1Path, JSON.stringify(v1File, null, 2));

const v2Doc = migrateV1toV2(v1File);
check("migration produces a v2 document", v2Doc.configVersion === "2.0" && !!v2Doc.piMatrixIdentity);
check(
  "migration output is nested, not flat",
  !("sendSessionStartStopMilestones" in v2Doc) && v2Doc.sendMilestones?.enabled === false,
  JSON.stringify(v2Doc.sendMilestones),
);
fs.writeFileSync(v2Path, JSON.stringify(v2Doc, null, 2));

const after = loadConfig(v2Path);
const lost = [];
for (const [key, want] of Object.entries(EXPECTED)) {
  const got = after[key];
  const same =
    typeof want === "object" ? JSON.stringify(got) === JSON.stringify(want) : got === want;
  if (!same) lost.push(`${key}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
check(
  `every configured value survives v1 -> v2 (${Object.keys(EXPECTED).length} params)`,
  lost.length === 0,
  lost.join(" | "),
);
check(
  "the picker and the outbound attach did not swap",
  after.remoteFilePicker === true && after.fileAttach === true &&
    after.filePickerPrefix === v1File.fileAttachPrefix &&
    after.fileAttachPrefix === v1File.artifactAttachPrefix,
  JSON.stringify({
    remoteFilePicker: after.remoteFilePicker,
    fileAttach: after.fileAttach,
    filePickerPrefix: after.filePickerPrefix,
    fileAttachPrefix: after.fileAttachPrefix,
  }),
);

// ---------------------------------------------------------------------------
// 3. convertAllConfigs: the startup path index.ts runs.
// ---------------------------------------------------------------------------
const proj2 = path.join(tmp, "startup");
const dir2 = path.join(proj2, ".pi", "matrix");
fs.mkdirSync(dir2, { recursive: true });
fs.writeFileSync(path.join(dir2, "matrix-config.json"), JSON.stringify(v1File));
fs.writeFileSync(path.join(dir2, "matrix-config.work.json"), JSON.stringify(v1File));
fs.writeFileSync(path.join(dir2, "TEMPLATE.room.json"), `{"not a config": true}`);
fs.writeFileSync(path.join(dir2, "matrix-config.already.jsonc"), JSON.stringify(v2Doc));
fs.writeFileSync(path.join(dir2, "matrix-config.dupe.json"), JSON.stringify(v1File));
fs.writeFileSync(path.join(dir2, "matrix-config.dupe.jsonc"), JSON.stringify(v2Doc));

const cwd = process.cwd();
process.chdir(proj2);
try {
  const converted = convertAllConfigs();
  const list = fs.readdirSync(dir2).sort();
  check("convertAllConfigs converts the bare + profile config", converted === 3, `count=${converted}`);
  check("v2 files are written", fs.existsSync(path.join(dir2, "matrix-config.jsonc")) && fs.existsSync(path.join(dir2, "matrix-config.work.jsonc")));
  check(
    "the v1 originals are kept as .json.bak (rollback guard)",
    fs.existsSync(path.join(dir2, "matrix-config.json.bak")),
    list.join(", "),
  );
  check("TEMPLATE.* files are left alone", fs.existsSync(path.join(dir2, "TEMPLATE.room.json")));
  check(
    "a .json with an existing .jsonc is retired, not reconverted",
    fs.existsSync(path.join(dir2, "matrix-config.dupe.json.bak")) &&
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir2, "matrix-config.dupe.jsonc"), "utf8"))) === JSON.stringify(v2Doc),
  );

  // Second run must change nothing (the .json.bak guard).
  const again = convertAllConfigs();
  const list2 = fs.readdirSync(dir2).sort();
  check("a second run converts nothing", again === 0, `count=${again}`);
  check("a second run changes no files", JSON.stringify(fs.readdirSync(dir2).sort()) === JSON.stringify(list2), list2.join(", "));

  // ---------------------------------------------------------------------------
  // 4. convert-on-first-read: getEffectiveConfig converts the active file.
  // ---------------------------------------------------------------------------
  const proj3 = path.join(tmp, "firstread");
  const dir3 = path.join(proj3, ".pi", "matrix");
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(path.join(dir3, "matrix-config.json"), JSON.stringify(v1File));
  process.chdir(proj3);
  const effective = getEffectiveConfig();
  check(
    "convert-on-first-read writes the .jsonc and retires the .json",
    fs.existsSync(path.join(dir3, "matrix-config.jsonc")) &&
      fs.existsSync(path.join(dir3, "matrix-config.json.bak")) &&
      !fs.existsSync(path.join(dir3, "matrix-config.json")),
    fs.readdirSync(dir3).join(", "),
  );
  const firstReadLost = [];
  for (const [key, want] of Object.entries(EXPECTED)) {
    const got = effective[key];
    const same = typeof want === "object" ? JSON.stringify(got) === JSON.stringify(want) : got === want;
    if (!same) firstReadLost.push(`${key}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  check("the config returned by the converting read already carries the values", firstReadLost.length === 0, firstReadLost.join(" | "));

  // No cache: the second read goes back to the converted file, so it must
  // still say the same thing.
  const stable = getEffectiveConfig();
  check("re-reading the converted file is stable", JSON.stringify(stable) === JSON.stringify(effective));
} finally {
  process.chdir(cwd);
}

// ---------------------------------------------------------------------------
// 5. The two default tables must agree. DEFAULT_CONFIG wins when a v2 file
// omits a key, so a disagreement silently ships the wrong number.
// ---------------------------------------------------------------------------
const v2DefaultsFlat = loadConfig(
  (() => {
    const p = path.join(tmp, "defaults", ".pi", "matrix", "matrix-config.jsonc");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A v2 file carrying ONLY defaults, minus identity fields (those derive
    // from the credentials file).
    const doc = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V2));
    delete doc.piMatrixIdentity.userId;
    delete doc.piMatrixIdentity.homeserver;
    fs.writeFileSync(p, JSON.stringify(doc));
    return p;
  })(),
);
const drift = [];
// DEFAULT_CONFIG keeps the literal "~" form; loadConfig expands it. Compare
// expanded, or every path key looks like drift.
const expand = (v) => (typeof v === "string" && v.startsWith("~/") ? path.join(os.homedir(), v.slice(2)) : v);
for (const [key, rawDefault] of Object.entries(DEFAULT_CONFIG)) {
  const flatDefault = expand(rawDefault);
  if (flatDefault === undefined) continue;
  const shipped = expand(v2DefaultsFlat[key]);
  if (shipped === undefined) {
    drift.push(`${key}: v2 default emits nothing (flat default ${JSON.stringify(flatDefault)} wins)`);
  } else if (JSON.stringify(shipped) !== JSON.stringify(flatDefault)) {
    drift.push(`${key}: flat ${JSON.stringify(flatDefault)} vs v2 ${JSON.stringify(shipped)}`);
  }
}
check("DEFAULT_CONFIG and DEFAULT_CONFIG_V2 agree on every default", drift.length === 0, drift.join(" | "));

// ---------------------------------------------------------------------------
// 6. ensureProjectConfig must write a v2 document.
//
// It used to write DEFAULT_CONFIG (the flat v1 table) to a path named .jsonc.
// loadConfig accepted it — it detects the schema by content, not extension —
// but nothing converted it afterwards: convert-on-first-read only watches
// `.json` paths and convertAllConfigs only scans `.json` files. Every new
// project therefore started life as a permanent v1 config in a v2 filename.
// ---------------------------------------------------------------------------
{
  const cwd2 = process.cwd();
  const proj = path.join(tmp, "newproject");
  fs.mkdirSync(proj, { recursive: true });
  process.chdir(proj);
  try {
    const created = ensureProjectConfig();
    const doc = JSON.parse(fs.readFileSync(created, "utf-8"));
    check(
      "a new project config is a v2 document",
      doc.configVersion === "2.0" && !!doc.piMatrixIdentity && !!doc.sendMilestones,
      `configVersion=${doc.configVersion}, sections=${Object.values(doc).filter(v => v && typeof v === "object" && !Array.isArray(v)).length}`,
    );
    // NB: `sendMilestones` / `sendUserMessages` / `sendFinalMessages` are BOTH
    // v1 flat key names and v2 section names, so "is it a flat key" cannot be
    // decided by name. Shape decides: a v2 top level is configVersion + objects.
    const notSections = Object.entries(doc)
      .filter(([k, v]) => k !== "configVersion" && (v === null || typeof v !== "object"))
      .map(([k]) => k);
    check("every top-level entry is a section", notSections.length === 0, notSections.join(", "));
    const back = loadConfig(created);
    check(
      "the new file reads back through the v2 mapper",
      typeof back.credentialsPath === "string" && back.credentialsPath.includes("/projects/newproject/accounts/"),
      `got ${back.credentialsPath}`,
    );
  } finally {
    process.chdir(cwd2);
  }
}

// ---------------------------------------------------------------------------
// 7. The v2 typo guard. A v1 file has warned about unknown keys since R3; a v2
// file dropped that protection, because the guard looked at the merged FLAT
// config and a typo inside a section never reaches it.
// ---------------------------------------------------------------------------
{
  const warnPath = path.join(tmp, "guard");
  fs.mkdirSync(warnPath, { recursive: true });
  const creds = path.join(warnPath, "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ access_token: "t", user_id: "@pi:example.org", device_id: "D" }));
  const identity = { credentialsPath: creds };
  const clean = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V2));
  clean.piMatrixIdentity = identity;
  const load = (name, doc) => {
    const file = path.join(warnPath, `${name}.jsonc`);
    fs.writeFileSync(file, JSON.stringify(doc));
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(" "));
    try {
      loadConfig(file);
    } finally {
      console.warn = realWarn;
    }
    return warned.join(" | ");
  };

  check("a schema-clean v2 file warns about nothing", load("clean", clean) === "", load("clean", clean));

  const nested = JSON.parse(JSON.stringify(clean));
  nested.sendMilestones.sendMilestons = true;
  check("a typo inside a section is reported",
    load("nested-typo", nested).includes("sendMilestones.sendMilestons"), load("nested-typo", nested));

  const section = JSON.parse(JSON.stringify(clean));
  section.piMatrixTypoSection = { enabled: true };
  check("an unknown section is reported once",
    load("section-typo", section).includes("piMatrixTypoSection"), load("section-typo", section));

  const leftover = JSON.parse(JSON.stringify(clean));
  leftover.sendSessionStartStopMilestones = true; // a v1 flat key, hand-edited in
  check("a leftover flat v1 key is reported",
    load("flat-leftover", leftover).includes("sendSessionStartStopMilestones"), load("flat-leftover", leftover));

  // The hard case: a v1 key whose name IS a v2 section name. The mapping reads
  // `.enabled` off the boolean and gets undefined, so the guard has to notice
  // the shape, not just the name.
  const shadowed = JSON.parse(JSON.stringify(clean));
  shadowed.sendMilestones = true;
  check("a v1 key that shadows a section is reported",
    load("section-shadowed", shadowed).includes("sendMilestones"), load("section-shadowed", shadowed));
}

// ---------------------------------------------------------------------------
// 8. Env coercion for EVERY mapping. The coercion table used to be two
// hand-maintained lists, so a new number param arrived as the string "4242"
// until somebody remembered to list it. The table is now the type
// DEFAULT_CONFIG declares, which nothing can forget to update.
// ---------------------------------------------------------------------------
{
  const coerceDir = path.join(tmp, "coerce");
  fs.mkdirSync(coerceDir, { recursive: true });
  const creds = path.join(coerceDir, "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ access_token: "t", user_id: "@pi:example.org", device_id: "D" }));
  const coerceFile = path.join(coerceDir, "matrix-config.jsonc");
  fs.writeFileSync(coerceFile, JSON.stringify({
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG_V2)),
    piMatrixIdentity: { credentialsPath: creds },
  }));

  const envSrc = fs.readFileSync(`${EXT_DIR}/src/config-utils.ts`, "utf8");
  const mappings = [...envSrc.match(/const ENV_MAPPINGS[\s\S]*?\n\};/)[0]
    .matchAll(/(PI_MATRIX_[A-Z0-9_]+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  const SAMPLE = { number: "4242", boolean: "true", string: "zz-env-value" };
  const bad = [];
  for (const [envVar, key] of mappings) {
    // A key with no DEFAULT_CONFIG entry (userId, homeserver, cryptoStoreDir,
    // storePassphrase, deviceId, threadSummarizeModel) is a string.
    const declared = typeof DEFAULT_CONFIG[key] === "number" ? "number"
      : typeof DEFAULT_CONFIG[key] === "boolean" ? "boolean" : "string";
    process.env[envVar] = SAMPLE[declared];
    try {
      const got = loadConfig(coerceFile)[key];
      const want = declared === "number" ? 4242 : declared === "boolean" ? true : SAMPLE[declared];
      if (got !== want) bad.push(`${envVar} -> ${key}: got ${JSON.stringify(got)} (${typeof got}), want ${JSON.stringify(want)}`);
    } finally {
      delete process.env[envVar];
    }
  }
  check(`every env override lands as the type the schema declares (${mappings.length} mappings)`,
    bad.length === 0, bad.join(" | "));
}

// ---------------------------------------------------------------------------
// 9. No dead v2 leaves. Section 1 proves the flat reader sees every value; this
// proves the same for the v2 side: a leaf in DEFAULT_CONFIG_V2 that no mapping
// reads is a knob the user can set with no effect, and nothing would notice.
// ---------------------------------------------------------------------------
{
  const leafDir = path.join(tmp, "leaves");
  fs.mkdirSync(leafDir, { recursive: true });
  const creds = path.join(leafDir, "credentials.json");
  fs.writeFileSync(creds, JSON.stringify({ access_token: "t", user_id: "@pi:example.org", device_id: "D" }));
  const baseDoc = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V2));
  baseDoc.piMatrixIdentity = { credentialsPath: creds };

  const leaves = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? leaves(v, p) : [[p, v]];
  });
  const flip = (v) => (typeof v === "boolean" ? !v
    : typeof v === "number" ? v + 7
      : typeof v === "string" ? (v === "on" ? "off" : v === "off" ? "on" : `${v}!`)
        : "set");

  const basePath = path.join(leafDir, "base.jsonc");
  fs.writeFileSync(basePath, JSON.stringify(baseDoc));
  const base = loadConfig(basePath);

  const dead = [];
  for (const [p, value] of leaves(DEFAULT_CONFIG_V2).filter(([p]) => !p.startsWith("piMatrixIdentity."))) {
    const doc = JSON.parse(JSON.stringify(baseDoc));
    const parts = p.split(".");
    let node = doc;
    for (const step of parts.slice(0, -1)) node = node[step];
    node[parts[parts.length - 1]] = flip(value);
    const file = path.join(leafDir, `leaf-${p}.jsonc`);
    fs.writeFileSync(file, JSON.stringify(doc));
    const after = loadConfig(file);
    if (!Object.keys(after).some((k) => JSON.stringify(after[k]) !== JSON.stringify(base[k]))) {
      dead.push(p);
    }
  }
  check("every v2 leaf reaches a reader", dead.length === 0, dead.join(", "));
}

fs.rmSync(tmp, { recursive: true, force: true });
finish();
