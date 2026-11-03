/**
 * Pi Matrix Integration — composition root.
 *
 * The object-stable composition root (threads-and-summaries.md,
 * transport-and-state.md): the single object the one-time pi-hook registrations in
 * index.ts dispatch through. `reattach(cfg)` re-points the stack
 * internals — it never replaces the instance — so /matrix-switch
 * rebinds the registrations without re-registering (the object-stable
 * rebind discipline: nothing re-registers or deregisters; the
 * registrations read the CURRENT stack at call time).
 *
 * Owns:
 * - `buildStack` (the stack construction — the index.ts buildStack
 *   verbatim, with the stack hunks applied: threadSend delegate,
 *   pipeline outbox, lifecycle/watchers/events, roomUx/inbound).
 * - The factory-scope `PickerState` (the zero-delta move of the two
 *   original factory-scope CandidateListTracker instances — created
 *   ONCE per integration, survives /matrix-switch as they did).
 * - The footer ctx tracker (lastCtx + updateFooter).
 * - The /matrix-switch orchestration (config persistence + reattach +
 *   reconnect).
 *
 * Test seam (transport-and-state.md, "Test seam: PI_MATRIX_TEST_OUTBOX"
 * decision): when `PI_MATRIX_TEST_OUTBOX` is set to a module path, the
 * outbox is built by that module's `createTestOutbox(cfg)` factory
 * instead of `createSdkOutbox`. The fake writes state-file call logs
 * (the fake-mtx precedent, test/fake-mtx.js:92–112) so spawned-suite
 * assertions read the logs without shared-process assumptions.
 * Call-time `process.env` read (the idb-file-store.ts:173 idiom); the
 * fake is a plain .mjs/.cjs module loaded through the native `require`
 * (no jiti transform), which keeps the seam synchronous inside the
 * synchronous extension factory.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getStateDir,
  getActiveConfigDir,
  getActiveProfileName,
  getConfigDir,
  loadConfig,
  loadProfile,
  listProfiles,
  persistActiveProfile,
  resolveConfigPath,
  saveConfig,
} from "./config-utils.js";
import {
  getCredentialsPath,
  getEffectiveConfig,
  migrateV1toV2,
  seedProfileDefaults,
  convertAllConfigs,
  ensureProjectConfig,
  createDefaultConfig,
  resolveStartupConfig,
} from "./config.js";
import { localpartOf, SUMMARIZER_AGENT_TYPE } from "./classify.js";
import {
  buildLoginUi,
  hasLoadableCredentials,
  runLoginDialogue,
  buildTourPrompt,
  homeserverDomain,
  type LoginResult,
} from "./login.js";
import { buildMatrixHelp } from "./matrix-help.js";
import { createSdkOutbox, type SdkOutbox, type SdkDeliveryCallbacks } from "./sdk-client.js";
import { UnreadModel } from "./unread-model.js";
import {
  createThreadManager,
  type ThreadManager,
  type ThreadRootState,
} from "./threading.js";
import { createSubagentSummarizer } from "./subagent-summarizer.js";
import { resolveSubagentProvider } from "./subagent-providers/resolve.js";
import { createSummarizeDispatcher, type SummarizeRoot } from "./summarize-dispatch.js";
import { filterThreadDelta, type ThreadDeltaMessage } from "./summarize.js";
import { createMessageHandler, type MessageHandler } from "./message-handler.js";
import { createSessionIntegrator, type SessionIntegrator } from "./session-integration.js";
import {
  createAskUserMirror,
  type AskUserMirror,
  type MirrorQuestion,
} from "./ask-user-mirror.js";
import { createLifecycle, isSidechainSession, type Lifecycle } from "./lifecycle.js";
import { createEventDispatcher, type EventDispatcher } from "./events.js";
import { createToolWatchers, type CoreAgentDelegate, type ToolWatchers } from "./watchers.js";
import {
  clearOwnerBus,
  createSubagentBus,
  ownerBus,
  publishOwnerBus,
  type SubagentBusImpl,
} from "./subagent-bus.js";
import { createInbound, type Inbound } from "./inbound.js";
import { createVoiceTranscriber, type VoiceTranscriber } from "./voice.js";
import { createRoomUx, type RoomUx } from "./room-ux.js";
import { PickerState } from "./file-attach.js";
import type { MatrixConfig, PartialMatrixConfig } from "./types.js";
import type { MatrixLogger } from "./logger.js";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

/**
 * The stack: client + handler + integrator +
 * thread manager + funnel, built as a unit and re-pointed together by
 * /matrix-switch. `config` tracks the active profile (commands read it
 * at call time).
 */
export interface MatrixStack {
  outbox: SdkOutbox;
  /** D1 unread model (was owned by the deleted facade) — per-env path.
   *  Ephemeral by design — no state/ persistence beyond its own
   *  `unread-<env>.json` load/save (7fc13e1 check). */
  unreadModel: UnreadModel;
  unreadPath: string;
  /** The delivery-callback bundle (the outbox's read-side legs +
   *  unread bump + sync-error feed). Ephemeral by design — no state/
   *  persistence (7fc13e1 check). */
  deliveryCallbacks: SdkDeliveryCallbacks;
  messageHandler: MessageHandler;
  sessionIntegrator: SessionIntegrator;
  threadManager: ThreadManager;
  askUserMirror: AskUserMirror;
  events: EventDispatcher;
  lifecycle: Lifecycle;
  watchers: ToolWatchers;
  roomUx: RoomUx;
  inbound: Inbound;
  /** The active profile's config (the switch re-pointing, read at call time). */
  config: MatrixConfig;
  /** The sub-agent bus generation. */
  subagentBus: SubagentBusImpl;
  /** Teardown of the provider completion-channel subscription. */
  unsubCompletion?: () => void;
}

/** The globalThis parking key: the owner instance of this process. */
export const PI_MATRIX_KEY = Symbol.for("pi-matrix.integration");
export type MatrixGlobal = typeof globalThis & { [PI_MATRIX_KEY]?: MatrixIntegration };

// =============================================================================
// Startup Config Resolution (moved from index.ts for thin IoC entry)
// =============================================================================

/**
 * Startup config resolution result - moved from index.ts to centralize config logic.
 */
export interface StartupConfigResult {
  config: MatrixConfig;
  valid: boolean;
  errors: string[];
  profile: string | undefined;
}

/**
 * Resolve startup configuration with v1->v2 migration support.
 * Moved from index.ts to make it a centralized config service.
 */
