/**
 * Project-provisioning test: per-project credentials under
 * ~/.config/mtx/projects/<project>/ (the flat ~/.config/mtx/accounts/ is the
 * pre-per-project default). Verifies:
 *   1. getProjectName() slugs the cwd (example.org→example-org, Strata→strata) and
 *      honours the PI_MATRIX_PROJECT override.
 *   2. getProjectCredentialsPath() emits the per-project `~`-form path.
 *   3. ensureProjectConfig() creates the project-local config seeded with the
 *      per-project credentialsPath; idempotent; never clobbers an existing file.
 *   4. the startup gate: a fresh project config (no creds) reads as
 *      needs-login (hasLoadableCredentials=false); a creds-backed one does not.
 *   5. the login flow's credsDir derivation lands in the per-project accounts
 *      dir, and saveCredentials writes there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("PROJECT-PROVISION");

const cfg = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
const cfgV2 = await jiti.import(path.join(EXT_DIR, "src/config.ts"));
const login = await jiti.import(path.join(EXT_DIR, "src/login.ts"));

// Point the credentials store + HOME at a throwaway root so no real account
// dir is touched. (expandHome uses os.homedir(), which honours $HOME.)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-provision-"));
process.env.HOME = root;
const savedProjEnv = process.env.PI_MATRIX_PROJECT;
delete process.env.PI_MATRIX_PROJECT;

// Scratch chdir helper: a temp dir named `name` stands in for a project root.
function chdirTo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  return dir;
}

// ---- 1. getProjectName ---------------------------------------------------
chdirTo("example.org");
check("slug: example.org → example-org", cfg.getProjectName() === "example-org", `got ${cfg.getProjectName()}`);
chdirTo("Strata");
check("slug: Strata → strata", cfg.getProjectName() === "strata", `got ${cfg.getProjectName()}`);
process.env.PI_MATRIX_PROJECT = "tennisplanner";
check(
  "override: PI_MATRIX_PROJECT wins",
  cfg.getProjectName() === "tennisplanner",
  `got ${cfg.getProjectName()}`,
);
delete process.env.PI_MATRIX_PROJECT;

// ---- 2. getProjectCredentialsPath ---------------------------------------
chdirTo("example.org");
const credPath = cfg.getProjectCredentialsPath();
check(
  "path shape: projects/example-org/accounts/<leaf>/credentials.json",
  credPath.startsWith("~/.config/mtx/projects/example-org/accounts/") &&
    credPath.endsWith("/credentials.json"),
  `got ${credPath}`,
);
check(
  "path carries a leaf (accounts segment is derivable)",
  /^[^/]+$/.test(path.basename(path.dirname(credPath))),
  `got ${credPath}`,
);

// ---- 3. ensureProjectConfig ---------------------------------------------
const freshDir = chdirTo("Strata");
const projCfg = path.join(freshDir, ".pi", "matrix", "matrix-config.jsonc");
check("project config absent before", !fs.existsSync(projCfg));
const created = cfgV2.ensureProjectConfig();
// macOS resolves the temp dir through /private, so compare the suffix, not the string.
check("ensureProjectConfig returns the path on first run",
  created?.endsWith(path.join(".pi", "matrix", "matrix-config.jsonc")) === true, `got ${created}`);
check("project config exists after", fs.existsSync(projCfg));
const seeded = JSON.parse(fs.readFileSync(projCfg, "utf-8"));
check(
  "a new project starts on the v2 schema (not flat keys in a .jsonc file)",
  seeded.configVersion === "2.0" && !!seeded.piMatrixIdentity && !Array.isArray(seeded.piMatrixIdentity),
  `configVersion=${seeded.configVersion}, top-level keys=${Object.keys(seeded).length}`,
);
check(
  "seeded credentialsPath is per-project",
  typeof seeded.piMatrixIdentity?.credentialsPath === "string" &&
    seeded.piMatrixIdentity.credentialsPath.includes("/.config/mtx/projects/strata/accounts/"),
  `got ${seeded.piMatrixIdentity?.credentialsPath}`,
);
check(
  "seeded config still carries default roomId",
  typeof seeded.piMatrixConnection?.roomId === "string" && seeded.piMatrixConnection.roomId.startsWith("#"),
  `got ${seeded.piMatrixConnection?.roomId}`,
);
check("ensureProjectConfig idempotent (second run null)", cfgV2.ensureProjectConfig() === null);

// Never clobber a user-edited file.
const userDir = chdirTo("custom");
const userCfg = path.join(userDir, ".pi", "matrix", "matrix-config.jsonc");
fs.mkdirSync(path.dirname(userCfg), { recursive: true });
fs.writeFileSync(userCfg, JSON.stringify({ roomId: "#mine", credentialsPath: "~/.config/mtx/projects/custom/accounts/x--y/credentials.json" }));
check("ensureProjectConfig skips an existing file", cfgV2.ensureProjectConfig() === null);
check(
  "existing file untouched",
  JSON.parse(fs.readFileSync(userCfg, "utf-8")).roomId === "#mine",
);

// ---- 4. startup gate: fresh project config reads as needs-login ----------
// (Re-enter the fresh Strata project config; its credentials file does not exist yet.)
process.chdir(freshDir);
const loadedFresh = cfg.loadConfig();
const credsFresh = cfg.getCredentialsPath(loadedFresh);
check(
  "fresh project credentialsPath expands ~ to the real HOME",
  credsFresh === path.join(root, ".config/mtx/projects/strata/accounts/", path.basename(path.dirname(credPath)), "credentials.json"),
  `got ${credsFresh}`,
);
check(
  "fresh project credentialsPath has no file yet → needs login",
  login.hasLoadableCredentials(credsFresh) === false,
);
const freshValid = cfg.validateConfig(loadedFresh);
check(
  "fresh project config fails validateConfig (missing homeserver) — the trap the gate must bypass",
  freshValid.valid === false,
  `errors ${JSON.stringify(freshValid.errors)}`,
);

// A creds-backed config reads as has-credentials (the gate bails on other misconfig).
// Write the credentials file to the EXACT path the seeded config points at.
fs.mkdirSync(path.dirname(credsFresh), { recursive: true });
fs.writeFileSync(
  credsFresh,
  JSON.stringify({ user_id: "@pi_agent:matrix.example.org", homeserver: "https://matrix.example.org", access_token: "syt_x" }),
);
const loadedCred = cfg.loadConfig();
check(
  "creds-backed project config → hasLoadableCredentials true",
  login.hasLoadableCredentials(cfg.getCredentialsPath(loadedCred)) === true,
);

// ---- 5. login flow: credsDir derives to the per-project accounts dir -----
// Replicate integration.ts runLoginFlow's 3-line derivation on the seeded path.
const cp = path.join(cfg.getCredentialsPath(loadedCred));
const accountParent = path.dirname(cp);
const credsDir =
  path.basename(path.dirname(accountParent)) === "accounts"
    ? path.dirname(accountParent)
    : accountParent;
check(
  "credsDir is the per-project accounts dir (not the flat one)",
  credsDir === path.join(root, ".config/mtx/projects/strata/accounts"),
  `got ${credsDir}`,
);
const saved = login.saveCredentials(credsDir, {
  user_id: "@pi_agent:matrix.example.org",
  homeserver: "https://matrix.example.org",
  device_id: "DEV",
  access_token: "syt_new",
});
check(
  "saveCredentials lands under the per-project accounts dir",
  saved.startsWith(path.join(root, ".config/mtx/projects/strata/accounts", "pi_agent--matrix.example.org", "credentials.json")),
  `got ${saved}`,
);
check("no flat accounts dir was created", !fs.existsSync(path.join(root, ".config", "mtx", "accounts")));

finish();
