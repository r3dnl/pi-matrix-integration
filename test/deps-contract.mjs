// Dependency and supply-chain contract (release story 5).
// Proves the published install is reproducible from the lockfile, contains
// nothing beyond the declared production graph, and that the crypto WASM
// loads from the installed package without any network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// 1. the full tree resolves: no missing, invalid or unmet peers.
{
  try {
    // The manifest job installs with `npm ci --omit=dev`; asking about the
    // FULL tree there reports the deliberately-absent dev deps and the
    // host-provided peers as "missing" (exit 1) — a predicate for a tree CI
    // never installs. Ask about the tree CI actually has.
    cp.execSync("npm ls --all --omit=dev", { cwd: ROOT, stdio: "ignore" });
    check("npm ls --all --omit=dev exits 0", true);
  } catch (error) {
    check("npm ls --all --omit=dev exits 0", false, String(error.message).slice(0, 120));
  }
}

// 2. a clean `npm ci --omit=dev` from package.json + lock alone succeeds
//    and installs EXACTLY the production graph the lockfile declares.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deps-contract-"));
  try {
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
    fs.copyFileSync(path.join(ROOT, "package-lock.json"), path.join(tmp, "package-lock.json"));
    cp.execSync("npm ci --omit=dev --no-audit --no-fund --silent", {
      cwd: tmp,
      stdio: "ignore",
      timeout: 300_000,
    });
    check("npm ci --omit=dev succeeds from the lockfile alone", true);

    // No package may appear that the lockfile does not know as a
    // production package: that is how a hoisted peer-tree surprise
    // (another agent's openai/aws stack) would surface. Exact set
    // equality against the lock's non-dev entries is too strict — the
    // lock marks dev-shared packages dev:false and `--omit=dev` rightly
    // skips them.
    const nonDev = new Set();
    for (const key of Object.keys(lock.packages)) {
      if (!key.startsWith("node_modules/")) continue;
      if (lock.packages[key].dev) continue;
      const name = key.slice("node_modules/".length);
      nonDev.add(name.split("/")[0].startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
    }
    const actual = new Set(
      fs
        .readdirSync(path.join(tmp, "node_modules"))
        .filter((e) => !e.startsWith("."))
        .flatMap((e) =>
          e.startsWith("@") ? fs.readdirSync(path.join(tmp, "node_modules", e)).map((s) => `${e}/${s}`) : [e],
        ),
    );
    const surprise = [...actual].filter((x) => !nonDev.has(x));
    check(
      "installed tree holds no package outside the lockfile's production set",
      surprise.length === 0,
      `unexpected: ${surprise.slice(0, 6).join(", ")}`,
    );
    // Host peers are Pi's to provide; npm must not have fetched them.
    const peers = Object.keys(pkg.peerDependencies).filter((p) => actual.has(p));
    check("no peer dependency was auto-installed", peers.length === 0, peers.join(", "));
    // The five declared dependencies must be among them.
    const absent = Object.keys(pkg.dependencies).filter((d) => !actual.has(d));
    check("all five declared dependencies are installed", absent.length === 0, absent.join(", "));
  } catch (error) {
    check("npm ci --omit=dev succeeds from the lockfile alone", false, String(error.message).slice(0, 120));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 3. the crypto WASM loads offline: with fetch removed, importing and
//    initialising the wasm module must still work — the bytes come from
//    the installed package, never from a remote host.
{
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = () => {
      throw new Error("network use during wasm load (story 5 contract: WASM ships installed)");
    };
    const w = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await (w.initAsync ? w.initAsync() : Promise.resolve());
    check("crypto WASM initialises with fetch removed", true);
  } catch (error) {
    check("crypto WASM initialises with fetch removed", false, String(error.message).slice(0, 160));
  } finally {
    globalThis.fetch = savedFetch;
  }
}

if (failures) {
  console.error(`deps-contract: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("deps-contract CHECKS PASSED");