export function resolveStartupConfigWithMigration(): StartupConfigResult {
  // Convert all v1 .json configs to v2 .jsonc (one-time, idempotent)
  // Skipped under the hermetic test seam (PI_MATRIX_TEST) — see _harness.mjs.
  if (!process.env.PI_MATRIX_TEST) {
    const converted = convertAllConfigs();
    if (converted > 0) {
      console.log(`[matrix] converted ${converted} config file(s) to v2`);
    }
    
    const createdProject = ensureProjectConfig();
    if (createdProject) {
      console.log(`[matrix] created project config ${createdProject}`);
    }
  }

  return resolveStartupConfig();
}

/**
 * Create logger and validate config, handling error cases.
 * Moved from index.ts to centralize startup logic.
 */
export function createLoggerAndValidateConfig(
  configResult: StartupConfigResult,
  logger: MatrixLogger,
): { logger: MatrixLogger; config: MatrixConfig } | null {
  // A config that FAILS validation can be two different states. With no
  // loadable credentials it is the onboarding state (fresh project / first
  // login): the config is complete except the not-yet-provisioned account,
  // so load anyway — /matrix-login + the first-run gate (lifecycle.onFirstRun)
  // provision the account before any connect. With LOADABLE credentials but
  // still invalid (identity mismatch, bad roomId, ...) it is a real misconfig:
  // bail as before so the user sees the error and fixes it.
  if (!configResult.valid) {
    if (hasLoadableCredentials(getCredentialsPath(configResult.config))) {
      console.warn("[matrix] Invalid configuration:", configResult.errors);
      // Create the default config file only when missing (never clobber a
      // user-edited file); the user fixes it and re-runs / or reloads.
      const created = createDefaultConfig();
      if (created) {
        console.warn(`[matrix] Wrote default config to ${created} — review it, then restart or /reload Pi`);
      }
      return null;
    }
    console.log("[matrix] no credentials yet — starting for /matrix-login (first run)");
  }

  if (configResult.profile) {
    console.log(`[matrix] restored active profile ${configResult.profile}`);
  }

  return { logger, config: configResult.config };
}

export class MatrixIntegration {
  private readonly pi: ExtensionAPI;
  private readonly logger: MatrixLogger;
  /** The factory-scope picker state: created ONCE per
   *  integration, survives /matrix-switch (the zero-delta move of the
   *  two original factory-scope CandidateListTracker instances,
   *  `index.ts:321/:324`). Ephemeral by design — no state/ persistence
   *  (7fc13e1 check): the posted-list ledger lives in memory per
   *  integration. */
  private readonly pickerState = new PickerState();
  /** Most recent event ctx — footer updates for Matrix client events
   *  that don't carry a ctx of their own. Stale after session
   *  replacement; guarded at each use. */
  private lastCtx: ExtensionContext | undefined;
  /** This session's current model / thinking level, tracked from
   *  `model_select` / `thinking_level_select` (configuration-and-room-behaviour.md
   *  transport-and-state.md, explicit meta): sub-agent spawn lines show the session's actual
   *  model instead of the `(session model)` placeholder. */
  private sessionModel: string | undefined;
  private sessionThinking: string | undefined;
  /** The stack (re-pointed as a unit by reattach — object-stable). */
  stack: MatrixStack;
  /** The previous owner parked by the factory (configuration-and-room-behaviour.md
   *  transport-and-state.md): disposed + replaced by this instance at session_start when this
   *  session is the MAIN line; released (the owner stays) when it is a
   *  side chain. */
  private prev: MatrixIntegration | undefined;

  constructor(
    pi: ExtensionAPI,
    config: MatrixConfig,
    logger: MatrixLogger,
    prev?: MatrixIntegration,
  ) {
    this.pi = pi;
    this.logger = logger;
    this.prev = prev;
    this.stack = this.buildStack(config);
  }

  /**
   * The owner decision at session_start:
   * side-chain sessions never dispose the owner (one connection per
   * process); the main line disposes the parked previous owner and claims
   * the pointer.
   */
  claimOwner(isSidechain: boolean): void {
    if (isSidechain) {
      this.prev = undefined; // the owner stays parked on globalThis
      return; // and never publishes: this stack's bus must not shadow the owner's registry
    }
    if (this.prev) {
      try {
        this.prev.dispose();
      } catch (error) {
        this.logger.warn(`[matrix] previous integration dispose failed: ${error}`);
      }
      this.prev = undefined;
    }
    (globalThis as MatrixGlobal)[PI_MATRIX_KEY] = this;
    // The owner's sub-agent registry is the process registry: side-chain
    // instances built their stack in the constructor but never claim, so
    // only the main line publishes.
    publishOwnerBus(this.stack.subagentBus);
  }

  /** The active profile's config (read at call time by the commands). */
  get config(): MatrixConfig {
    return this.stack.config;
  }

  /** Track the most recent event ctx (command handlers call this first
   *  so the footer refresh has a ctx). */
  trackCtx(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
  }

