/**
 * Pi Matrix Integration Extension
 *
 * Thin entry point: load config →
 * MatrixIntegration (the composition root) → attach(pi) (the one-time
 * pi-hook + client-event registrations) → registerCommands (the
 * /matrix-* commands + matrix_* tools as thin adapters).
 *
 * The object-stable rebind discipline:
 * /matrix-switch re-points the composition root's internals — never
 * the registrations. Nothing re-registers or deregisters.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMatrixLogger } from "./src/logger.js";
import { MatrixIntegration, PI_MATRIX_KEY, type MatrixGlobal, resolveStartupConfigWithMigration, createLoggerAndValidateConfig } from "./src/integration.js";
import { registerCommands } from "./src/commands.js";

// Owner-instance parking. Pi runs this function again for every session in
// the same process, including sub-agent (side-chain) sessions.
// If a new instance disposed the older instance's Matrix connection at load
// time, a sub-agent starting up would kill the main session's connection.
// So the older instance is parked and handed to the new one; the owner
// question is decided at session_start (claimOwner in
// src/integration.ts): main line → take over; side chain → stay a client.
export default function (pi: ExtensionAPI) {
  const g = globalThis as MatrixGlobal;
  // The previous instance parked by an earlier run of this function — the
  // sub-agent case above. Undefined on first load.
  const prev = g[PI_MATRIX_KEY] ?? undefined;
  g[PI_MATRIX_KEY] = undefined;

  // Thin IoC entry: delegate all config loading to integration.ts
  const configResult = resolveStartupConfigWithMigration();

  // Create logger (minimal setup before validation)
  const logger = createMatrixLogger(configResult.config.logPath || "", configResult.config.logLevel);

  // Validate config and handle error cases
  const validated = createLoggerAndValidateConfig(configResult, logger);
  if (!validated) {
    return; // Config validation failed, error already logged
  }

  // The Matrix stack (transport-and-state.md composition root): one object owns
  // the stack construction + the object-stable rebind — /matrix-switch
  // re-points its internals, never replaces the instance.
  const integration = new MatrixIntegration(pi, validated.config, validated.logger, prev);

  // Register the pi hooks + client-event handlers ONCE. Pi cannot undo half
  // of this: registered tools cannot be unregistered, and unsubscribing a
  // running event handler does not stop a dispatch already in progress. A
  // re-register per /matrix-switch would double-handle events; a swap of the
  // internals (this.stack) is one pointer assignment, so the handlers stay
  // wired and always see the current stack.
  integration.attach(pi);

  // The /matrix-* commands + matrix_* tools — thin adapters over the
  // composition root (transport-and-state.md).
  registerCommands(pi, integration);

  // Park the current instance so a later re-registration can take it over
  // — or, when the previous instance was the owner of a still-live main
  // session, keep THAT one parked (its session_start claim decides).
  g[PI_MATRIX_KEY] = prev ?? integration;

  // Log initialization (gated by displayStdoutOnStartup)
  if (configResult.config.displayStdoutOnStartup !== false) {
    console.log("Pi Matrix Integration extension loaded");
    console.log(
      `[matrix] room=${configResult.config.roomId} user=${configResult.config.userId}`,
    );
  }
}
