/**
 * Pi Matrix Integration — sub-agent bus.
 *
 * Side-chain (sub-agent) sessions each run their OWN extension instance in
 * the same process; only the main session's instance owns the single Matrix
 * connection. The owner publishes this bus on `globalThis`; side-chain
 * instances look it up at call time and post through the owner (one
 * connection per process, configuration-and-room-behaviour.md).
 *
 * Owner state is in-memory only: colors are deterministic per agent TYPE
 * (palette hash, configuration-and-room-behaviour.md), so nothing is persisted.
 */

import { convertMarkdown } from "./markdown.js";

export interface SubagentSpawnRecord {
  /** Normalized prompt (depth 1) or `${parentName}::${prompt}` (depth 2). */
  key: string;
  name: string;
  type: string;
  model: string;
  thinking: string | null;
  prompt: string;
  spawnAt: number;
  settleAt?: number;
  /** 1 = spawned by the main session; 2 = spawned from inside a side chain. */
  depth: 1 | 2;
  parentName?: string;
  color: string;
  sessionId?: string;
  sessionName?: string;
  /** The provider's run id (attached from the spawn's tool_result); the
   *  join key for detached-child completions on the completion channel
  runId?: string;
  spawnAnchorEventId?: string;
  status: "running" | "settled";
  /** True when the summarizeResultIntoSpawnLine anchor edit has landed. */
  anchorEdited: boolean;
}

export interface SubagentPostIdentity {
  recordKey: string;
  name: string;
  color: string;
  depth: 1 | 2;
}

/** Owner-injected write surface (the owner's connected pipeline). */
export interface SubagentBusPost {
  /** Post a line into the main thread (flat fallback is the pipeline's job). */
  send(
    text: string,
    html?: string,
  ): Promise<{ success: boolean; eventId?: string; error?: string }>;
  /** Edit a posted event in place (m.replace). */
  edit(eventId: string, text: string, html?: string): Promise<boolean>;
}

export interface SubagentSettings {
  /** Master gate: off → no reporting at all (records still exist —
   *  detection is always on). */
  enabled: boolean;
  spawnMessages: boolean;
  summarizeResultIntoSpawnLine: boolean;
  postMode: "turn-end" | "all";
  colorByType?: Record<string, string>;
  colorPalette?: string[];
  plainMarker?: string;
}

export interface AgentSpawnInput {
  name?: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  thinking?: string | null;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the logic tests)
// ---------------------------------------------------------------------------

export const DEFAULT_PALETTE = [
  "#E91E63", // pink
  "#9C27B0", // purple
  "#3F51B5", // indigo
  "#009688", // teal
  "#4CAF50", // green
  "#FF9800", // orange
  "#FF5722", // deep orange
  "#607D8B", // blue grey
];

/** FNV-1a — deterministic string hash (color slot, record stability). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The type-based color (configuration-and-room-behaviour.md): user pin first, palette hash second. */
export function colorForType(type: string, settings: SubagentSettings): string {
  const palette =
    settings.colorPalette && settings.colorPalette.length > 0
      ? settings.colorPalette
      : DEFAULT_PALETTE;
  const key = type && type !== "" ? type : "unknown";
  const pinned = settings.colorByType?.[key];
  if (pinned) return pinned;
  return palette[fnv1a(key) % palette.length];
}

