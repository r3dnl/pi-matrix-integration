/**
 * Shared test harness for pi-matrix-integration.
 *
 * Resolves the installed @earendil-works/pi-coding-agent dynamically, the same
 * way pi itself resolves its loader, so these tests keep working across
 * node / fnm upgrades without hardcoded paths.
 *
 * Set PI_MATRIX_TEST_PI_PKG to override the package dir if `pi` is not on PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Test-seam flag: set here so every test that loads the extension via jiti is
// covered, and index.ts skips the project-config auto-creation (tests run from
// arbitrary cwds — the extension dir, scratch temps — and would both be
// polluted and read the seeded project defaults instead of the config each
// test was written against). Individual `node test/<file>.mjs` runs pick this
// up too, since they all import this harness.
process.env.PI_MATRIX_TEST = process.env.PI_MATRIX_TEST || "1";

/** Extension root (test/ is a sibling of index.ts). */
export const EXT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Locate the on-disk directory of the installed @earendil-works/pi-coding-agent.
 * Follows pi's own resolution: `pi` on PATH → fully-resolved symlink →
 * the .../node_modules/@earendil-works/pi-coding-agent segment.
 */
export function piPackageDir() {
  const override = process.env.PI_MATRIX_TEST_PI_PKG;
  if (override) return override;

  const bin = execSync("command -v pi", {
    shell: "/bin/sh",
    encoding: "utf8",
  }).trim();
  if (!bin) {
    throw new Error(
      "pi not found on PATH; set PI_MATRIX_TEST_PI_PKG to the installed " +
        "@earendil-works/pi-coding-agent directory",
    );
  }

  const real = fs.realpathSync(bin);
  const match = real.match(/^(.*\/node_modules\/@earendil-works\/pi-coding-agent)/);
  if (!match) {
    throw new Error(
      `could not locate @earendil-works/pi-coding-agent from ${real}; ` +
        "set PI_MATRIX_TEST_PI_PKG",
    );
  }
  return match[1];
}

/**
 * Create a jiti instance configured the way pi loads extensions: same module
 * cache (disabled for tests) and the loader aliases. baseUrl is the calling
 * test file's import.meta.url.
 */
export async function createPiJiti(baseUrl = import.meta.url) {
  const pkgDir = piPackageDir();
  const jitiPath = path.join(pkgDir, "node_modules", "jiti", "lib", "jiti-static.mjs");
  const { createJiti } = await import(jitiPath);

  const require = createRequire(path.join(pkgDir, "package.json"));
  const alias = {
    "@earendil-works/pi-coding-agent": path.join(pkgDir, "dist", "index.js"),
    "@earendil-works/pi-tui": path.join(
      pkgDir,
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "index.js",
    ),
    typebox: require.resolve("typebox"),
    "typebox/compile": require.resolve("typebox/compile"),
    "typebox/value": require.resolve("typebox/value"),
  };

  return createJiti(baseUrl, { moduleCache: false, alias });
}

/**
 * Await a condition instead of a fixed sleep: poll `pred` every
 * `intervalMs` until it returns truthy. Resolves as soon as it holds —
 * no wasted wall time, no load-dependent flake. Rejects on timeout so a
 * condition that can never be reached fails loudly instead of hanging.
 */
export async function waitUntil(
  pred,
  { timeoutMs = 5000, intervalMs = 10, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Tiny assertion helper shared by the logic tests. */
export function makeCheck(label = "") {
  let failures = 0;
  const failuresList = [];
  function check(name, cond, extra = "") {
    if (cond) {
      console.log(`  ok  ${name}`);
    } else {
      failures++;
      failuresList.push(name);
      console.error(`FAIL  ${name} ${extra}`);
    }
  }
  return {
    check,
    finish() {
      if (failures === 0) {
        console.log(`${label || "ALL"} CHECKS PASSED`);
        process.exit(0);
      }
      console.error(
        `${label ? label + ": " : ""}${failures} CHECK(S) FAILED: ${failuresList.join(", ")}`,
      );
      process.exit(1);
    },
  };
}
