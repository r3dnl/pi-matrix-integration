/**
 * Shared behavioral contract for the provider adapters
 * (DESIGN-SUBAGENT-PROVIDER §8: "both adapters pass one shared behavioral
 * test kit"). Each dialect test passes a descriptor + its `check`; the
 * scenarios below are what BOTH providers must do identically —
 * availability yes/no/silent-timeout, isolated-run happy/timeout/absent/
 * spawn-fail/fail/empty, and the `auto` resolver binding. Dialect wire
 * details (spawn payload shape, consume suppression, normalizers, notify
 * fallback) live in the per-dialect files.
 *
 * Descriptor:
 *   id           "tintinweb" | "nicobailon"
 *   makeBus(opts) → { bus, spawns, consumed?, auto? } — a fake pi.events
 *                  bus speaking THIS dialect; opts: { scenario, result }
 *                  (scenario: ok | unavailable | silent | spawn-fail |
 *                  fail | hang). `auto` = same bus answering BOTH
 *                  dialects (resolver-probe case).
 *   assertSpawn(spawns, check) — the dialect's spawn-request shape
 */
import path from "node:path";
import { EXT_DIR } from "./_harness.mjs";

export async function providerContract(jiti, check, D) {
  const { resolveSubagentProvider } = await jiti.import(
    path.join(EXT_DIR, "src/subagent-providers/resolve.ts"),
  );
  const logger = () => {
    const warns = [];
    return {
      warns,
      logger: {
        info() {},
        warn: (m) => warns.push(String(m)),
        error: (m) => warns.push(String(m)),
        debug() {},
      },
    };
  };
  const depsOf = (bus, over = {}) => {
    const { warns, logger: log } = logger();
    return {
      warns,
      deps: {
        events: bus,
        logger: log,
        agentType: "pi-matrix-integration-thread-summarizer",
        pingTimeoutMs: 20,
        runTimeoutMs: 500,
        ...over,
      },
    };
  };
  const SUMMARY = "# Topic: t\n## Main discussion points\n- x";

  // -- available: handshake succeeds, run resolves the result ------------
  {
    const { bus, spawns, consumed } = D.makeBus({ scenario: "ok", result: SUMMARY });
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps); // explicit: no probe flip
    check("handshake → available", (await p.isAvailable()) === true, "");
    const out = await p.runIsolated("PROMPT");
    check("run resolves to the result body", out === SUMMARY, JSON.stringify(out));
    D.assertSpawn(spawns, check);
    if (consumed) check("result consumed (no completion notification)", consumed() >= 1, String(consumed()));
  }

  // -- explicit dialect, host says not-present → unavailable --------------
  {
    const { bus, spawns } = D.makeBus({ scenario: "unavailable" });
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps);
    check("absent host → unavailable", (await p.isAvailable()) === false, "");
    check("absent host → run null, no spawn", (await p.runIsolated("P")) === null && spawns.length === 0, "");
  }

  // -- explicit dialect, SILENT host → the timeout arms resolve -----------
  // The historical bug: a reply-less ping used to hang forever. Both
  // adapters must time out and read the dialect as absent.
  {
    const { bus, spawns } = D.makeBus({ scenario: "silent" });
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps);
    const t0 = Date.now();
    const ok = await Promise.race([
      p.isAvailable(),
      new Promise((r) => setTimeout(() => r("hang"), 3000)),
    ]);
    check("silent host → unavailable via timeout (no hang)", ok === false, String(ok));
    check("the timeout is bounded", Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
    check("silent host → run null, no spawn", (await p.runIsolated("P")) === null && spawns.length === 0, "");
  }

  // -- failed run → null (keep the last summary) --------------------------
  {
    const { bus } = D.makeBus({ scenario: "fail", result: "must not be used" });
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps);
    check("failed run → null", (await p.runIsolated("P")) === null, "");
  }

  // -- empty result → null (must not clobber the root) --------------------
  {
    const { bus } = D.makeBus({ scenario: "ok", result: "   " });
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps);
    check("empty result → null", (await p.runIsolated("P")) === null, "");
  }

  // -- spawn rejected → null, warned ---------------------------------------
  {
    const { bus, spawns } = D.makeBus({ scenario: "spawn-fail" });
    const { deps, warns } = depsOf(bus);
    const p = resolveSubagentProvider(D.id, deps);
    check("spawn rejection → null", (await p.runIsolated("P")) === null, "");
    check("a spawn was attempted", spawns.length === 1, String(spawns.length));
    check("the rejection is logged", warns.some((w) => /spawn/i.test(w)), warns.join("|"));
  }

  // -- run never settles → the timeout guard releases the caller ----------
  {
    const { bus } = D.makeBus({ scenario: "hang" });
    const { deps } = depsOf(bus, { runTimeoutMs: 120 });
    const p = resolveSubagentProvider(D.id, deps);
    const t0 = Date.now();
    const out = await p.runIsolated("P");
    check("hung run → null at the run budget", out === null, String(out));
    check("the guard fires near the budget", Date.now() - t0 >= 100 && Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  }

  // -- auto: binds whichever dialect's channel answers --------------------
  {
    const bus = D.makeBus({ scenario: "ok", result: SUMMARY, auto: true }).bus;
    const { deps } = depsOf(bus);
    const p = resolveSubagentProvider("auto", deps);
    check("auto → available through the probe", (await p.isAvailable()) === true, "");
    check(`auto resolved to the answering dialect (${D.id})`, p.id === D.id, p.id);
  }
}
