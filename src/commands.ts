/**
 * Pi Matrix Integration — /matrix-* commands + matrix_* tools
 *
 * Thin adapters over the MatrixIntegration composition root: each
 * handler is a config read + a stack call; the stack behavior (connect
 * sequences, switch orchestration, funnel legs) lives in the phase 3–5
 * modules (lifecycle / watchers / events / inbound / room-ux). The
 * registrations happen ONCE at extension load (the object-stable rebind
 * discipline — nothing re-registers on /matrix-switch); the handlers
 * read the CURRENT stack through the integration at call time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { localpartOf } from "./classify.js";
import { encryptionNotice } from "./encryption-status.js";
import { fmtDuration, ownerBus } from "./subagent-bus.js";
import type { MatrixIntegration } from "./integration.js";

/**
 * Register the /matrix-* commands (nine, + the pi-help /
 * matrix-summarize-thread alias pairs) and the three matrix_* tools as
 * thin adapters over the composition root. Called ONCE from the
 * extension entry point.
 */
export function registerCommands(pi: ExtensionAPI, integration: MatrixIntegration): void {
  // Most recent event ctx (footer updates for Matrix client events that
  // don't carry a ctx of their own).
  const trackCtx = (ctx: ExtensionContext) => integration.trackCtx(ctx);

  // Connect to Matrix
  pi.registerCommand("matrix-connect", {
    description: "Connect to Matrix room (optionally switching profile first: /matrix-connect <profile>)",
    handler: async (args, ctx) => {
      trackCtx(ctx);
      const profile = (args ?? "").trim();
      if (profile) {
        // /matrix-connect <profile> ≡ /matrix-switch <profile>
        await integration.switchProfile(profile, ctx);
        return;
      }
      await integration.stack.lifecycle.connectAndStart(ctx);
    },
  });

  // Re-login (configuration-and-room-behaviour.md): the full dialogue any
  // time — re-auth, switch account. Cancel writes nothing.
  pi.registerCommand("matrix-login", {
    description: "Log in to Matrix (new account or re-auth) and reconnect",
    handler: async (_args, ctx) => {
      if (integration.config.matrixLoginEnabled === false) {
        ctx.ui.notify("Login is disabled in config (piTerminalMatrixLogin.enabled)", "info");
        return;
      }
      trackCtx(ctx);
      const result = await integration.runLoginFlow(ctx);
      if (result.ok) {
        await integration.completeLogin(ctx);
        // The tour offer accepted (configuration-and-room-behaviour.md): run it after connect.
        if (result.tour) integration.runIntroductionTour();
      } else if (result.cancelled) {
        ctx.ui.notify("Login cancelled — no changes", "info");
      } else {
        ctx.ui.notify(result.error, "error");
      }
    },
  });

  // Onboarding tour (configuration-and-room-behaviour.md): one canned prompt via
  // the [Matrix] directive path, sourced from the /matrix-help text. The agent
  // posts the tour with its normal tools. Re-runnable for updates/reminders.
  pi.registerCommand("matrix-introduction-tour", {
    description: "Walk the room through an introduction tour of this integration",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      integration.runIntroductionTour();
    },
  });

  // Disconnect from Matrix
  pi.registerCommand("matrix-disconnect", {
    description: "Disconnect from Matrix room",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      const stack = integration.stack;
      stack.outbox.stopDelivery();
      await stack.outbox.disconnect();
      stack.messageHandler.cleanup();
      stack.lifecycle.setEnabled(false);
      ctx.ui.notify("Disconnected from Matrix", "info");
      stack.sessionIntegrator.updateFooterStatus(ctx);
    },
  });

  // Toggle Matrix integration
  pi.registerCommand("matrix-toggle", {
    description: "Toggle Matrix integration on/off",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      const stack = integration.stack;
      if (stack.lifecycle.isEnabled()) {
        stack.outbox.stopDelivery();
        await stack.outbox.disconnect();
        stack.messageHandler.cleanup();
        stack.lifecycle.setEnabled(false);
        ctx.ui.notify("Matrix integration disabled", "info");
      } else {
        const success = await stack.outbox.connect();
        if (success) {
          stack.outbox.startDelivery(stack.deliveryCallbacks);
          stack.lifecycle.setEnabled(true);
          ctx.ui.notify("Matrix integration enabled", "success");
        } else {
          ctx.ui.notify("Failed to enable Matrix integration (see /matrix-status)", "error");
        }
      }
      stack.sessionIntegrator.updateFooterStatus(ctx);
    },
  });

  // Show Matrix status
  pi.registerCommand("matrix-status", {
    description: "Show Matrix connection status",
    handler: async (_args, ctx) => {
      const stack = integration.stack;
      const status = stack.lifecycle.status();
      const lines = [
        "Matrix Integration Status:",
        `  Enabled: ${stack.lifecycle.isEnabled() ? "Yes" : "No"}`,
        `  Connected: ${status.connected ? "Yes" : "No"}${status.connecting ? " (connecting…)" : ""}`,
        `  Room: ${status.roomUri}`,
        `  User: ${status.userId}`,
      ];

      // Encryption truth (FINDING-012): the room's real m.room.encryption
      // state, read live from the transport — never the config flag.
      if (status.connected) {
        const enc = stack.outbox.isRoomEncrypted?.();
        lines.push(`  Encryption: ${enc === undefined ? "unknown (room not synced yet)" : encryptionNotice(enc)}`);
      }

      if (status.lastError) {
        lines.push(`  Last Error: ${status.lastError}`);
      }

      if (status.lastActivity) {
        lines.push(`  Last Activity: ${new Date(status.lastActivity).toLocaleString()}`);
      }

      // Thread block (threads-and-summaries.md): active root + ledger at a glance.
      if (stack.threadManager.enabled()) {
        const t = stack.threadManager.status();
        if (t.sessionState === "pending") {
          lines.push("  Thread: pending (root created with the first user message)");
        } else if (t.activeRoot) {
          const r = t.activeRoot;
          lines.push(
            `  Thread: ${r.eventId.slice(0, 14)}… · ${r.msgCount} msgs · ${r.openDecisions} open decision(s)` +
              (r.subThreads.length ? ` · ${r.subThreads.length} sub-thread(s)` : ""),
          );
        } else {
          lines.push("  Thread: off (flat mode)");
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Switch env / room / user profile at runtime .
  // No arg → interactive menu of the available profiles (pick one, Esc
  // cancels). With a profile name: load + validate in memory, rebuild the
  // whole stack against it, reconnect, and announce the switch into the
  // new room. Thread state is keyed per room in the state map, so a switch
  // preserves each room's threads. The command mutates nothing on disk;
  // profile files are the source of truth and env-var overrides (PI_MATRIX_*)
  // still win.
  pi.registerCommand("matrix-switch", {
    description: "Switch Matrix env/room/user profile at runtime (no arg → pick from menu)",
    handler: async (args, ctx) => {
      trackCtx(ctx);
      await integration.switchProfile((args ?? "").trim(), ctx);
    },
  });

  // Toggle thread routing on/off at runtime. Off → every send falls back to
  // the flat main conversation (canRoute() is false); on → routing resumes
  // to the session's existing thread root, if any. The footer's thread icon
  // carries the state: bright = on, faded (dim) = off.
  pi.registerCommand("matrix-thread-toggle", {
    description: "Toggle Matrix threading (footer thread icon: bright = on, faded = off)",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      const tm = integration.stack.threadManager;
      const next = !tm.enabled();
      tm.setEnabled(next);
      integration.stack.sessionIntegrator.updateFooterStatus(ctx);
      ctx.ui.notify(
        `Matrix threading ${next ? "ON" : "OFF"} — the footer ${tm.threadIcon()} is now ${next ? "bright" : "faded"}`,
        "info",
      );
    },
  });

  // Send message to Matrix
  pi.registerCommand("matrix-send", {
    description: "Send a message to the Matrix room",
    handler: async (args, ctx) => {
      trackCtx(ctx);
      const text = (args || "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /matrix-send <message>", "error");
        return;
      }

      const result = await integration.stack.messageHandler.post(text);
      if (result.success) {
        ctx.ui.notify(
          result.deduped
            ? "Deduped — an identical message already sent within the window"
            : "Message sent to Matrix",
          "success",
        );
      } else {
        ctx.ui.notify(`Failed to send message: ${result.error || "not connected"}`, "error");
      }
      integration.stack.sessionIntegrator.updateFooterStatus(ctx);
    },
  });

  // Get recent Matrix messages
  pi.registerCommand("matrix-messages", {
    description: "Show recent messages from the Matrix room",
    handler: async (args, ctx) => {
      const limit = Math.max(1, Math.min(100, parseInt(args, 10) || 10));
      const messages = await integration.stack.outbox.readMessages(limit);

      if (messages.length === 0) {
        ctx.ui.notify("No messages found (or not connected)", "info");
        return;
      }

      const lines = ["Recent Matrix Messages:", ""];
      for (const msg of messages) {
        const senderName = localpartOf(msg.sender);
        const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : "?";
        lines.push(`[${timestamp}] ${senderName}: ${msg.body}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Sub-agent spawns in this process (configuration-and-room-behaviour.md,
  // stretch): running + settled records from the owner bus.
  pi.registerCommand("matrix-subagents", {
    description: "List sub-agent spawns (running + settled) with type colors",
    handler: async (_args, ctx) => {
      const bus = ownerBus();
      if (!bus) {
        ctx.ui.notify("Matrix sub-agents: no owner connection (side-chain session or not connected)", "info");
        return;
      }
      const list = bus.list();
      if (list.length === 0) {
        ctx.ui.notify("Matrix sub-agents: none", "info");
        return;
      }
      const lines = list.slice(-15).map((r) => {
        const dur =
          r.status === "settled" && r.settleAt ? fmtDuration(r.settleAt - r.spawnAt) : "running";
        return `${r.depth === 2 ? "↳" : "⚡"} ${r.name} (${r.type}) — ${dur}` +
          (r.sessionId ? ` · ${r.sessionId.slice(0, 8)}` : "");
      });
      ctx.ui.notify(`Matrix sub-agents:\n${lines.join("\n")}`, "info");
    },
  });

  // Post an end-user guide of this integration into the room. Registered under
  // two names: `matrix-help` (the terminal-canonical name) and `pi-help` (the
  // room-facing name). Both share one handler, so either dispatches it.
  const matrixHelpCommand = {
    description: "Send a concise end-user guide of this integration to the room",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      await integration.stack.roomUx.postHelp();
      integration.stack.sessionIntegrator.updateFooterStatus(ctx);
    },
  };
  pi.registerCommand("matrix-help", matrixHelpCommand);
  pi.registerCommand("pi-help", matrixHelpCommand);

  // Thread-summary run on demand (threads-and-summaries.md) — alias pair, same handler.
  const matrixThreadSummarizeCommand = {
    description: "Run a thread-summary pass now: the agent rewrites the thread root summary",
    handler: async (_args, ctx) => {
      trackCtx(ctx);
      const ok = await integration.stack.threadManager.requestSummarizeNow();
      ctx.ui.notify(
        ok
          ? "Thread summary run requested — the thread root will be updated shortly."
          : "No active Matrix thread to summarize (connect with /matrix-connect first).",
        ok ? "info" : "error",
      );
    },
  };
  pi.registerCommand("matrix-thread-summarize", matrixThreadSummarizeCommand);
  pi.registerCommand("matrix-summarize-thread", matrixThreadSummarizeCommand);

  // ==========================================================================
  // Custom Tools
  // ==========================================================================

  // LLM-controlled thread summary (threads-and-summaries.md): every `threadSummaryEvery`
  // ledger sends, the extension injects a summarization directive into this
  // session; the agent rewrites the root summary (baseline + delta) and
  // posts it here. `/matrix-thread-summarize` (alias
  // `/matrix-summarize-thread`) runs a pass on demand.
  if (integration.config.threadSummaryByLlm) {
    pi.registerTool({
      name: "matrix_update_thread_summary",
      label: "Update Matrix Thread Summary",
      description:
        "Replace the active Matrix thread's root summary with a markdown body. " +
        "The extension prepends the '🧵 {topic}' line itself — pass the body only " +
        "(# Topic / ## Main discussion points / ## Main decisions sections). " +
        "Only available while a thread is active.",
      parameters: Type.Object({
        summary: Type.String({ description: "Markdown summary body for the thread root (no 🧵 line)" }),
      }),
      async execute(toolCallId, params) {
        if (!integration.stack.lifecycle.isEnabled()) {
          return {
            content: [{ type: "text", text: "Matrix not connected (use /matrix-connect first)" }],
            details: { success: false, error: "Matrix not connected" },
          };
        }
        const ok = await integration.stack.threadManager.updateSummary(params.summary);
        if (!ok) {
          return {
            content: [{ type: "text", text: "No active Matrix thread (or the edit failed — see log)" }],
            details: { success: false, error: "no active thread" },
          };
        }
        return {
          content: [{ type: "text", text: `Thread root updated: ${params.summary}` }],
          details: { success: true },
        };
      },
    });
  }

  // Send milestone to Matrix
  pi.registerTool({
    name: "matrix_send_milestone",
    label: "Send Milestone to Matrix",
    description: "Send a milestone or status update to the connected Matrix room",
    parameters: Type.Object({
      milestone: Type.String({ description: "Milestone text to send" }),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!integration.stack.lifecycle.isEnabled()) {
        return {
          content: [{ type: "text", text: "Matrix not connected (use /matrix-connect first)" }],
          details: { success: false, error: "Matrix not connected" },
        };
      }

      try {
        const result = await integration.stack.messageHandler.sendMilestone(params.milestone, params.details);
        if (!result.success) {
          return {
            content: [{ type: "text", text: `Failed to send to Matrix: ${result.error}` }],
            details: { success: false, error: result.error },
          };
        }
        return {
          content: [{ type: "text", text: `Milestone sent to Matrix: ${params.milestone}` }],
          details: { success: true, eventId: result.eventId },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to send milestone: ${error}` }],
          details: { success: false, error: String(error) },
        };
      }
    },
  });

  // Get Matrix messages
  pi.registerTool({
    name: "matrix_get_messages",
    label: "Get Matrix Messages",
    description: "Retrieve recent messages from the Matrix room",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ default: 10, description: "Number of messages to retrieve" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!integration.stack.lifecycle.isEnabled()) {
        return {
          content: [{ type: "text", text: "Matrix not connected (use /matrix-connect first)" }],
          details: { success: false, error: "Matrix not connected" },
        };
      }

      try {
        const messages = await integration.stack.outbox.readMessages(params.limit || 10);

        if (messages.length === 0) {
          return {
            content: [{ type: "text", text: "No messages found" }],
            details: { success: true, messages: [] },
          };
        }

        const formattedMessages = messages.map((msg) => {
          const senderName = localpartOf(msg.sender);
          const timestamp = msg.timestamp
            ? new Date(msg.timestamp).toLocaleString()
            : "unknown time";
          return `[${timestamp}] ${senderName}: ${msg.body}`;
        });

        return {
          content: [{ type: "text", text: formattedMessages.join("\n\n") }],
          details: { success: true, messages: formattedMessages },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to get messages: ${error}` }],
          details: { success: false, error: String(error) },
        };
      }
    },
  });
}
