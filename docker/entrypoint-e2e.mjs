/**
 * Cold-install end-to-end entrypoint (release story 12).
 *
 * Runs as the container's non-root user with an empty $HOME: install Pi is
 * baked into the image (pinned), the package under test arrives either as
 * the local npm tarball (SOURCE=tarball) or from the registry (SOURCE=npm).
 * Nothing from the host is mounted into $HOME.
 *
 * Modes:
 *   MODE=full (default)  cold install -> assert the cold context -> log in
 *                        from PI_MATRIX_* env -> npm run test:live.
 *                        Exits non-zero naming every missing variable.
 *   MODE=offline         assert the network is really down, then run the
 *                        whole offline tier (npm test) with npm forced to
 *                        its cache. Proves the offline tier is offline.
 *
 * The scenario suite it runs is the live tier; story 13 replaces the
 * single live-check run with the named scenario scripts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const mode = process.env.MODE ?? "full";
const source = process.env.SOURCE ?? "tarball";
const expectedExtensions = Number(process.env.E2E_EXPECTED_EXTENSIONS ?? "1");
const work = path.join(os.homedir(), "work");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function fail(msg) {
  console.error(`\ne2e harness FAILED: ${msg}`);
  process.exit(1);
}

console.log(`cold-install harness — node ${process.version}, mode=${mode}, SOURCE=${source}`);
console.log(`pi: ${capture("pi", ["--version"]).trim()} · HOME=${os.homedir()} · user=${capture("id", ["-u"]).trim()}`);
if (os.homedir() === "/root") fail("the harness must run as a non-root user");

// --- the package under test ------------------------------------------------
let installTarget;
if (source === "npm") {
  installTarget = "npm:pi-matrix-integration@latest";
} else if (source === "tarball") {
  const pkgDir = "/tmp/pkg";
  fs.mkdirSync(pkgDir, { recursive: true });
  run("npm", ["pack", "--pack-destination", pkgDir, "--ignore-scripts"], { cwd: "/workspace" });
  const tgz = fs.readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail("npm pack produced no tarball");
  // prove the packed content first: unpack and let the content gate run
  // against the UNPACKED package (same command CI runs on the tarball).
  run("node", ["/workspace/tools/check-tarball.mjs", unpack(pkgDir, tgz)]);
  installTarget = path.join(pkgDir, tgz);
  console.log(`packed: ${tgz}`);
} else {
  fail(`unknown SOURCE=${source} (tarball|npm)`);
}

function unpack(pkgDir, tgz) {
  run("tar", ["xzf", path.join(pkgDir, tgz), "-C", pkgDir]);
  return path.join(pkgDir, "package");
}

installPackage(installTarget);

function installPackage(target) {
  if (!target.endsWith(".tgz")) {
    run("pi", ["install", target]);
    return;
  }
  try {
    run("pi", ["install", target]);
  } catch {
    // pi may reject a raw .tgz path; the unpacked package directory is the
    // equivalent cold install — same content, proven by the gate above.
    console.log("pi rejected the tarball path; installing the unpacked package instead");
    run("pi", ["install", path.join("/tmp/pkg", "package")]);
  }
}

// --- the cold context: only Pi and the package under test -------------------
const listed = capture("pi", ["list"]).trim();
console.log("\npi list:\n" + listed);
// pi list: "User packages:" headers, two-space entries, four-space resolved
// paths underneath. The entries are the installed sources.
const extensions = listed.split("\n").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
if (extensions.length !== expectedExtensions) {
  fail(`expected ${expectedExtensions} installed extension(s), found ${extensions.length}: ${JSON.stringify(extensions)}`);
}
if (!extensions.some((e) => e.includes("pi-matrix-integration"))) {
  fail(`the package under test is not among the installed extensions: ${JSON.stringify(extensions)}`);
}
console.log(`cold context OK: ${extensions.length} extension(s), no global config from the host`);

// --- the work tree (the repo is mounted read-only) --------------------------
run("cp", ["-r", "/workspace/.", work]);

if (mode === "offline") {
  // the network must actually be gone: reachability here means the harness
  // is lying about what it proved.
  let reachable = false;
  try {
    execFileSync("curl", ["-sI", "--max-time", "5", "https://registry.npmjs.org"], { stdio: "ignore" });
    reachable = true;
  } catch {
    /* expected */
  }
  if (reachable) fail("MODE=offline but the registry is reachable — the network is not blocked");
  console.log("network probe: unreachable, as required");
  process.env.npm_config_offline = "true";
  // deps-contract installs from the npm cache; mount the host cache in
  // (docker/compose.yaml) or seed it before the network goes away.
  run("npm", ["test"], { cwd: work, env: { ...process.env, npm_config_offline: "true" } });
  console.log("\ne2e-offline passed: the offline tier is green with no network at all");
  process.exit(0);
}