  /**
   * The one-time registrations (the object-stable rebind discipline):
   * every pi hook + client-event registration lives here, ONCE. They
   * dispatch through the CURRENT stack at call time — nothing
   * re-registers or deregisters on /matrix-switch.
   */
  attach(pi: ExtensionAPI): void {
    // RPIV ask-user mirror (dual-surface decision bridge, emit side):
    // subscribe once — the handlers read the CURRENT stack at call time,
    // so /matrix-switch rebinds the mirror without re-subscribing.
    // @juicesharp/rpiv-ask-user-question (>= 2.13, native answer channel)
    // emits on this same shared bus.
    pi.events.on("rpiv:ask-user:prompt", (data: unknown) => {
      const payload = (data ?? {}) as { questions?: unknown; toolCallId?: unknown };
      const qs = payload.questions;
      if (Array.isArray(qs)) {
        void this.stack.askUserMirror.onPrompt(
          qs as MirrorQuestion[],
          typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
        );
      }
    });
    pi.events.on("rpiv:ask-user:answer-result", (data: unknown) => {
      const v = (data ?? {}) as { ok?: unknown; code?: unknown; reason?: unknown; requestId?: unknown };
      this.stack.askUserMirror.onAnswerResult({
        ok: v.ok === true,
        ...(typeof v.code === "string" ? { code: v.code } : {}),
        ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
        ...(typeof v.requestId === "string" ? { requestId: v.requestId } : {}),
      });
    });
    pi.events.on("rpiv:ask-user:answers-state", (data: unknown) => {
      this.stack.askUserMirror.onAnswersState((data ?? {}) as import("./ask-user-mirror.js").MirrorAnswersStatePayload);
    });
    pi.events.on("rpiv:ask-user:blocked", (data: unknown) => {
      if ((data as { active?: boolean } | null | undefined)?.active === false) {
        this.stack.events.emit({ type: "decision-closed", source: "rpiv" });
      }
    });

    // Session lifecycle — the hook BODIES live in Lifecycle
    // (transport-and-state.md); the registrations stay here once (dispatch through the
    // current stack at call time — nothing re-registers on
    // /matrix-switch).
    pi.on("session_start", async (event, ctx) => {
      this.trackCtx(ctx);
      // Owner decision BEFORE the lifecycle hook (configuration-and-room-behaviour.md
      // transport-and-state.md): a side-chain session must never dispose the owner's
      // connection; the main line takes over the parked previous instance.
      this.claimOwner(isSidechainSession(ctx.sessionManager, event.reason));
      // Baseline session meta: pi emits
      // model_select only on CHANGES (not on session start/restore), so
      // seed the spawn-line meta from the live session here — the model
      // and thinking level ride on `ctx` as plain properties.
      const baseModel = ctx.model as
        | { provider?: string; id?: string; name?: string }
        | undefined;
      if (baseModel) {
        this.sessionModel = `${baseModel.provider ?? "?"}/${baseModel.name ?? baseModel.id ?? "?"}`;
      }
      try {
        this.sessionThinking = ctx.thinkingLevel ?? this.pi.getThinkingLevel?.() ?? undefined;
      } catch {
        /* older pi: the placeholder stays */
      }
      await this.stack.lifecycle.onSessionStart(event, ctx);
    });
    pi.on("session_shutdown", (event) => {
      this.stack.lifecycle.onSessionShutdown(event);
    });
    pi.on("session_compact", async (event) => {
      await this.stack.lifecycle.onSessionCompact(event);
    });
    pi.on("session_compact_failed", async (event) => {
      await this.stack.lifecycle.onSessionCompactFailed(event);
    });
    // Baseline session meta: pi emits
    // model_select only on CHANGES, so the seed happens in session_start
    // (ctx.getModel()) below; this handler keeps it current afterwards.
    pi.on("model_select", async (event) => {
      // Explicit meta: the spawn line of the
      // next sub-agent shows the session's current model.
      const fmtModel = (m?: { provider?: string; id?: string; name?: string }) =>
        m ? `${m.provider ?? "?"}/${m.name ?? m.id ?? "?"}` : undefined;
      this.sessionModel = fmtModel(event.model);
      await this.stack.lifecycle.onModelSelect(event);
    });
    pi.on("thinking_level_select", async (event) => {
      this.sessionThinking = event.level;
      await this.stack.lifecycle.onThinkingLevelSelect(event);
    });
    pi.on("message_end", async (event) => {
      await this.stack.lifecycle.onMessageEnd(event);
    });
    // Summarizer-wake loop guard (the 2026-10 summary-loop incident): flag a
    // run started by a summarizer completion notice so its report-out stays
    // out of the room.
    pi.on("before_agent_start", (event) => {
      this.stack.lifecycle.onBeforeAgentStart(event);
    });
    pi.on("turn_end", async (event) => {
      await this.stack.lifecycle.onTurnEnd(event);
    });
    pi.on("input", async (event) => {
      await this.stack.lifecycle.onInput(event);
    });
    // Sub-agent settle (configuration-and-room-behaviour.md transport-and-state.md Q4): the side-chain
    // session's own agent_settled is the single settle source. No-op for
    // the main session (not side-chain mode).
    pi.on("agent_settled", () => {
      this.stack.lifecycle.onAgentSettled();
    });

    // Sub-agent sub-threads — the marker bodies live in ToolWatchers
    // (transport-and-state.md); the registrations dispatch through the CURRENT
    // watcher at call time.
    pi.on("tool_call", (event) => {
      void this.stack.watchers.onToolCall(event);
    });
    pi.on("tool_result", (event) => {
      void this.stack.watchers.onToolResult(event);
    });

    // Matrix room-event delivery (transport-and-state.md): the outbox delivery
    // loop — startDelivery ONCE with the first stack's callbacks
    // bundle (the post-switch rebind lands via reattach →
    // connectAndStart, which startDelivers the CURRENT stack's bundle).
    // The footer's former onConnectionChange leg is gone: the footer
    // reads the live snapshot via the session-integration provider on
    // each session hook.
    this.stack.outbox.startDelivery(this.stack.deliveryCallbacks);

    // Styled, attributed rendering for injected Matrix messages.
    this.stack.sessionIntegrator.registerMatrixMessageRenderer(pi);
  }

  /**
   * Tear this integration down (orphan cleanup on re-registration, e.g.
   * /reload). The factory re-runs and builds a fresh outbox; the previous
   * one must be stopped or it stays an orphan — its Matrix client keeps
   * running and holds the account lock, so the new outbox yields with
   * "Failed to connect to Matrix". Stopping the outbox first also keeps the
   * E2EE invariant (never two Olm accounts on one device at once).
   */
  dispose(): void {
    const out = this.stack.outbox;
    out.stopDelivery();
    void out.disconnect();
    this.stack.messageHandler.cleanup();
    this.stack.threadManager.cleanup();
    this.stack.unsubCompletion?.();
    // Sub-agent bus: retire this owner generation (side-chain instances
    // see a dead bus and no-op — the stale-owner guard).
    const bus = this.stack.subagentBus;
    bus.alive = false;
    if (ownerBus() === bus) clearOwnerBus();
  }

  /**
   * Rebuild the stack against a new config (transport-and-state.md): the handlers
   * keep working because the same integration object is re-pointed
   * (the object-stable rebind), and the old client is torn down before
   * the new one connects. A connect failure keeps the failure surface
   * as today (lastError + footer), never a dead extension.
   */
  async reattach(cfg: MatrixConfig, sessionId?: string): Promise<void> {
    const oldHandler = this.stack.messageHandler;
    const oldThreads = this.stack.threadManager;
    const oldOutbox = this.stack.outbox;
    // Teardown BEFORE rebuild (matching the doc: "the old client is torn
    // down before the new one connects"): stopDelivery → disconnect — the
    // old client stops and RELEASES the account lock before the new stack
    // is built and pointed at. This closes the window where a new SdkOutbox
    // could connect against a lock the old one still held (same pid → the
    // misleading "another live pi session" error). NO unread save point (the
    // f84c4b8 no-delta rule — the facade saved unread only inside its poll
    // rounds, never on disconnect).
    oldOutbox.stopDelivery();
    await oldOutbox.disconnect();
    oldHandler.cleanup();
    oldThreads.cleanup();
    this.stack.unsubCompletion?.();
    // NOW build the new stack against the new config (lock already free).
    this.stack = this.buildStack(cfg);
    // reattach is the main-line path only (/matrix-switch): the rebuilt
    // bus takes over the process registry.
    publishOwnerBus(this.stack.subagentBus);
    // Re-issue beginSession against the rebuilt thread manager (threads-and-summaries.md):
    // the new ThreadManager starts "flat" (constructor default) and only
    // session_start re-primed it — so a switch would park the whole
    // session flat until a pi restart. "resume": re-attach to this
    // session's root if it was previously in this room, else pending →
    // the first user message opens a fresh thread root in the new room.
    this.stack.threadManager.beginSession("resume", sessionId);
  }

