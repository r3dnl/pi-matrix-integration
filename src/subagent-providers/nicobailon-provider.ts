/**
 * Provider adapter: the `pi-subagents` dialect (nicobailon).
 *
 * Package: npm:pi-subagents 0.80.0 (verified against the installed source,
 * not just its docs). The RPC envelope (src/extension/rpc.js): request on
 * `subagents:rpc:v1:request` with `{version:1, requestId, method, params}`;
 * replies arrive on the per-request channel `subagents:rpc:v1:reply:<id>`
 * as `{version, requestId, method, success, data}` (errors: `success:false`
 * + `error`) — one listener per call. There is no SYNCHRONOUS availability
 * probe: every method is async, so `isAvailable()` is a `ping` round-trip.
 * Spawn takes the tool params (`{agent, task, async:true, ...}`) and its
 * `data` is `{text, details:{runId, asyncId, ...}}`; completion arrives
 * later on `subagent:async-complete` (job-shaped payload: `{id,
 * runId, sessionId, state, success, summary}`), matched by RUN ID — the
 * notify message is a session custom message, not a bus channel, so the
 * bus event is the only correlate available here.
 *
 * Runner posture lives in lifecycle.ts `isSubagentRunner()` (the package's
 * `PI_SUBAGENT_CHILD=1` marker; configuration-and-room-behaviour.md).
 *
 * References:
 *   package docs/api.md — envelope, ping/spawn methods, reply channels
 *   package docs/background-work.md — runner env + provider seams
 *   configuration-and-room-behaviour.md (this adapter), configuration-and-room-behaviour.md (watch names)
 */
import type { AgentSpawnInput } from "../subagent-bus.js";
import {
  newRequestId,
  unref,
  type SubagentProvider,
  type SubagentProviderDeps,
  type SpawnWatch,
} from "../subagent-provider.js";

const REQUEST = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE = "subagent:async-complete";
const NAME_CAP = 120;

/** First meaningful line, capped — the bus renders spawn labels as
 *  `⚡ Agent starting: <name>` and the nicobailon `task` is free text. */
function nameFrom(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > NAME_CAP ? `${line.slice(0, NAME_CAP - 3)}...` : line;
}

/** Completion payloads, matched by the spawn-ack run id. */
interface Settled {
  runId: string;
  text: string | null;
  failure?: string;
}

