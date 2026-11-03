/**
 * Pi Matrix Integration - Session Integration
 *
 * Injects Matrix-origin messages into the Pi session. The footer status
 * slot is delegated to TuiFooter (src/tui-footer.ts).
 *
 * Injection model:
 * - Each Matrix message is delivered as a custom message
 *   (`pi.sendMessage({ customType: "matrix-message", ... })`) with full
 *   attribution in `details`. Custom messages participate in LLM context.
 * - `deliverAs: "followUp"` waits for the agent to finish its current
 *   work; `triggerTurn: true` starts an LLM turn when Pi is idle, so Pi
 *   reacts to the Matrix message like a user message.
 * - `registerMessageRenderer` gives these messages a styled, attributed
 *   rendering in the TUI (plain fallback text elsewhere).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { localpartOf } from "./classify.js";
import type { ConnectionStatus } from "./types.js";
import { createTuiFooter } from "./tui-footer.js";
import type { MatrixMessage, MatrixMessageDetails, PiMessage } from "./types.js";

/**
 * Session integrator for Matrix-Pi integration
 */
export class SessionIntegrator {
  private pi: ExtensionAPI;
  // The live connection snapshot (the Lifecycle-owned status — read at
  // footer-refresh time, so a reconnect/switch is reflected without
  // re-registering anything).
  private connectionStatus: () => ConnectionStatus;
  private config: {
    piTerminalMatrixMessagePrefix: string;
    showInFooter: boolean;
    footerIcon?: string;
    getThreadStatus?: () => { icon: string; enabled: boolean };
  };
  private footer: ReturnType<typeof createTuiFooter>;

  constructor(
    pi: ExtensionAPI,
    connectionStatus: () => ConnectionStatus,
    config: {
      piTerminalMatrixMessagePrefix?: string;
      showInFooter?: boolean;
      footerIcon?: string;
      getThreadStatus?: () => { icon: string; enabled: boolean };
      getRoomEncryption?: () => boolean | undefined;
    } = {}
  ) {
    this.pi = pi;
    this.connectionStatus = connectionStatus;
    this.config = {
      piTerminalMatrixMessagePrefix: config.piTerminalMatrixMessagePrefix || "[Matrix] ",
      showInFooter: config.showInFooter ?? true,
      getThreadStatus: config.getThreadStatus,
    };
    this.footer = createTuiFooter(config);
  }

  // ==========================================================================
  // Message Injection
  // ==========================================================================

  /**
   * Inject a Matrix message into the Pi session.
   *
   * The content is self-describing for the LLM:
   *   "[Matrix] vincent: yes"
   */
  injectMatrixMessage(matrixMessage: MatrixMessage, piMessage: PiMessage): void {
    const senderName = localpartOf(matrixMessage.sender);
    const content = `${this.config.piTerminalMatrixMessagePrefix}${senderName}: ${piMessage.content}`;

    const details: MatrixMessageDetails = {
      sender: matrixMessage.sender,
      senderName,
      eventId: matrixMessage.eventId,
      timestamp: matrixMessage.timestamp,
      roomId: matrixMessage.roomId,
      // Bookkeeping on the injected payload (threads-and-summaries.md): which
      // thread this message belongs to, kept with the message identity. No
      // routing effect, and nothing in this package reads it back — the thread
      // state map takes the root from the MatrixMessage, not from this copy.
      threadRoot: matrixMessage.threadRoot,
    };

    this.pi.sendMessage(
      {
        customType: "matrix-message",
        content,
        display: true,
        details,
      },
      { deliverAs: "followUp", triggerTurn: true }
    );
  }

  /**
   * Internal directive to the agent (e.g. a thread-summary run): no Matrix
   * chrome, hidden from the TUI (`display: false`), but it still
   * participates in LLM context and triggers a turn when Pi is idle.
   * `details` travels with the message as structured identity — the
   * thread-summary injections tag it `{ kind: "summarize" }` so
   * `isSummarizeDirectiveNotice` can mute its report-out without prose
   * matching (the 2026-10 summary-loop incident, Engine A).
   */
  injectDirective(content: string, details?: unknown): void {
    this.pi.sendMessage(
      {
        customType: "matrix-directive",
        content,
        display: false,
        details,
      },
      { deliverAs: "followUp", triggerTurn: true }
    );
  }

  /**
   * Quiet sibling of `injectDirective`: `triggerTurn: false` — never starts
   * a run when Pi is idle; absorbed into the live run exactly like the
   * notice it annotates (the 2026-10 summary loop, leak variant "wake
   * lands mid-turn"). Lifecycle calls this right after classifying an
   * absorbed summarizer wake, so the instruction rides the same context
   * that already carries the notice's content.
   */
  injectQuietDirective(content: string, details?: unknown): void {
    this.pi.sendMessage(
      {
        customType: "matrix-directive",
        content,
        display: false,
        details,
      },
      { deliverAs: "followUp", triggerTurn: false }
    );
  }

  // ==========================================================================
  // Footer Status Management (delegated to TuiFooter — src/tui-footer.ts)
  // ==========================================================================

  /**
   * Update footer status
   */
  updateFooterStatus(ctx: ExtensionContext): void {
    this.footer.update(ctx, this.connectionStatus());
  }

  /**
   * Clear the footer status slot
   */
  clearFooterStatus(ctx: ExtensionContext): void {
    this.footer.clear(ctx);
  }

  // ==========================================================================
  // Custom Renderers
  // ==========================================================================

  /**
   * Register the TUI renderer for injected `matrix-message` custom messages.
   * Must be registered during extension load (or any time before rendering).
   */
  registerMatrixMessageRenderer(pi: ExtensionAPI): void {
    pi.registerMessageRenderer<MatrixMessageDetails>("matrix-message", (message, { expanded }, theme) => {
      const data = message.details;
      const senderName = data?.senderName || localpartOf(data?.sender ?? "unknown");
      const header = `${this.config.piTerminalMatrixMessagePrefix}${senderName}:`;
      const rawContent = String(message.content ?? "");

      // The content carries the same prefix; strip it so the header is drawn
      // once, colored.
      const body = rawContent.startsWith(`${header} `)
        ? rawContent.slice(header.length + 1)
        : rawContent;

      const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
      box.addChild(new Text(`${theme.fg("accent", header)} ${body}`, 0, 0));

      if (expanded && data) {
        const when = new Date(data.timestamp ?? Date.now()).toLocaleString();
        const detailText = [
          data.eventId ? `event ${data.eventId}` : undefined,
          when,
          data.roomId ? `room ${data.roomId}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        if (detailText) {
          box.addChild(new Text(theme.fg("dim", detailText), 0, 0));
        }
      }

      return box;
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Nothing to release: state lives in the outbox + MessageHandler
  }
}

/**
 * Create session integrator
 */
export function createSessionIntegrator(
  pi: ExtensionAPI,
  connectionStatus: () => ConnectionStatus,
  config: {
    piTerminalMatrixMessagePrefix?: string;
    showInFooter?: boolean;
    footerIcon?: string;
    getThreadStatus?: () => { icon: string; enabled: boolean };
    getRoomEncryption?: () => boolean | undefined;
  } = {}
): SessionIntegrator {
  return new SessionIntegrator(pi, connectionStatus, config);
}