/** Prompt normalization for record keys: trim + collapse whitespace. */
export function normalizePrompt(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Spawn metadata from an `Agent` tool_call input. */
export function agentSpawnMeta(input: AgentSpawnInput): {
  name: string;
  type: string;
  model: string;
  thinking: string | null;
} {
  const str = (v: unknown) => (typeof v === "string" && v ? v : "");
  return {
    name: str(input.name) || str(input.description) || str(input.subagent_type) || "agent",
    type: str(input.subagent_type) || "general",
    model: str(input.model) || "(session model)",
    thinking: typeof input.thinking === "string" && input.thinking ? input.thinking : null,
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

/** First non-empty line of a text block (the "result" hint). */
export function firstLine(s: string, max = 200): string {
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? truncateText(line, max) : "";
}

/** Fixed tint for the `⚡ Agent result:` label — distinct from the agent's
 *  type color so a result reads as "done" against the spawn line (the design doc
 *  configuration-and-room-behaviour.md). */
export const RESULT_LINE_COLOR = "#2E7D32";

/**
 * The colored/plain rendering of a line (configuration-and-room-behaviour.md). `tint` is the
 * actor label; the rest of the line stays plain (html: the label wrapped in
 * a `<font>` span, the remainder escaped).
 */
export function tintedLine(
  tint: string,
  rest: string,
  color: string | undefined,
  sendFormatted: boolean,
): { text: string; html?: string } {
  const text = `${tint}${rest}`;
  if (!sendFormatted || !color) return { text };
  return {
    text,
    html: `<font color="${escapeHtml(color)}">${escapeHtml(tint)}</font>${rest ? convertMarkdown(rest).html : ""}`,
  };
}

export function spawnLine(
  rec: SubagentSpawnRecord,
  settings: SubagentSettings,
  sendFormatted: boolean,
): { text: string; html?: string } {
  const marker = settings.plainMarker ?? "⚡";
  // Explicit meta (configuration-and-room-behaviour.md): type, model
  // and thinking always show; unknown thinking renders as `default`.
  const meta = [rec.type, rec.model, rec.thinking ? `thinking=${rec.thinking}` : "thinking=default"]
    .filter(Boolean)
    .join(" · ");
  const prefix =
    rec.depth === 2
      ? `↳ ${rec.parentName ?? "?"} spawned ${rec.name}`
      : `${marker} Spawn subagent, task: ${rec.name}`;
  return tintedLine(prefix, ` (${meta}) — running, ${fmtClock(rec.spawnAt)}`, sendFormatted && rec.color ? rec.color : undefined, sendFormatted);
}

export function settleLine(
  rec: SubagentSpawnRecord,
  settings: SubagentSettings,
  sendFormatted: boolean,
): { text: string; html?: string } {
  const dur = fmtDuration((rec.settleAt ?? rec.spawnAt) - rec.spawnAt);
  const marker = settings.plainMarker ?? "⚡";
  // A settled spawn IS the spawn message, now
  // showing status + explicit meta. No result text —
  // the result lives only in the `⚡ Agent result:` line.
  const label =
    rec.depth === 2
      ? `↳ ${rec.name} [nested]: settled in ${dur}`
      : `${marker} Spawn subagent, task: ${rec.name} · settled in ${dur}`;
  const meta =
    rec.depth === 2 ? "" : ` · ${rec.type} · ${rec.model} · thinking=${rec.thinking ?? "default"}`;
  return tintedLine(label, meta, sendFormatted && rec.color ? rec.color : undefined, sendFormatted);
}

/** Post-mode traffic line (a bound session's turn-final / assistant message).
 *  The `Agent result` label carries the fixed result tint (configuration-and-room-behaviour.md). */
export function trafficLine(
  name: string,
  text: string,
  plainMarker: string,
  sendFormatted: boolean,
): { text: string; html?: string } {
  return tintedLine(`${plainMarker ?? "⚡"} Agent result: ${name}: `, text, RESULT_LINE_COLOR, sendFormatted);
}

// ---------------------------------------------------------------------------
// The bus (owner-side implementation)
// ---------------------------------------------------------------------------

const BUS_KEY = Symbol.for("pi-matrix.subagent-bus");
type BusGlobal = typeof globalThis & { [BUS_KEY]?: SubagentBusImpl };

export interface SubagentBusImpl {
  /** True while this owner generation is alive (stale-client guard). */
  alive: boolean;
  spawn(input: AgentSpawnInput): SubagentSpawnRecord;
  nestedSpawn(parentName: string, input: AgentSpawnInput): void;
  bind(
    sessionId: string,
    sessionName: string,
    prompt: string,
    parentIsSidechain: boolean,
  ): SubagentPostIdentity | null;
  /** Post a traffic line (postMode). Fire-and-forget; unbound → no-op. */
  post(sessionId: string, text: string, kind: "turn" | "message"): void;
  /** agent_settled — post the settle line / edit the anchor. */
  settle(sessionId: string, lastAssistant: string): void;
  /** Attach the provider run id to the running depth-1 record for this
   *  prompt (the parent's spawn tool_result). No record → no-op. */
  attachRunId(prompt: string, runId: string): void;
  /** Completion-channel settle: settle the record with this run id. */
  settleByRunId(runId: string): void;
  setAnchor(key: string, eventId: string): void;
  list(): readonly SubagentSpawnRecord[];
}

export function createSubagentBus(
  settings: () => SubagentSettings,
  sendFormatted: () => boolean,
  post: SubagentBusPost,
  log?: (line: string) => void,
  sessionMeta?: () => { model?: string; thinking?: string | null },
): SubagentBusImpl {
  const records = new Map<string, SubagentSpawnRecord>();

  const makeRecord = (
    input: AgentSpawnInput,
    depth: 1 | 2,
    parentName?: string,
  ): SubagentSpawnRecord => {
    const meta = agentSpawnMeta(input);
    // Explicit meta (configuration-and-room-behaviour.md): resolve the session's current model /
    // thinking when the spawn carries no override.
    const sm = sessionMeta?.();
    if (meta.model === "(session model)" && sm?.model) meta.model = sm.model;
    if (!meta.thinking && sm?.thinking) meta.thinking = sm.thinking;
    const prompt = normalizePrompt(input.prompt ?? "");
    const key = depth === 2 ? `${parentName}::${prompt}` : prompt;
    const s = settings();
    return {
      key,
      name: meta.name,
      type: meta.type,
      model: meta.model,
      thinking: meta.thinking,
      prompt,
      spawnAt: Date.now(),
      depth,
      parentName,
      color: colorForType(meta.type, s),
      status: "running",
      anchorEdited: false,
    };
  };

  const postSpawnLine = (rec: SubagentSpawnRecord): void => {
    const s = settings();
    if (!s.enabled || !s.spawnMessages) return;
    const line = spawnLine(rec, s, sendFormatted());
    void post
      .send(line.text, line.html)
      .then((r) => {
        // A failed send must not vanish: the spawn line is the room's only
        // record that this agent started.
        if (!r.success) {
          log?.(`[matrix] subagent spawn line DROPPED: ${r.error}`);
        } else if (r.eventId && s.summarizeResultIntoSpawnLine) {
          rec.spawnAnchorEventId = r.eventId;
        }
      })
      .catch((err) => log?.(`[matrix] subagent spawn line failed: ${err}`));
  };

  const byPrompt = (prompt: string, parentIsSidechain: boolean): SubagentSpawnRecord | undefined => {
    const p = normalizePrompt(prompt);
    const running = [...records.values()].filter((r) => r.status === "running");
    if (parentIsSidechain) {
      const d2 = running.find((r) => r.depth === 2 && r.prompt === p);
      if (d2) return d2;
    }
    return running.find((r) => r.depth === 1 && r.prompt === p);
  };

  // The single settle body (agent_settled and completion-channel
  // settles both land here; the caller has already checked status).
  const settleRecord = (rec: SubagentSpawnRecord): void => {
    rec.status = "settled";
    rec.settleAt = Date.now();
    const s = settings();
    if (!s.enabled) return;
    const line = settleLine(rec, s, sendFormatted());
    if (rec.depth === 2) {
      // Nested: milestone only — one settle line, no anchor (configuration-and-room-behaviour.md).
      void post.send(line.text, line.html).catch((err) => log?.(`[matrix] subagent nested settle failed: ${err}`));
      return;
    }
    if (s.summarizeResultIntoSpawnLine && rec.spawnAnchorEventId) {
      // summarizeResultIntoSpawnLine: edit the spawn anchor in place into
      // the settle header (status + meta, no result);
      // the plain settle line lands only when the edit did not.
      void post
        .edit(rec.spawnAnchorEventId, line.text, line.html)
        .then((ok) => {
          rec.anchorEdited = ok;
          if (!ok) {
            log?.("[matrix] subagent anchor edit failed — posting settle line instead");
            return post.send(line.text, line.html);
          }
          return { success: true };
        })
        .catch((err) => log?.(`[matrix] subagent settle (anchor) failed: ${err}`));
      return;
    }
    // separate settle line (summarizeResultIntoSpawnLine: false).
    void post.send(line.text, line.html).catch((err) => log?.(`[matrix] subagent settle line failed: ${err}`));
  };

  const impl: SubagentBusImpl = {
    alive: true,
    spawn(input) {
      const rec = makeRecord(input, 1);
      if (rec.prompt) {
        // Same prompt re-spawned while the old one is still running: keep the
        // older record (one record per logical agent — the resume path).
        const existing = [...records.values()].find(
          (r) => r.depth === 1 && r.prompt === rec.prompt && r.status === "running",
        );
        if (existing) {
          existing.sessionId = undefined; // the new session re-binds
          log?.(`[matrix] subagent re-spawn (${rec.name}) — reusing running record`);
          return existing;
        }
        records.set(rec.key, rec);
      }
      postSpawnLine(rec);
      return rec;
    },
    nestedSpawn(parentName, input) {
      const rec = makeRecord(input, 2, parentName);
      if (rec.prompt) records.set(rec.key, rec);
      postSpawnLine(rec);
    },
    bind(sessionId, sessionName, prompt, parentIsSidechain) {
      const rec = byPrompt(prompt, parentIsSidechain);
      if (!rec) {
        log?.(`[matrix] subagent session ${sessionId} unbound (no matching spawn record)`);
        return null;
      }
      rec.sessionId = sessionId;
      rec.sessionName = sessionName;
      return { recordKey: rec.key, name: rec.name, color: rec.color, depth: rec.depth };
    },
    post(sessionId, text, kind) {
      const rec = [...records.values()].find((r) => r.sessionId === sessionId);
      if (!rec || rec.status === "settled") return;
      const s = settings();
      if (!s.enabled) return;
      if (rec.depth === 2) return; // v1: nested agents are milestone-only
      if (s.postMode === "turn-end" && kind === "message") return; // only the turn-final
      const line = trafficLine(rec.name, text, s.plainMarker ?? "⚡", sendFormatted());
      void post
        .send(line.text, line.html)
        .catch((err) => log?.(`[matrix] subagent traffic line failed: ${err}`));
    },
    settle(sessionId, _lastAssistant) {
      const rec = [...records.values()].find((r) => r.sessionId === sessionId);
      if (!rec || rec.status === "settled") return;
      settleRecord(rec);
    },
    attachRunId(prompt, runId) {
      const rec = byPrompt(prompt, false);
      if (rec) rec.runId = runId;
    },
    settleByRunId(runId) {
      const rec = [...records.values()].find((r) => r.runId === runId);
      if (!rec || rec.status === "settled") return;
      settleRecord(rec);
    },
    setAnchor(key, eventId) {
      const rec = records.get(key);
      if (rec) rec.spawnAnchorEventId = eventId;
    },
    list() {
      return [...records.values()];
    },
  };
  return impl;
}

/** Publish this process's owner bus (the main session's instance). */
export function publishOwnerBus(bus: SubagentBusImpl): void {
  (globalThis as BusGlobal)[BUS_KEY] = bus;
}

/** Look up the owner bus (side-chain instances + /matrix-subagents). */
export function ownerBus(): SubagentBusImpl | null {
  const bus = (globalThis as BusGlobal)[BUS_KEY];
  return bus && bus.alive ? bus : null;
}

/** Clear the owner pointer (owner dispose). */
export function clearOwnerBus(): void {
  delete (globalThis as BusGlobal)[BUS_KEY];
}