export function createNicobailonProvider(deps: SubagentProviderDeps): SubagentProvider {
  const { events, logger, agentType, model, pingTimeoutMs, runTimeoutMs, spawnTimeoutMs = 30_000 } = deps;

  /** One RPC round-trip; null when nobody answers the reply channel. */
  function rpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const requestId = newRequestId();
      let settled = false;
      const done = (reply: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolve(reply);
      };
      const unsub = events.on(REPLY_PREFIX + requestId, (data: unknown) =>
        done((data ?? null) as Record<string, unknown> | null),
      );
      const timer = unref(setTimeout(() => done(null), timeoutMs));
      events.emit(REQUEST, { version: 1, requestId, method, params });
    });
  }

  async function isAvailable(): Promise<boolean> {
    const reply = await rpc("ping", {}, pingTimeoutMs);
    return reply?.success === true;
  }

  /** Normalize the async-complete event into one shape (result-file data
   *  spread: {id, runId, state, success, summary}; `summary` carries the
   *  final text on a complete run). */
  function settleFrom(raw: unknown, want: string): Settled | null {
    const p = raw as
      | {
          id?: string;
          runId?: string;
          state?: string;
          success?: boolean;
          summary?: string;
          text?: string;
        }
      | undefined;
    if (!p) return null;
    const runId = p.runId ?? p.id;
    if (!runId || runId !== want) return null;
    if (p.success !== true || (p.state && p.state !== "complete")) {
      return { runId, text: null, failure: String(p.summary ?? p.state ?? "failed") };
    }
    const text = typeof p.summary === "string" ? p.summary : typeof p.text === "string" ? p.text : "";
    // The wake harness prepends `<agentName>:` to completion payloads; the root
    // edit must carry summary content only (observed on the live root 2026-10-24).
    const stripped = text.startsWith(`${agentType}:`) ? text.slice(agentType.length + 1) : text;
    return { runId, text: stripped.trim() };
  }

  async function runIsolated(prompt: string, description?: string): Promise<string | null> {
    if (!(await isAvailable())) return null;

    // 1) Spawn (async mode — the ack carries the run id in `data.details`)
    //    and wait for it.
    const spawnReply = await rpc(
      "spawn",
      {
        agent: agentType,
        task: prompt,
        async: true,
        ...(model !== undefined ? { model } : {}),
        // pi-subagents 0.80.0 wakes the parent on EVERY async completion
        // (the 2026-10 summary loop, fix C); notify.js only honors
        // `scheduleOrigin.quiet` on the workflow paths. The
        // pi-subagents.quiet-single-spawn.patch teaches the single path to
        // carry it, and this origin makes a successful completion deliver
        // its notice WITHOUT a parent turn. Unpatched package: the field is
        // ignored — the wake stays and the lifecycle absorb-guard handles it.
        scheduleOrigin: { id: "pi-matrix-thread-summarizer", quiet: true },
      },
      spawnTimeoutMs,
    );
    const details = spawnReply?.data as { details?: { runId?: string; asyncId?: string } } | undefined;
    const runId =
      spawnReply?.success === true
        ? details?.details?.runId ?? details?.details?.asyncId ?? null
        : null;
    if (!runId) {
      const err = spawnReply
        ? String(
            (spawnReply.error as { message?: string } | undefined)?.message ??
              (spawnReply.data as { text?: string } | undefined)?.text ??
              "no runId",
          )
        : "no reply";
      logger.warn(`[matrix] summarizer spawn failed: ${err}`);
      return null;
    }

    // 2) Wait for the asyncComplete event, matched by run id. The result
    //    arrives on the bus regardless of wake posture; with the quiet
    //    spawn origin + quiet-single-spawn.patch no parent turn fires, and
    //    failures still wake (scheduledCompletionTriggersTurn only quiets
    //    "completed").
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const cleanups: Array<() => void> = [];
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        cleanups.forEach((c) => c());
        resolve(value);
      };
      const route = (raw: unknown) => {
        const s = settleFrom(raw, runId);
        if (!s) return;
        if (s.failure) {
          logger.warn(`[matrix] summarizer run failed: ${s.failure} — keeping the last summary`);
          finish(null);
        } else if (s.text) {
          finish(s.text);
        }
        // empty summary → ignore, keep waiting (a later event may carry it)
      };
      cleanups.push(events.on(ASYNC_COMPLETE, route));
      unref(setTimeout(() => {
        if (settled) return;
        // Was silent: a slow-but-successful run blew the budget and its
        // result arrived after nobody listened. Self-report the drop.
        logger.warn(`[matrix] summarizer run exceeded ${runTimeoutMs}ms — result dropped, keeping the last summary`);
        finish(null);
      }, runTimeoutMs));
    });
  }

  /** Second consumer for the same completion stream (pane tracking, H1):
   *  forwards every completion this bus sees, keyed by run id — failures
   *  included (the room's spawn line must settle "done" either way). */
  function completionChannel(onSettle: (name: string, result: string) => void): () => void {
    const forward = (raw: unknown) => {
      const p = raw as { runId?: string; id?: string } | undefined;
      const s = settleFrom(raw, p?.runId ?? p?.id ?? "");
      if (s) onSettle(s.runId, s.text ?? s.failure ?? "");
    };
    return events.on(ASYNC_COMPLETE, forward);
  }

  // This dialect's spawn tools: the `subagent` tool (its `Agent` sibling
  // when the core tool is also loaded) and `workflow` containers
  const spawnWatch: SpawnWatch = {
    agentToolNames: ["subagent", "Agent"],
    workflowToolNames: ["workflow"],
    normalizeAgent(input) {
      const name =
        typeof input.task === "string" && input.task.trim()
          ? nameFrom(input.task)
          : typeof input.agent === "string" && input.agent
            ? String(input.agent)
            : null;
      if (!name) return null;
      const type =
        typeof input.agent === "string" && input.agent ? String(input.agent) : "subagent";
      return { name, subagent_type: type };
    },
    normalizeWorkflow(input) {
      const name =
        typeof input.name === "string" && input.name ? nameFrom(String(input.name)) : "workflow";
      return { name, subagent_type: "workflow" };
    },
  };

  return { id: "nicobailon", isAvailable, runIsolated, spawnWatch, completionChannel };
}