  /**
   * First-run gate (configuration-and-room-behaviour.md transport-and-state.md): no loadable
   * credentials → run the login dialogue; success → `completeLogin`
   * (reload + reattach + connect) and true (the caller skips its own
   * connect). Cancel/decline → false (today's warn-and-degrade stands).
   */
  private async onFirstRunLogin(
    ctx: ExtensionContext,
    milestone?: { text: string; flat?: boolean },
  ): Promise<boolean> {
    if (hasLoadableCredentials(getCredentialsPath(this.config))) return false;
    
    // First-run project connection prompt: ask if user wants
    // to connect this project to a Matrix room, controlled by promptConnectOnStartup.
    if (this.config.promptConnectOnStartup !== false) {
      const answer = await ctx.ui.select(
        "Do you want to connect this project to a Matrix room?",
        ["yes", "no (skip for later)"]
      );
      if (answer === "no (skip for later)" || answer == null) {
        // User declined or cancelled - skip login for now
        return false;
      }
    }
    
    const result = await this.runLoginFlow(ctx);
    if (!result.ok) return false;
    await this.completeLogin(ctx, milestone);
    // The tour offer accepted (transport-and-state.md): run it after connect.
    if (result.tour) this.runIntroductionTour();
    return true;
  }

  /**
   * The onboarding tour (transport-and-state.md): inject the one canned prompt through
   * the [Matrix] directive path, sourced from the /matrix-help text (the
   * same content the room sees from /matrix-help). Re-runnable — the
   * command and the post-login offer both call this. The agent posts the
   * tour with its normal tools; no new content store, no new channel.
   */
  runIntroductionTour(): void {
    this.stack.sessionIntegrator.injectDirective(buildTourPrompt(buildMatrixHelp(this.config)));
  }

  /**
   * The login dialogue body: shared by the first-run trigger and
   * `/matrix-login` . Pure flow — the caller
   * decides what a success means for the connection (`completeLogin`).
   */
  async runLoginFlow(ctx: ExtensionContext): Promise<LoginResult> {
    const cfg = this.config;
    // The credentials store the dialogue writes to: the accounts dir of
    // the CURRENT credentialsPath (transport-and-state.md — the file is the SSoT, so
    // the next login lands next to the account dir it replaces).
    const cp = join(getCredentialsPath(cfg));
    const accountParent = dirname(cp);
    const credsDir = basename(dirname(accountParent)) === "accounts" ? dirname(accountParent) : accountParent;
    return runLoginDialogue({
      ui: buildLoginUi(ctx.ui),
      credsDir,
      updateConfig: (patch) => {
        // A login creates a NEW profile named after the account
        // (<localpart>--<domain> — the credentials account-dir leaf, which
        // saveCredentials already derived from user_id) and makes it the
        // active profile. Writing in-place to the bare config is what made
        // login non-profile-aware; per-account profiles isolate each login.
        // On account switch: drop the stale identity so the profile re-derives it
        // from the NEW credentials file (baking the old owner = the
        // two-sender identity bug: wrong footer + undecryptable E2EE).
        const credPath = typeof patch.credentialsPath === "string" ? patch.credentialsPath : "";
        const profileName = credPath ? basename(dirname(credPath)) : undefined;
        const current: PartialMatrixConfig = { ...getEffectiveConfig() };
        delete current.userId;
        delete current.homeserver;
        const next = { ...current, ...patch } as MatrixConfig;
        // Write the v2 shape. saveConfig only names the file `.jsonc` when the
        // object carries configVersion, and a flat profile never becomes v2 on
        // its own: convertAllConfigs only reads `.json` files, and it skips a
        // directory that already holds a `.json.bak` (the rollback guard) —
        // which is every project dir that converted once. Left flat, the file
        // also stays behind when a later login re-points the profile, so a
        // second account keeps loading the first account's room and toggles.
        // migrateV1toV2 drops userId/homeserver as undefined, so the identity
        // still derives from the new credentials file.
        const v2 = migrateV1toV2(next) as unknown as MatrixConfig;
        if (profileName) {
          saveConfig(
            v2,
            join(getActiveConfigDir() ?? getConfigDir(), `matrix-config.${profileName}.json`),
          );
          persistActiveProfile(profileName);
        } else {
          saveConfig(v2, resolveConfigPath() ?? join(getConfigDir(), "matrix-config.json"));
        }
      },
      homeserverPrefill: cfg.homeserver,
      usernamePrefill: localpartOf(cfg.userId ?? ""),
      makeLoginClient: (homeserver) => this.makeJsSdkLoginClient(homeserver),
      // QR path: the room step runs against the DAG token the flow returned
      // (its login happened on a separate client inside src/qr2025).
      makeLoginClientWithToken: (homeserver, token) => this.makeJsSdkLoginClient(homeserver, token),
      // issue 3 (transport-and-state.md): the room step's proposal + e2ee toggle.
      configuredRoomId: cfg.roomId,
      e2ee: cfg.e2ee,
      // QR method (2025 variant, transport-and-state.md): the toggle only — the probe
      // re-checks the server flag + the crypto bindings at login time.
      qr2025: cfg.qr2025,
      stateDir: getStateDir(),
      // Manifest directory for project room manifest 
      manifestDir: getStateDir(),
      // Current working directory for .gitignore handling 
      cwd: process.cwd(),
    });
  }

  /**
   * After a successful login: re-read the config (credentialsPath now
   * points at the new file — the identity re-derives from it), rebuild
   * the stack against it, and connect through the normal seam.
   */
  async completeLogin(
    ctx: ExtensionContext,
    milestone?: { text: string; flat?: boolean },
  ): Promise<void> {
    // Reattach from the profile the login just created + activated (the
    // last-active-profile pointer), not the bare config — otherwise the new
    // profile is written but never used (login stays on the old/bare config).
    const name = getActiveProfileName();
    const res = name ? loadProfile(name) : null;
    const cfg = res?.valid ? res.config : getEffectiveConfig();
    await this.reattach(cfg, ctx.sessionManager?.getSessionId?.());
    await this.stack.lifecycle.connectAndStart(ctx, milestone);
  }