// --- full mode: credentials, or a loud refusal -------------------------------
const required = ["PI_MATRIX_HOMESERVER", "PI_MATRIX_USERNAME", "PI_MATRIX_PASSWORD"];
const missing = required.filter((v) => !process.env[v]);
if (missing.length > 0) {
  fail(`live tier refuses to run — missing environment variables: ${missing.join(", ")}`);
}

// headless /matrix-login: the extension's own login dialogue driven by a
// scripted ui — exactly the shape the offline login-wiring tests use — with
// a plain-fetch LoginClient (the client-server API contract in login.ts).
await headlessLogin(work);

run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: work });
run("npm", ["run", "test:live"], { cwd: work });
console.log("\ne2e passed: cold install logged in, connected, and the live tier is green");

async function headlessLogin(workDir) {
  const { createPiJiti } = await import(path.join(workDir, "test/_harness.mjs"));
  const jiti = await createPiJiti(import.meta.url);
  const { runLoginDialogue } = await jiti.import(path.join(workDir, "src/login.ts"));
  const homeserver = process.env.PI_MATRIX_HOMESERVER;
  const username = process.env.PI_MATRIX_USERNAME;
  const password = process.env.PI_MATRIX_PASSWORD;
  const alias = process.env.PI_MATRIX_ROOM ?? `e2e-${Math.floor(Date.now() / 1000)}`;

  const api = (token) => ({
    async loginWithPassword(user, pass) {
      const r = await fetch(`${homeserver}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password: pass }),
      });
      if (!r.ok) throw new Error(`login failed: ${r.status}`);
      const j = await r.json();
      if (j.user_id && j.device_id) return j;
      // MAS-shaped responses carry only tokens — whoami is the identity source.
      const w = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { authorization: `Bearer ${j.access_token}` },
      });
      const wj = await w.json();
      return { ...j, user_id: j.user_id ?? wj.user_id, device_id: j.device_id ?? wj.device_id ?? "" };
    },
    async resolveRoomAlias(a) {
      const r = await fetch(`${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(a)}`, {
        headers: auth(token),
      });
      if (!r.ok) throw Object.assign(new Error(`alias ${a}: ${r.status}`), { status: r.status });
      return r.json();
    },
    async createRoom(opts) {
      const r = await fetch(`${homeserver}/_matrix/client/v3/createRoom`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify(opts),
      });
      if (!r.ok) throw new Error(`createRoom: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async isRoomEncrypted(roomId) {
      const r = await fetch(
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        { headers: auth(token) },
      );
      if (!r.ok) return undefined;
      return Boolean((await r.json()).algorithm);
    },
    async setRoomAlias(roomId, a) {
      const r = await fetch(`${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(a)}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...auth(token) },
        body: JSON.stringify({ room_id: roomId }),
      });
      if (!r.ok) throw new Error(`setRoomAlias: ${r.status}`);
    },
    async invite(roomId, userId) {
      const r = await fetch(
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
        { method: "POST", headers: { "content-type": "application/json", ...auth(token) }, body: JSON.stringify({ user_id: userId }) },
      );
      if (!r.ok) throw new Error(`invite: ${r.status}`);
    },
  });
  const auth = (t) => (t ? { authorization: `Bearer ${t}` } : {});
  let accessToken = "";

  const ui = {
    async select(title, options) {
      if (/tour/i.test(title)) return options.find((o) => /no/i.test(o)) ?? options[0];
      return options[0]; // every default: encryption on, autoconnect, threaded, gitignore yes
    },
    async input(title, placeholder) {
      if (/homeserver/i.test(title)) return homeserver;
      if (/user/i.test(title)) return username;
      if (/room|alias/i.test(title)) return alias;
      return placeholder ?? "";
    },
    async password() {
      return password;
    },
    async confirm() {
      return true;
    },
    notify: (m, kind) => console.log(`  [login:${kind ?? "info"}] ${m}`),
  };

  const configPatch = {};
  const result = await runLoginDialogue({
    ui,
    credsDir: path.join(workDir, ".pi/matrix/accounts"),
    updateConfig: (patch) => Object.assign(configPatch, patch),
    makeLoginClient: () => {
      const c = api(accessToken);
      c.loginWithPassword = async (user, pass) => {
        const r = await api("").loginWithPassword(user, pass);
        accessToken = r.access_token;
        return r;
      };
      return c;
    },
    makeLoginClientWithToken: (_hs, t) => {
      accessToken = t;
      return api(t);
    },
    homeserverPrefill: homeserver,
    usernamePrefill: username,
    configuredRoomId: `#${alias}:${new URL(homeserver).host}`,
    cwd: workDir,
  });
  if (!result?.ok) fail(`headless login did not succeed: ${JSON.stringify(result)}`);

  // persist the dialogue's config writes where the extension reads them:
  // the project config of the work tree (the same file /matrix-login writes)
  const dir = path.join(workDir, ".pi/matrix");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "matrix-config.json"), JSON.stringify(configPatch, null, 2));
  console.log(`  [login] ok — room ${JSON.stringify(configPatch.roomId ?? "?")}, credentials at ${result.credentialsPath}`);
}
