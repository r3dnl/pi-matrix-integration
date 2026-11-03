/**
 * Pi Matrix Integration — tintinweb provider adapter
 *
 * The `@tintinweb/pi-subagents` 0.19–0.22 RPC dialect, moved verbatim from
 * subagent-summarizer.ts: ping `subagents:rpc:ping` →
 * `subagents:rpc:ping:reply:<id>`; spawn `subagents:rpc:spawn` (isolated →
 * the child loads no extensions, so no stray thread root / 2nd Matrix
 * connection, threads-and-summaries.md) → agent id; completion
 * `subagents:completed` / failure `subagents:failed` matched by id; result
 * consumed via `subagents:rpc:consume` (a synchronous consume inside the
 * completed handler is the clean path, configuration-and-room-behaviour.md / rpc.md).
 *
 * A programmatic spawn (this path) is NOT a main-session `subagent` tool
 * call, so the matrix extension's `tool_call`/`tool_result` sub-thread
 * watchers never see it — no stray "pi-matrix-integration-thread-summarizer" sub-thread.
 *
 * This adapter is the test oracle: the existing fake-bus tests replay
 * against it unchanged (the refactor's correctness gate, G2).
 */

import type { AgentSpawnInput } from "../subagent-bus.js";
import {
  newRequestId,
  unref,
  type SubagentProvider,
  type SubagentProviderDeps,
  type SpawnWatch,
} from "../subagent-provider.js";

export function createTintinwebProvider(deps: SubagentProviderDeps): SubagentProvider {
  const { events, logger, agentType, model, pingTimeoutMs, runTimeoutMs, spawnTimeoutMs = 30_000 } = deps;

  async function isAvailable(): Promise<boolean> {
    const requestId = newRequestId();
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          unsub();
          resolve(v);
        }
      };
      const unsub = events.on(`subagents:rpc:ping:reply:${requestId}`, (data: unknown) => {
        const reply = (data ?? {}) as { success?: boolean };
        done(reply?.success === true);
      });
      unref(setTimeout(() => done(false), pingTimeoutMs));
      events.emit("subagents:rpc:ping", { requestId });
    });
  }

  async function runIsolated(prompt: string, description?: string): Promise<string | null> {
    if (!(await isAvailable())) return null;

    // 1) Spawn (isolated, tool-less) and wait for the id.
    const spawnReqId = newRequestId();
    const agentId = await new Promise<string | null>((resolve) => {
      let settled = false;
      const done = (id: string | null) => {
        if (!settled) {
          settled = true;
          unsub();
          resolve(id);
        }
      };
      const unsub = events.on(`subagents:rpc:spawn:reply:${spawnReqId}`, (data: unknown) => {
        const reply = (data ?? {}) as { success?: boolean; data?: { id?: string }; error?: string };
        if (reply?.success && reply.data?.id) done(reply.data.id);
        else {
          logger.warn(`[matrix] summarizer spawn failed: ${reply?.error ?? "no agent id"}`);
          done(null);
        }
      });
      unref(setTimeout(() => done(null), spawnTimeoutMs));
      events.emit("subagents:rpc:spawn", {
        requestId: spawnReqId,
        type: agentType,
        prompt,
        options: {
          description: description ?? "Matrix thread summary",
          // isolated → the child loads no extensions/skills/nested tools: no
          // stray thread root, no 2nd Matrix connection, no tools needed.
          isolated: true,
          ...(model !== undefined ? { model } : {}),
        },
      });
    });
    if (agentId === null) return null;

    // 2) Wait for the settled lifecycle event, matching by id.
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const cleanups: Array<() => void> = [];
      const unsub = (u: () => void) => cleanups.push(u);
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        cleanups.forEach((c) => c());
        resolve(value);
      };
      unsub(
        events.on("subagents:completed", (data: unknown) => {
          const payload = (data ?? {}) as { id?: string; result?: string };
          if (payload?.id !== agentId) return;
          const body = typeof payload.result === "string" ? payload.result.trim() : "";
          if (body) {
            // Suppress the completion notification: a synchronous consume inside
            // the completed handler is the clean path (configuration-and-room-behaviour.md / rpc.md).
            events.emit("subagents:rpc:consume", { requestId: newRequestId(), agentId });
            finish(body);
          } else {
            finish(null); // empty result → keep the last summary
          }
        }),
      );
      unsub(
        events.on("subagents:failed", (data: unknown) => {
          const payload = (data ?? {}) as { id?: string };
          if (payload?.id === agentId) {
            logger.warn("[matrix] summarizer subagent failed — keeping the last summary");
            finish(null);
          }
        }),
      );
      unref(setTimeout(() => finish(null), runTimeoutMs));
    });
  }

  // The core `Agent` / `SubagentWorkflow` tools of this dialect; input
  // passthrough made explicit (configuration-and-room-behaviour.md today reads
  // the tool input straight as AgentSpawnInput).
  const spawnWatch: SpawnWatch = {
    agentToolNames: ["Agent"],
    workflowToolNames: ["SubagentWorkflow"],
    normalizeAgent: (input) => ({ ...(input as AgentSpawnInput) }),
    normalizeWorkflow: (input) => ({
      name: typeof input.name === "string" && input.name ? input.name : "workflow",
      subagent_type: "workflow",
    }),
  };

  return { id: "tintinweb", isAvailable, runIsolated, spawnWatch };
}