  /**
   * The js-sdk login + room surface (transport-and-state.md): a bare MatrixClient
   * against the homeserver. The SDK imports lazily (same discipline as
   * sdk-client's loadSdk) and each attempt gets a throwaway client —
   * only the response fields reach saveCredentials. Room ops
   * (`resolveRoomAlias`/`createRoom`/`setRoomAlias`) run against the
   * fresh token after a successful login.
   */
  private makeJsSdkLoginClient(homeserver: string, token?: string) {
    const hs = homeserver.replace(/\/+$/, "");
    // One client for the whole dialogue: login sets its token, then the
    // room step reuses the same authenticated client. (The js-sdk client
    // type is imported lazily; `any` keeps the seam free of a hard type
    // dependency — jiti strips types at runtime.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;
    const sdkClient = async () => {
      if (!client) {
        const sdk = await import("matrix-js-sdk");
        client = token
          ? new sdk.MatrixClient({ baseUrl: hs, accessToken: token })
          : new sdk.MatrixClient({ baseUrl: hs });
      }
      return client;
    };
    return {
      loginWithPassword: async (user: string, password: string): Promise<unknown> => {
        const c = await sdkClient();
        return c.login("m.login.password", {
          identifier: { type: "m.id.user", user },
          password,
        });
      },
      // transport-and-state.md step 2: resolve the alias (404 when absent).
      resolveRoomAlias: async (alias: string): Promise<{ room_id: string }> => {
        const c = await sdkClient();
        return c.getRoomIdForAlias(alias);
      },
      // transport-and-state.md step 3: create the room (encrypted per e2ee), invite empty.
      // ponytail: no preset/visibility/topic wiring at creation (transport-and-state.md
      // note) — the ThreadManager takes over from the normal connect. The
      // encryption initial_state is the only extra, and only when e2ee is on.
      createRoom: async (opts: { name: string; invite: string[]; isEncrypted: boolean }): Promise<{ room_id: string }> => {
        const c = await sdkClient();
        const body: Record<string, unknown> = { name: opts.name, invite: opts.invite };
        if (opts.isEncrypted) {
          body.initial_state = [
            { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
          ];
        }
        return c.createRoom(body);
      },
      // claim the alias for the created room.
      setRoomAlias: async (roomId: string, alias: string): Promise<void> => {
        const c = await sdkClient();
        await c.createAlias(alias, roomId);
      },
      // invite users to the room 
      invite: async (roomId: string, userId: string): Promise<void> => {
        const c = await sdkClient();
        await c.invite(roomId, userId);
      },
      // Room encryption state for the join warning: a direct
      // state read (the login client is not joined/synced, so local state is
      // empty). true = encryption event present; false = clear not-found;
      // undefined = unreadable (403 / network) → the caller does not alarm.
      isRoomEncrypted: async (roomId: string): Promise<boolean | undefined> => {
        const c = await sdkClient();
        try {
          await c.http.authedRequest(
            "GET",
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`,
            undefined,
            undefined,
            { prefix: "" },
          );
          return true;
        } catch (err) {
          const status = (err as { httpStatus?: number } | undefined)?.httpStatus;
          const code = (err as { errcode?: string } | undefined)?.errcode;
          if (status === 404 || code === "M_NOT_FOUND") return false;
          return undefined;
        }
      },
    };
  }

  /**
   * The shared /matrix-switch body. No
   * arg → interactive menu of the available profiles (the active one
   * marked) — pick one to switch, Esc to cancel. With a profile
   * name: load + validate in memory, rebuild the whole stack against
   * it, reconnect, and announce the switch into the new room. Thread
   * state is keyed per room in the state map, so a switch preserves
   * each room's threads. The command mutates nothing on disk; profile
   * files are the source of truth and env-var overrides (PI_MATRIX_*)
   * still win. Also the target of `/matrix-connect <profile>`.
   */
  async switchProfile(name: string, ctx: ExtensionContext): Promise<void> {
    let profile = name;
    if (!profile) {
      const profiles = listProfiles();
      if (!profiles.length) {
        ctx.ui.notify(
          `No Matrix profiles found (config/matrix-config.<name>.json)\n` +
            `Active: ${this.config.roomId} · ${this.config.userId}`,
          "error",
        );
        return;
      }
      const active = getActiveProfileName();
      const chosen = await ctx.ui.select(
        `Switch Matrix profile — active: ${active ?? `${this.config.roomId} · ${this.config.userId}`}`,
        profiles.map((p) => (p === active ? `${p} (active)` : p)),
      );
      if (chosen === undefined) {
        ctx.ui.notify("Matrix switch cancelled", "info");
        return;
      }
      profile = profiles.find((p) => chosen === p || chosen === `${p} (active)`) ?? "";
    }

    const res = loadProfile(profile);
    if (!res.valid) {
      ctx.ui.notify(
        `Profile "${profile}" not loaded (${res.errors.join("; ")}) — kept the previous profile\n` +
          `Available: ${listProfiles().join(", ") || "(none)"}`,
        "error",
      );
      return;
    }
    // Seed the profile file with defaults for any missing parameters
    // (self-healing; no-op once complete).
    seedProfileDefaults(profile);
    // Remember this profile for the next pi startup (threads-and-summaries.md
    // transport-and-state.md persistence); a failed switch never writes the pointer.
    persistActiveProfile(profile);

    // Connectivity events are announced per room: the OLD room gets a
    // farewell while its outbox is still live (reattach tears it down),
    // the NEW room gets a greeting after connect. Both flat — room
    // events, not thread traffic. `this.config` is the old profile here
    // (the getter reads the not-yet-rebuilt stack); after reattach it is
    // the new one.
    const sessionTag = `${hostname()}::${basename(ctx.cwd)}`;
    const farewell = `👋 ${this.config.userId} disconnected from Pi terminal session \`${sessionTag}\``;
    try {
      await this.stack.messageHandler.sendMilestone(farewell, { type: "session", flat: true });
    } catch (error) {
      this.logger.warn(`[matrix] switch farewell failed: ${error}`);
    }

    await this.reattach(res.config, ctx.sessionManager?.getSessionId?.());
    const greeting = `🔗 ${this.config.userId} connected from Pi terminal session \`${sessionTag}\``;
    ctx.ui.notify(`Switched to ${this.config.roomId} · ${this.config.userId}`, "info");
    await this.stack.lifecycle.connectAndStart(ctx, { text: greeting, flat: true });
  }

  /**
   * The stack construction (the index.ts buildStack, verbatim with the
   * stack hunks applied + the PI_MATRIX_TEST_OUTBOX test seam).
   */
  private buildStack(cfg: MatrixConfig): MatrixStack {
    // The Outbox seam:
    // the SdkOutbox is the SINGLE transport — the legacy
    // facade + raw-HTTP pair is deleted; the outbox owns all room
    // writes/state reads + the delivery loop.
    //
    // Test seam: when `PI_MATRIX_TEST_OUTBOX` names a
    // module, the outbox is built by that module's `createTestOutbox(cfg)`
    // factory instead of `createSdkOutbox` — the fake writes state-file
    // call logs (the fake-mtx precedent, test/fake-mtx.js:92–112) so
    // spawned-suite assertions read the logs without shared-process
    // assumptions. Call-time `process.env` read (the idb-file-store.ts:173
    // idiom); the fake is a plain .mjs/.cjs module loaded through the
    // native `require` (no jiti transform), which keeps the seam
    // synchronous inside the synchronous extension factory. The fake
    // satisfies the SdkOutbox surface (seam ops + delivery verbs).
    const testOutboxPath = process.env.PI_MATRIX_TEST_OUTBOX;
    const testOutbox = testOutboxPath
      ? (createRequire(import.meta.url)(testOutboxPath) as {
          createTestOutbox: (cfg: MatrixConfig) => SdkOutbox;
        }).createTestOutbox(cfg)
      : undefined;
    // State-file namespace: the homeserver domain (the `environment` label
    // is gone — the domain tells the server).
    const stateServer = homeserverDomain(cfg.homeserver ?? "") || "unknown";
    const outbox: SdkOutbox =
      testOutbox ??
      createSdkOutbox({
        homeserver: cfg.homeserver ?? "",
        userId: cfg.userId ?? "",
        roomId: cfg.roomId,
        credentialsPath: getCredentialsPath(cfg),
        deviceId: cfg.deviceId,
        e2ee: cfg.e2ee,
        attachEncryption: cfg.attachEncryption,
        cryptoStoreDir: cfg.cryptoStoreDir,
        storePassphrase: cfg.storePassphrase,
        syncTimeoutMs: cfg.syncTimeoutMs,
        logPath: cfg.logPath,
        seenPath: join(getStateDir(), `sdk-seen-${stateServer}.json`),
        logger: this.logger,
      });
    // The D1 unread model (was owned by the deleted facade, the per-server
    // path under state/ — 7fc13e1: day-0 persistence).
    // getStateDir(): project-local `.pi/matrix/state` when the project
    // config is active, the historical extension-local state/ otherwise.
    const unreadPath = join(getStateDir(), `unread-${stateServer}.json`);
    const unreadModel = UnreadModel.load(unreadPath);

    // Late binding: the summarizer callback outlives buildStack, and the
    // integrator (which injects the directive) is created after the
    // manager.
    const summarizeRef: { current?: (root: ThreadRootState) => void | Promise<void> } = {};
    // Cadence subagent driver:
    // isolated, tool-less `pi-matrix-integration-thread-summarizer` type over the pi-subagents RPC
    // bus. Absent package → isAvailable() is false → the in-session
    // fallback below. The dialect comes from the resolved provider
    // ; one provider serves the driver and
    // the spawn watchers below.
    const subagentProvider = resolveSubagentProvider(cfg.subagents?.provider ?? "auto", {
      events: this.pi.events,
      logger: this.logger,
      agentType: SUMMARIZER_AGENT_TYPE,
      ...(cfg.threadSummarizeModel !== undefined ? { model: cfg.threadSummarizeModel } : {}),
      pingTimeoutMs: 1500,
      // 120_000 killed a 7m50s SUCCESSFUL local-inference run (2026-10-24):
      // the provider gave up at the budget, the child's result arrived with
      // nobody listening. 10 min for cadence runs on local inference.
      // Watchdog vs. hung runs only — slow completions post whenever they land.
      runTimeoutMs: cfg.threadSummarizeRunTimeoutMs ?? 1_800_000,
    });
    const subagentSummarizer = createSubagentSummarizer({
      events: this.pi.events,
      provider: subagentProvider,
      logger: this.logger,
    });

    // threads-and-summaries.md: the ThreadManager is routing + ledger only — its write
    // delegate routes thread posts/edits through the MessageHandler
    // pipeline (format + dedupe live there, markdown.ts is the single
    // formatter); room-topic + timeline reads go straight to the seam.
    // Late binding: the delegate closures read `messageHandler` at call
    // time (constructed below) — the same discipline as the late-bound
    // messageHandler itself.
    let messageHandler: MessageHandler;
    const threadManager: ThreadManager = createThreadManager({
      enabled: !!cfg.threads,
      roomKey: cfg.roomId,
      threadSend: {
        postThreadRoot: (body, html) => messageHandler.postInThread(body, undefined, { html }),
        postThreadReply: (body, rootId, nestedRoot, html) =>
          messageHandler.postInThread(body, rootId, { nestedRoot, html }),
        editMessage: (targetEventId, text, opts) =>
          messageHandler.editInThread(targetEventId, text, opts?.html),
        setRoomTopic: (topic) =>
          outbox?.setRoomTopic(topic) ?? Promise.resolve({ success: false, error: "no outbox" }),
        readTimeline: (limit) =>
          outbox?.readTimeline(limit) ?? Promise.resolve({ success: false, messages: [] }),
      },
      statePath: join(getStateDir(), "thread-map.json"),
      threadIcon: cfg.threadIcon,
      threadSummaryEvery: cfg.threadSummaryEvery,
      threadSummaryFib: cfg.threadSummaryFib,
      threadSummaryOnFinal: cfg.threadSummaryOnFinal,
      threadSummaryByLlm: !!cfg.threadSummaryByLlm,
      threadSummarizeLimit: cfg.threadSummarizeLimit,
      threadSummaryMaxLines: cfg.threadSummarizeMaxLines,
      onSummarizeRequest: (root) => summarizeRef.current?.(root),
      roomTopicUpdates: !!cfg.roomTopicUpdates,
      subThreads: !!cfg.subThreads,
      rolePrefixes: cfg.rolePrefixes,
      pendingRoute: cfg.threadPendingRoute,
      logger: this.logger,
    });

    messageHandler = createMessageHandler({
      dedupeWindowMs: cfg.dedupeWindowMs,
      sendFormatted: cfg.sendFormatted,
      tablesInSeparateMessage: cfg.tablesInSeparateMessage,
      milestoneIcon: cfg.milestoneIcon,
      userMessageIcon: cfg.userMessageIcon,
      threadManager,
      // threads-and-summaries.md: the pipeline's write surface for thread-targeted
      // posts + edits (postInThread / editInThread).
      outbox,
      logger: this.logger,
    });

    // The footer's live snapshot provider (late-bound: the lifecycle is
    // built below; the buildStack summarizeRef/messageHandler discipline).
    // Ephemeral by design — no state/ persistence (7fc13e1 check): the
    // snapshot lives in the Lifecycle per stack build.

    // The sub-agent bus: owner-side records +
    // type colors, posted through THIS instance's connected pipeline.
    // Re-published on every build (/matrix-switch → the new generation wins).
    const subagentBus = createSubagentBus(
      () => ({
        enabled: cfg.subagents?.enabled !== false,
        spawnMessages: cfg.subagents?.spawnMessages !== false,
        summarizeResultIntoSpawnLine: cfg.subagents?.summarizeResultIntoSpawnLine !== false,
        postMode: cfg.subagents?.postMode === "all" ? ("all" as const) : ("turn-end" as const),
        colorByType: cfg.subagents?.colorByType,
        colorPalette: cfg.subagents?.colorPalette,
        plainMarker: cfg.subagents?.plainMarker ?? "⚡",
      }),
      () => cfg.sendFormatted === true,
      {
        send: (text, html) => messageHandler.post(text, "other", { html }),
        edit: async (eventId, text, html) => {
          const r = await messageHandler.editInThread(eventId, text, html);
          return r.success;
        },
      },
      // Warn-level, not debug: a dropped spawn line is a lost room message.
      (line) => this.logger.warn(line),
      // Explicit meta: spawn lines resolve
      // the session's current model/thinking when the spawn has no override.
      () => ({
        model: this.sessionModel,
        thinking: this.sessionThinking,
      }),
    );
    // No publish here: buildStack runs in the constructor of EVERY session's
    // extension instance (the factory is per-session), so a side chain would
    // displace the owner's registry with its own empty bus. The publish is
    // ownership-gated: claimOwner (main line) and reattach (transport-and-state.md owner-side
    // registry — one per process).

    const connectionStatusRef: { current?: () => import("./types.js").ConnectionStatus } = {};
    const sessionIntegrator = createSessionIntegrator(this.pi, () => connectionStatusRef.current?.() ?? { connected: false, connecting: false, roomUri: cfg.roomId, userId: cfg.userId ?? "" }, {
      piTerminalMatrixMessagePrefix: cfg.piTerminalMatrixMessagePrefix,
      showInFooter: cfg.showInFooter,
      footerIcon: cfg.footerIcon,
      // Footer thread indicator (bright icon = routing on, faded = off).
      // Reads the manager at call time — after a /matrix-switch rebuild it
      // still points at the CURRENT manager, not the one captured here.
      getThreadStatus: () => ({
        icon: threadManager.threadIcon(),
        enabled: threadManager.enabled(),
      }),
      // Footer lock: the connected room's REAL encryption state, read live
      // from the transport (never from config — config cannot enforce it).
      getRoomEncryption: () => outbox?.isRoomEncrypted?.(),
    });

    // Dual-surface RPIV decisions (mirror of the `ask_user_question` TUI):
    // while a RPIV questionnaire blocks on terminal input, post it to the
    // active thread/room; room replies are buffered and relayed as ONE
    // complete `rpiv:ask-user:answer` on confirm (upstream >= 2.13 native
    // answer channel, all-or-nothing; verdicts on
    // `rpiv:ask-user:answer-result`). Terminal input stays authoritative;
    // whichever surface completes the questionnaire first wins. Posts ride
    // the decision ledger (kind "decision").
    // threads-and-summaries.md: the mirror ships markdown; the pipeline routes (thread
    // when active), formats (`sendFormatted` gate), and writes. Decision
    // re-issues intentionally skip dedupe — a re-ask is intentional
    // (`dedupe: false` is explicit, not a bypass).
    let lifecycle: Lifecycle;
    const askUserMirror = createAskUserMirror({
      post: async (text) => messageHandler.post(text, "decision", { dedupe: false }),
      // The living review post keeps its event id and re-edits itself in
      // place (one review message, not a trail of them per tap/correction).
      // formatReview ships RAW HTML (green <font> instructions, bold titles,
      // ✅/⬜ checkboxes) — pass it as a pre-built `html` payload so the
      // pipeline ships it verbatim as formatted_body (the md converter
      // would escape the styling into literal text) and builds the plain
      // body fallback via stripHtmlTags.
      postResult: async (text) => messageHandler.post(text, "decision", { dedupe: false, html: text }),
      edit: async (targetEventId, text) => messageHandler.editInThread(targetEventId, text, text),
      // The flag moved to the lifecycle — the late-bound
      // call-time read keeps the mirror switch-current.
      isEnabled: () => lifecycle.isEnabled(),
      emitAnswer: (payload) => this.pi.events.emit("rpiv:ask-user:answer", payload),
      // Polls: single-select questions additionally
      // ship as tappable m.poll events. The active thread root is read at
      // call time (same late-bound style as the decision text posts' thread
      // routing) — a /matrix-switch rebuild stays correct.
      postPoll: (question, options, maxSelections) =>
        outbox.sendPoll(question, options, threadManager.activeRoot()?.eventId, maxSelections),
      sendPollVote: (pollEventId, answerIds, labels) => outbox.sendPollVote(pollEventId, answerIds, labels),
      endPoll: (pollEventId) => outbox.endPoll(pollEventId),
      pollsEnabled: () =>
        cfg.mirrorAskUser !== false && cfg.mirrorAskUserPolls !== false,
      warn: (message) => this.logger.warn(message),
    });

    // The room-sourced delta for the summarizer prompt (threads-and-summaries.md
    // transport-and-state.md): prefer the thread manager's own delta read (no
    // "read clears unread" side effect); when it comes back empty, fall
    // back to the outbox timeline read.
    // The summary is a pure function of the room artifact — the Pi session
    // only triggers/hosts the run. Only the "room" source path calls this;
    // "session" mode never reads the room.
    const readThreadDelta = async (root: SummarizeRoot): Promise<ThreadDeltaMessage[]> => {
      const csDelta = await threadManager.readThreadDelta();
      if (csDelta.length > 0) return csDelta;
      try {
        const msgs = await outbox.readMessages(cfg.threadSummarizeLimit ?? 40);
        return filterThreadDelta(
          msgs,
          root.eventId,
          cfg.threadSummarizeLimit ?? 40,
          root.lastSummarizedEventId,
        );
      } catch {
        return [];
      }
    };

    // Summarizer firing (threads-and-summaries.md + ROOM-SUMMARIZER threads-and-summaries.md): the source
    // flag (threadSummarizeSource) picks the runner — "session"
    // re-introduces the legacy in-session pass (the main session's own
    // context is the delta, so it runs there); "room" (default) is
    // room-sourced via the subagent, with the in-session directive as
    // fallback. Both keep the last summary on failure.
    summarizeRef.current = createSummarizeDispatcher({
      source: cfg.threadSummarizeSource,
      limits: {
        milestoneMax: cfg.threadSummarizeMilestoneMax,
        recentMax: cfg.threadSummarizeRecentMax,
        maxLines: cfg.threadSummarizeMaxLines,
      },
      readDelta: readThreadDelta,
      subagent: subagentSummarizer,
      injectDirective: (text, details) => sessionIntegrator.injectDirective(text, details),
      updateSummary: (summary, watermarkEventId) =>
        threadManager.updateSummary(summary, watermarkEventId),
      logger: this.logger,
    });

    // The minimal event funnel (transport-and-state.md): one dispatcher per stack
    // build. Ephemeral by design — no state/ persistence (7fc13e1 check):
    // the funnel is call-time dispatch only; the rpiv bus subscription in
    // attach() emits through the CURRENT dispatcher at call time; the
    // dispatcher itself holds no persisted state.
    const events = createEventDispatcher((message) => this.logger.warn(message));
    // The SdkDeliveryCallbacks bundle (the terminal slice wires it): the
    // full shape — onMessage/onReaction legs into the CURRENT Inbound
    // (call-time read — a /matrix-switch rebind stays wired, no
    // re-registration), the D1 unread bump, the seed log line, and the
    // sync-error feed into the Lifecycle snapshot. Ephemeral by design —
    // no state/ persistence (7fc13e1 check). Declared BEFORE the
    // lifecycle (which takes it as a dep); its legs read `inbound` /
    // `lifecycle` at call time (both constructed later — closures, not
    // immediate calls, so the late reads are TDZ-safe).
    const deliveryCallbacks: SdkDeliveryCallbacks = {
      onMessage: (m) => inbound.dispatch(m),
      onReaction: (m) => inbound.dispatchReaction({ reactionKey: m.reactionKey, isFromPi: m.isFromPi }),
      // Poll tap leg: straight into the mirror (the tap's question routing
      // + guards live there — unknown poll / closed mirror = silent drop).
      onPollResponse: (p) => {
        askUserMirror.onPollResponse(p.pollEventId, p.refs);
      },
      bumpUnread: (roomKey, entry) => unreadModel.bump(roomKey, entry),
      onSeedComplete: (n) => this.logger.debug(`[matrix] sdk seed complete (${n})`),
      onSyncError: (err) => lifecycle.noteSyncError(err),
    };
    // The lifecycle owner of the session/connect state the entry point
    // used to hold in closures: the enabled flag, the ConnectionStatus
    // snapshot (transport-and-state.md ownership), the connect + start sequence, the
    // session hook bodies, and the teardown order (stopDelivery →
    // disconnect).
    lifecycle = createLifecycle({
      cfg,
      logger: this.logger,
      outbox,
      deliveryCallbacks,
      messageHandler,
      threadManager,
      sessionIntegrator,
      subagentBus: () => ownerBus(),
      // First-run login (configuration-and-room-behaviour.md transport-and-state.md): the hook decides
      // at call time (credentials may appear/disappear between stack
      // builds — /matrix-login re-points the stack).
      onFirstRun: (ctx, milestone) => this.onFirstRunLogin(ctx, milestone),
    });
    connectionStatusRef.current = () => lifecycle.status();
    // The subagent sub-thread markers (threads-and-summaries.md) — the
    // tool_call/tool_result bodies, extracted. The provider's spawn tools
    // (names + normalizers from `spawnWatch`, configuration-and-room-behaviour.md transport-and-state.md)
    // route to the bus: main-line tool_calls
    // register spawn records; side-chain tool_calls register nested spawns
    const coreAgent: CoreAgentDelegate = {
      onAgentTool: (input) => {
        this.logger.debug(`[matrix] spawn → bus (${input.name})`);
        if (lifecycle.isSubagentMode()) {
          subagentBus.nestedSpawn(lifecycle.subagentSelfName() ?? "agent", input);
        } else {
          subagentBus.spawn(input);
        }
      },
      onWorkflowTool: (input) => {
        this.logger.debug(`[matrix] nested-spawn (${input.name})`);
        if (lifecycle.isSubagentMode()) return; // nested container: logged only
        subagentBus.spawn(input); // name fallback is the normalizer's job
      },
      onAgentRunId: (prompt, runId) => subagentBus.attachRunId(prompt, runId),
    };
    // configuration-and-room-behaviour.md transport-and-state.md: the room's settle line for a detached
    // child arrives on the provider's completion channel (the child's own
    // agent_settled is silent across processes). Matched by run id —
    // attached from the spawn's tool_result by the watchers above.
    const unsubCompletion = subagentProvider.completionChannel?.((runId) => {
      this.logger.debug(`[matrix] subagent completion (${runId}) → bus settle`);
      subagentBus.settleByRunId(runId);
    });
    const watchers = createToolWatchers({
      cfg,
      threadManager,
      coreAgent,
      getSpawnWatch: () => subagentProvider.spawnWatch,
      log: (line) => this.logger.debug(line),
    });
    // The funnel consumers (registered per build — see the dispatcher
    // note):
    events.on("decision-closed", () => {
      askUserMirror.onBlocked(false);
      threadManager.noteDecisionClosed();
    });

    // The room-UX aggregation (transport-and-state.md): the slash suggestion
    // reply, both pickers ("@" file / "@@" artifact), and the
    // /matrix-help guide — every room auto-reply posts through the
    // outgoing pipeline. The picker instance is factory
    // scope (zero-delta move of the two original trackers — it survives
    // /matrix-switch, as they did).
    const roomUx = createRoomUx({
      cfg,
      logger: this.logger,
      outbox,
      post: (text, kind) => messageHandler.post(text, kind),
      picker: this.pickerState,
    });
    // The single room-event dispatch point (transport-and-state.md): mirror
    // consume → slash relay → attach → decision/inject (index.ts
    // 649–872, 1:1). Rebuilt with the stack on /matrix-switch (the
    // object-stable rebind discipline) — the registrations dispatch
    // through the CURRENT inbound at call time; `pi` is the stable
    // entry-point API.
    // Voice transcription: the media download rides the
    // outbox (token + baseUrl owned there); the transcriber is stateless
    // (the warm engine caches itself in the voice module). The test
    // outbox seam may lack downloadMedia — degrade to a no-op download
    // (the voice leg then just logs + drops, same as any failed fetch).
    const voiceTranscriber: VoiceTranscriber = createVoiceTranscriber({
      logger: this.logger,
      download: (mxcUrl) =>
        typeof outbox.downloadMedia === "function"
          ? outbox.downloadMedia(mxcUrl)
          : Promise.resolve(null),
    });
    const inbound = createInbound({
      cfg,
      logger: this.logger,
      pi: this.pi,
      threadManager,
      mirror: askUserMirror,
      roomUx,
      messageHandler,
      sessionIntegrator,
      voiceTranscriber,
    });

    return {
      outbox,
      unreadModel,
      unreadPath,
      deliveryCallbacks,
      messageHandler,
      sessionIntegrator,
      threadManager,
      askUserMirror,
      events,
      lifecycle,
      watchers,
      roomUx,
      inbound,
      subagentBus,
      unsubCompletion,
      config: cfg,
    };
  }

  private updateFooter(): void {
    const ctx = this.lastCtx;
    if (!ctx) return;
    try {
      this.stack.sessionIntegrator.updateFooterStatus(ctx);
    } catch {
      // ctx is stale (session replaced/reloaded) — the next session_start
      // will refresh the footer with a fresh ctx
      this.lastCtx = undefined;
    }
  }
}
