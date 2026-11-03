/**
 * Pi Matrix Integration Extension
 *
 * Thin entry point (TO-BE restructure, Slice 5): load config →
 * MatrixIntegration (the composition root) → attach(pi) (the one-time
 * pi-hook + client-event registrations) → registerCommands (the
 * /matrix-* commands + matrix_* tools as thin adapters).
 *
 * The object-stable rebind discipline (DESIGN-ROOM-THREADING §2.9):
 * /matrix-switch re-points the composition root's internals — never
 * the registrations. Nothing re-registers or deregisters.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMatrixLogger } from "./src/logger.js";
import { MatrixIntegration, PI_MATRIX_KEY, type MatrixGlobal, resolveStartupConfigWithMigration, createLoggerAndValidateConfig } from "./src/integration.js";
import { registerCommands } from "./src/commands.js";

// The tail helpers moved to src/classify.ts (TO-BE Slice 1); the export
// stays here for API parity with the pre-restructure index.ts (no live
// test consumer — the logic tests never imported it; reviewer row S2).
export { truncateFinalMessage } from "./src/classify.js";

// The owner-instance parking (DESIGN-SUBAGENT-TRACKING §4.1): the previous
// instance is handed to the new one at session_start (main line → take
// over; side chain → stay client) instead of disposed up front — a
// side-chain (sub-agent) session must never tear down the main session's
// Matrix connection. PI_MATRIX_KEY / MatrixGlobal live in integration.ts.

export default function (pi: ExtensionAPI) {
  const g = globalThis as MatrixGlobal;
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

  // The Matrix stack (TO-BE composition root, Slice 5): one object owns
  // the stack construction + the object-stable rebind — /matrix-switch
  // re-points its internals, never replaces the instance.
  const integration = new MatrixIntegration(pi, validated.config, validated.logger, prev);

  // The one-time registrations (the object-stable rebind discipline):
  // the pi hooks + the client-event handlers dispatch through the
  // CURRENT stack at call time — nothing re-registers on /matrix-switch.
  integration.attach(pi);

  // The /matrix-* commands + matrix_* tools — thin adapters over the
  // composition root (TO-BE Slice 5).
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
