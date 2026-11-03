/**
 * Provider selection: the one place that
 * knows both dialects. `subagents.provider` names the dialect; `auto`
 * binds today's tintinweb dialect synchronously (zero behavior change at
 * startup) and re-binds asynchronously when tintinweb's ping is silent
 * AND the nicobailon host answers its own ping — the settings-free auto
 * mode. Pi's EventBus exposes only `on`/`emit`, so the probe IS the
 * dialect handshake; nothing else can ask "who is listening?".
 *
 * Deliberately a leaf module: the adapters must never import it (the
 * resolver imports them, never the reverse — no cycles).
 */
import type {
  SubagentProvider,
  SubagentProviderDeps,
  SubagentProviderId,
  SubagentProviderSetting,
} from "../subagent-provider.js";
import { createTintinwebProvider } from "./tintinweb-provider.js";
import { createNicobailonProvider } from "./nicobailon-provider.js";

const FACTORIES: Record<SubagentProviderId, (deps: SubagentProviderDeps) => SubagentProvider> = {
  tintinweb: createTintinwebProvider,
  nicobailon: createNicobailonProvider,
};

export function resolveSubagentProvider(
  setting: SubagentProviderSetting,
  deps: SubagentProviderDeps,
): SubagentProvider {
  if (setting !== "auto") return FACTORIES[setting](deps);

  const primary = createTintinwebProvider(deps);
  let rebound: SubagentProvider | null = null;
  // Live completion-channel subscribers (integration.ts wires ONE): on the
  // auto-flip they must be re-issued against the answering dialect — a
  // subscriber that bound the silent primary at startup would otherwise
  // never hear completions.
  const channels = new Map<(name: string, result: string) => void, () => void>();
  const decided = primary.isAvailable().then(async (ok) => {
    if (ok) return primary;
    const candidate = createNicobailonProvider(deps);
    if (await candidate.isAvailable()) {
      deps.logger.warn(
        '[matrix] subagents: @tintinweb did not answer, pi-subagents did — bound the nicobailon dialect (set subagents.provider = "nicobailon" to make it explicit)',
      );
      return candidate;
    }
    return primary;
  });
  // Side branch: rebind + re-issue channels once decided. The main path
  // awaits `decided` itself; this branch swallows rejections so a probe
  // failure cannot surface as an unhandled rejection here.
  decided
    .then((p) => {
      rebound = p;
      for (const [cb] of channels) {
        channels.get(cb)?.();
        channels.set(cb, p.completionChannel?.(cb) ?? (() => {}));
      }
    })
    .catch(() => {});
  const live = () => rebound ?? primary;
  return {
    get id() {
      return live().id;
    },
    isAvailable: () => decided.then((p) => p.isAvailable()),
    runIsolated: (prompt, description) => live().runIsolated(prompt, description),
    completionChannel: (onSettle) => {
      channels.set(onSettle, live().completionChannel?.(onSettle) ?? (() => {}));
      return () => {
        channels.get(onSettle)?.();
        channels.delete(onSettle);
      };
    },
    get spawnWatch() {
      return live().spawnWatch;
    },
  };
}
