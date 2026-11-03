/**
 * Pi Matrix Integration — SDK transport.
 *
 * `SdkOutbox`: the `matrix-js-sdk` implementation of the Outbox seam
 * (src/outbox.ts) + the sync-based read pipeline that replaces the poll
 * loop — the single transport (the matrix-http fallback is deleted):
 *
 * - **Writes** (Outbox ops): `client.sendMessage` / `sendEvent` /
 *   `setRoomTopic` / `uploadContent` — the SDK knows the correct verbs
 *   per server; no hand-rolled HTTP.
 * - **Reads**: `client.startClient()`'s long-poll sync delivers
 *   `Room.timeline` events; they are normalized through the shared
 *   `parseMatrixEvent` (the same pipeline the poller feeds) —
 *   thread metadata, reactions, `isFromPi` marking — and the initial
 *   sync's backfill is the seed round (baselined, never emitted, the
 *   poller's seed rule).
 * - **Attachments**: MSC4125 sender-side encryption (`matrix-encrypt-
 *   attachment`, AES-256-CTR v2) so VectorIM Element Web's
 *   `isEncrypted === !!content.file` bug no longer breaks `@@` opens.
 * - **E2EE**: `initRustCrypto` (the bundled Rust crypto WASM) with the
 *   file-backed IDB shim (src/idb-file-store.ts) persisting the device +
 *   room keys under `cryptoStoreDir` (0700/0600); the stable `deviceId`
 *   makes the bot the same device across restarts.
 *
 * The `matrix-js-sdk` CJS is loaded lazily (only when this module's
 * `connect()` runs), so non-sdk transports pay nothing for it.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MatrixEvent, MatrixMessage } from "./types.js";
import type { ThreadDeltaMessage } from "./summarize.js";
import type { MatrixHttpResult, Outbox } from "./outbox.js";
import { parseMatrixEvent } from "./thread-meta.js";
import type { MatrixLogger } from "./logger.js";
import {
  createConsoleLogger,
  createJsSdkFileLogger,
  installConsoleInterceptor,
  rebindJsSdkModuleLogger,
} from "./logger.js";
import { installFileIdb } from "./idb-file-store.js";

type SdkModule = typeof import("matrix-js-sdk");
type SdkMatrixClient = InstanceType<SdkModule["MatrixClient"]>;
type SdkMatrixEvent = InstanceType<SdkModule["MatrixEvent"]>;
type SdkRoom = InstanceType<SdkModule["Room"]>;
type SdkSyncState = SdkModule["SyncState"];

/** Marks a thread root. This package writes it and reads it back:
 *  `extractThreadMeta` (src/thread-meta.ts) sets `isThreadRoot` from its
 *  presence, the unread model keys a new conversation on it
 *  (src/unread-model.ts:113), and the summarizer keeps the root event inside
 *  its own thread delta with it (src/summarize.ts:51). The name is historical
 *  (MSC1767). Threads themselves ride `m.relates_to`, and spec-following
 *  clients such as Element do not write this field — so a root that was
 *  started elsewhere is not detected as a root here. Deleting the write means
 *  giving those two read paths another way to recognise a root. */
const THREAD_MARKER = { "m.topological_ordering": 1, "m.message_count": 1 };

/** The js-sdk default `initialSyncLimit` (10) backfills too few events
 *  for the thread-delta read, so it is raised to 50. */
const DEFAULT_INITIAL_SYNC_LIMIT = 50;

/** Sync long-poll cap (ms) — the js-sdk `startClient({ timeout })`. */
const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

/** Same seen-event cap the poll loop uses (dedupe on re-delivered events). */
const MAX_SEEN_EVENT_IDS = 1000;

/** Backfill (initial-sync) events newer than this are emitted instead of
 *  baselined — messages sent while this client was down still reach the
 *  session; older backfill stays baselined, so a cutover cannot flood the room.
 *  ponytail: time-window heuristic; a persisted last-delivered
 *  high-water mark would be the exact version. */
const BACKFILL_GRACE_MS = 600_000;

/** Fixed IDB "database" prefix under cryptoStoreDir (the dir is already
 *  per-account, so one prefix suffices). */
const CRYPTO_DB_PREFIX = "pi";

/** Decryption cap for one on-demand read — a hung rust decrypt must not
 * stall the read (the sync pipeline's own decrypt has no cap; these are
 * one-shot reads on the tool/summarizer path). */
const DECRYPT_WAIT_MS = 5_000;

export interface SdkOutboxOptions {
  /** Homeserver host ("matrix.example.org" or "https://…"). */
  homeserver: string;
  /** `@user:domain` — the single identity this extension logs in as (`isFromPi`). */
  userId: string;
  /** Room alias or id from config. */
  roomId: string;
  /** Account-store credentials file (JSON with `access_token`). */
  credentialsPath: string;
  /** Stable device id (default "PI_AGENT_1") — the E2EE identity across restarts. */
  deviceId?: string;
  /** E2EE via the bundled Rust crypto WASM + file-backed store. Default "on". */
  e2ee?: "on" | "off";
  /** MSC4125 sender-side attachment encryption. Default "on". */
  attachEncryption?: "on" | "off";
  /** Crypto-store root (default: `<dirname(credentialsPath)>/store`). */
  cryptoStoreDir?: string;
  /** At-rest passphrase for the crypto store (the WASM's `storagePassword`);
   *  when set, the on-disk key material is unreadable without it. */
  storePassphrase?: string;
  /** Sync long-poll cap (ms). Default 60000. */
  syncTimeoutMs?: number;
  /** Main extension log file (home-expanded). The sdk transport's log
   *  (`pi-matrix-http-sdk.log`) sits in the same directory; default is
   *  the directory of `~/.pi/logs/pi-matrix.log`. */
  logPath?: string;
  /** Persist the bounded seen-event-id set here (JSON string array) so a
   *  reconnect (new pi session) does not re-emit the previous session's
   *  already-delivered backfill (the 2026-09-18 re-injection bug). */
  seenPath?: string;
  logger?: MatrixLogger;
}

/** Read-side callbacks — the same pipeline the poll loop feeds today. */
export interface SdkDeliveryCallbacks {
  /** A surviving `m.room.message` (self-dropped, past the seed round). */
  onMessage(message: MatrixMessage): void;
  /** An `m.reaction` (annotation relation). */
  onReaction(message: MatrixMessage): void;
  /** A poll tap (MSC3381 response) on one of pi's decision polls — the
   *  user's vote, routed to the ask-user mirror, never onMessage. Always
   *  a user tap: pi never sends poll responses (it sends the polls
   *  themselves), so no shared-account isFromPi guard is needed. `refs`
   *  are the tapped answer ids (extensible format) or, for legacy
   *  MSC1767 voters, the answer labels — the mirror resolves both. */
  onPollResponse?(poll: {
    pollEventId: string;
    refs: string[];
    timestamp: number;
  }): void;
  /** Per-thread unread-model bump for a surviving message. */
  bumpUnread(
    roomKey: string,
    entry: {
      ts: number;
      preview: string;
      eventId: string;
      threadRoot?: string;
      isThreadRoot?: boolean;
    },
  ): void;
  /** One line per seed round (the initial-sync backfill was baselined). */
  onSeedComplete?(eventCount: number): void;
  /** A sync loop error (the connection degrade point). */
  onSyncError(error: Error): void;
}

/**
 * Resolve the device id for a connection. An explicitly configured
 * `deviceId` wins — it is an operator override. With nothing configured, the
 * credentials file's own `device_id` is used, because the token is
 * device-bound (the spike's 400 M_BAD_JSON root cause was a hardcoded id that
 * didn't match the device the token was minted for). Note the override can
 * itself cause that mismatch: a configured id that is not the device the
 * token belongs to is rejected by the homeserver (D-R4-23). The fresh-login default is
 * `PI_AGENT_1`: it keeps the `PI_AGENT` identity AND satisfies the MAS
 * device-scope policy (MAS 1.15.0, `policies/authorization_grant/
 * authorization_grant.rego`), which requires the scope's device id to match
 * `[A-Za-z0-9._~!$&'()*+,;=:@/-]{10,}` — `PI_AGENT` (8) and `PIAGENT` (7)
 * both fail that minimum. The extension is unreleased, so the default change
 * has no compatibility concern; existing credentials keep their stored id.
 */
export function resolveDeviceId(
  optsDeviceId: string | undefined,
  credDeviceId: string | undefined,
): string {
  return optsDeviceId ?? credDeviceId ?? "PI_AGENT_1";
}

/**
 * The SDK-backed Outbox + sync transport. Construct via
 * `createSdkOutbox`; `connect()` is async (lazy SDK load + crypto init).
 */
export class SdkOutbox implements Outbox {
  private opts: SdkOutboxOptions;
  private logger: MatrixLogger;
  private client: SdkMatrixClient | null = null;
  private token: string | undefined;
  private started = false;
  private resolvedRoomId: string | undefined;
  private uninstallIdb: (() => void) | null = null;
  private deliveryStarted = false;
  /** The live delivery callbacks (set by startDelivery, cleared by
   *  stopDelivery). Null between connect() and startDelivery — the sync
   *  handler feeds sync errors through it only while delivery runs. */
  private cbs: SdkDeliveryCallbacks | null = null;
  private seeding = true;
  private seedCount = 0;
  private seenEventIds: Set<string> = new Set();
  private sdk: SdkModule | null = null;
  private lockFd: number | null = null;

  /** Load the persisted seen-event ids (oldest first) into the in-memory
   *  set; a missing/corrupt file just starts clean. */
  private loadSeen(): void {
    const p = this.opts.seenPath;
    if (!p || !existsSync(p)) return;
    try {
      const ids: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (!Array.isArray(ids)) return;
      for (const id of ids) if (typeof id === "string") this.seenEventIds.add(id);
    } catch {
      /* corrupt file — start clean */
    }
  }

  /** Persist the bounded set (insertion order = oldest → newest, so the
   *  next load evicts oldest first). */
  private persistSeen(): void {
    const p = this.opts.seenPath;
    if (!p) return;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify([...this.seenEventIds]));
    } catch (error) {
      this.logger.warn(`[matrix] sdk: persist seen ids failed: ${error}`);
    }
  }

  constructor(opts: SdkOutboxOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? createConsoleLogger();
    process.on("exit", () => this.releaseAccountLock());
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Load credentials + start the client (sync loop). Idempotent. */
  async connect(): Promise<boolean> {
    if (this.started) return this.resolvedRoomId !== undefined;

    const cred = this.loadCredentials();
    const token = cred.access_token;
    if (!token) {
      this.logger.warn("[matrix] sdk transport: no access token — all ops fail soft");
      return false;
    }
    this.token = token;

    if (!(await this.acquireAccountLock())) return false;

    const sdk = await this.loadSdk();
    this.sdk = sdk;

    const baseUrl = this.normalizeBaseUrl(this.opts.homeserver);
    // js-sdk's default logger is loglevel → `console` (the Pi session's
    // stdout — the "SDK bleeding"); route the client + sync + Rust-crypto
    // logs to their own logfile next to the main extension log instead.
    const sdkLogPath = join(
      dirname(this.opts.logPath || join(homedir(), ".pi", "logs", "pi-matrix.log")),
      "pi-matrix-http-sdk.log",
    );
    const fileLogger = createJsSdkFileLogger(sdkLogPath);
    // Stdout-capture layers (principle: all SDK console output lands in
    // the logfile, not the Pi terminal):
    //   1. rebind the SDK's module-level logger in place — lib/logger.js
    //      is imported directly by ~56 SDK files (models/room.js, the
    //      "setting pendingEvent status" site, included), and its
    //      loglevel methodFactory re-reads `console` at call time, so
    //      import-time capturing cannot catch it;
    //   2. route the global `console` (WASM stack traces, third-party
    //      leaks, unhandled rejections) to the same file.
    const { logger: sdkModuleLogger } = await import("matrix-js-sdk/lib/logger.js");
    rebindJsSdkModuleLogger(sdkModuleLogger, fileLogger);
    installConsoleInterceptor(sdkLogPath);
    const client = new sdk.MatrixClient({
      baseUrl,
      accessToken: token,
      userId: this.opts.userId,
      // The token is device-bound: prefer the credentials file's own
      // device_id (see resolveDeviceId for the MAS device-scope policy the
      // fresh-login default must satisfy).
      deviceId: resolveDeviceId(this.opts.deviceId, cred.device_id),
      store: new sdk.MemoryStore(),
      // js-sdk `Logger` seam (lib/client.js: `opts.logger ?? logger`);
      // also feeds initRustCrypto → OlmMachine, so the Rust-crypto WASM
      // logs land in the same file.
      logger: fileLogger,
    } as ConstructorParameters<typeof sdk.MatrixClient>[0]);

    // E2EE: the Rust crypto WASM + the file-backed IDB shim. The shim
    // (0700 dir / 0600 files, atomic writes) is installed on
    // globalThis.indexedDB before initRustCrypto — the SDK's own store
    // then persists to disk under cryptoStoreDir. The default sits
    // beside the credentials file: the account dir that already holds
    // the bot's token, so test and production stores are separated per account
    // (transport-and-state.md).
    if ((this.opts.e2ee ?? "on") === "on") {
      const storeDir =
        this.opts.cryptoStoreDir ?? join(dirname(this.opts.credentialsPath), "store");
      this.uninstallIdb = installFileIdb(storeDir, globalThis);
      const rustCryptoArgs = {
        useIndexedDB: true,
        cryptoDatabasePrefix: CRYPTO_DB_PREFIX,
        // At-rest encryption: with a passphrase, the WASM stores key
        // material encrypted (the meta-DB path the shim supports) — a
        // stolen/exfiltrated store dir is unreadable without it.
        ...(this.opts.storePassphrase ? { storagePassword: this.opts.storePassphrase } : {}),
      };
      try {
        await client.initRustCrypto(rustCryptoArgs);
      } catch (error) {
        // Device re-mint: ops re-minted credentials.json to a new device_id
        // but the persisted Olm account belongs to the previous device —
        // the WASM's OlmAccount::load rejects the stale store (Account-
        // Mismatch) and connect() would die. Move the old store aside (the
        // previous device's room keys stay on disk — key backup is the
        // planned recovery) and retry once with a fresh account.
        if (!/account in the store doesn't match/i.test(String(error))) {
          throw error;
        }
        this.logger.warn(
          "[matrix] sdk: crypto store belongs to a previous device (credentials re-minted) — keeping it as .bak-remint-* and starting a fresh Olm account",
        );
        this.uninstallIdb?.();
        this.uninstallIdb = null;
        this.moveCryptoStoreAside(storeDir);
        this.uninstallIdb = installFileIdb(storeDir, globalThis);
        await client.initRustCrypto(rustCryptoArgs);
      }
      this.logger.debug?.("[matrix] sdk: rust crypto initialized (file-backed store)");
    }

    await client.startClient({
      initialSyncLimit: DEFAULT_INITIAL_SYNC_LIMIT,
      timeout: this.opts.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
    });
    this.client = client;
    this.started = true;

    // The Sync state is the connection-degrade point (an error keeps
    // retrying internally; surface it to the footer/status).
    const SyncState = sdk.SyncState as typeof SdkSyncState;
    client.on(
      "sync" as never,
      (state: SdkSyncState, data?: { error?: Error | null }) => {
        if (state === SyncState.Error) {
          const e = data?.error ?? new Error("sync error");
          this.logger.warn(`[matrix] sdk sync error: ${e.message ?? e}`);
          // Feed the lifecycle snapshot (footer lastError) while delivery
          // runs; before startDelivery the callbacks are not wired yet and
          // the connect path already surfaces its own errors.
          this.cbs?.onSyncError(e);
        } else if (state === SyncState.Stopped) {
          this.logger.warn("[matrix] sdk sync stopped");
        }
      },
    );

    // Resolve the configured room (aliases need the server lookup; `!`
    // ids pass through). Independent of sync progress.
    this.resolvedRoomId = await this.resolveRoom();
    if (this.resolvedRoomId === undefined) {
      // A failed alias lookup must not leave `started` true: the
      // short-circuit at the top of connect() would then fail every
      // /matrix-connect retry for the life of the process. Tear down so
      // the next connect() runs the full path, and release the account
      // lock a wedged session would otherwise hold.
      await this.disconnect();
      return false;
    }
    return true;
  }

  /** True when a token was loaded and the client is running (the
   *  `available()` soft-fail gate — ops fail soft until then). */
  available(): boolean {
    return this.token !== undefined && this.started;
  }

  /** Stop the client + restore the global indexedDB. Crypto-store writes
   *  flush to the on-disk files as the stop completes. */
  async disconnect(): Promise<void> {
    this.stopDelivery();
    if (this.client) {
      try {
        this.client.stopClient();
      } catch (error) {
        this.logger.warn(`[matrix] sdk stopClient: ${error}`);
      }
      this.client = null;
      this.started = false;
    }
    this.uninstallIdb?.();
    this.uninstallIdb = null;
    this.releaseAccountLock();
  }

  /**
   * Test seam (test/test-logic.mjs): install a pre-built client so the
   * op wrappers can be exercised against a fake — no credentials file,
   * no sync, no WASM. `started` + `token` flip on so the `available()`
   * gate opens; `resolvedRoomId` is what the ops target.
   */
  setTestClient(
    client: SdkMatrixClient,
    resolvedRoomId: string | undefined,
    sdkModule: SdkModule,
  ): void {
    this.client = client;
    this.sdk = sdkModule;
    this.started = true;
    this.token = "test-token";
    this.resolvedRoomId = resolvedRoomId;
  }

  /** Move the crypto DB dir aside as `.bak-remint-<ts>` (never delete —
   *  the previous device's room keys stay on disk; only a device re-mint
   *  resets it, and key backup is the planned recovery). */
  private moveCryptoStoreAside(storeDir: string): void {
    const dbDir = join(storeDir, `${CRYPTO_DB_PREFIX}::matrix-sdk-crypto`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let dest = `${dbDir}.bak-remint-${stamp}`;
    for (let n = 2; existsSync(dest); n++) dest = `${dbDir}.bak-remint-${stamp}-${n}`;
    renameSync(dbDir, dest);
  }

  /**
   * Cross-process account lock: the account dir holds the device token
   * AND the OLM crypto store. A second pi session sharing this account
   * spins up a second OlmCrypto over the same OLM account — the Olm
   * double-ratchet state forks, to-device-encrypted megolm keys stop
   * reaching the peer, and the channel starts rendering "Unable to
   * decrypt message". The first live session owns the account; a second
   * fails soft with one clear line. Lockfile: `pi-matrix.lock` in the
   * account dir, O_EXCL + holder pid (stale when the pid is dead).
   */
  private async acquireAccountLock(): Promise<boolean> {
    const accountDir = dirname(this.opts.credentialsPath);
    if (!existsSync(accountDir)) return true; // no account dir — nothing to lock
    const lockPath = join(accountDir, "pi-matrix.lock");
    for (;;) {
      try {
        this.lockFd = openSync(lockPath, "wx");
        writeFileSync(
          this.lockFd,
          JSON.stringify({
            pid: process.pid,
            room: this.opts.roomId,
            ts: new Date().toISOString(),
          }),
        );
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let holderPid: number | undefined;
        try {
          holderPid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number })
            .pid;
        } catch {
          /* corrupt/missing lockfile — treat as stale */
        }
        // Dead holder (crashed session left the file): reclaim it.
        if (!this.pidAlive(holderPid)) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* another process won the race — retry loop */
          }
          continue;
        }
        // Same pid = an in-process orphan: a prior SdkOutbox in THIS
        // process still holds the account (a side-chain sub-agent session
        // racing the owner, a re-register on /reload, a racing switch). NOT
        // another pi session. configuration-and-room-behaviour.md transport-and-state.md: wait for the
        // release (1 s × 30) instead of yielding permanently — the
        // structural fix removes the trigger, this closes the regression
        // window. A second Olm account over the same device is never
        // started (it would fork the E2EE ratchet).
        if (holderPid === process.pid) {
          this.logger.warn?.(
            `[matrix] sdk: Matrix account ${this.opts.userId} is already held by THIS process (pid ${process.pid}) — a prior SdkOutbox in this process is still connected. Waiting up to 30 s for it to release…`,
          );
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            try {
              this.lockFd = openSync(lockPath, "wx");
              writeFileSync(
                this.lockFd,
                JSON.stringify({
                  pid: process.pid,
                  room: this.opts.roomId,
                  ts: new Date().toISOString(),
                }),
              );
              this.logger.debug?.(
                "[matrix] sdk: account lock released by the prior SdkOutbox — acquired",
              );
              return true;
            } catch (error2) {
              if ((error2 as NodeJS.ErrnoException).code !== "EEXIST") throw error2;
              // Still held — keep waiting.
            }
          }
          this.logger.error?.(
            `[matrix] sdk: Matrix account ${this.opts.userId} is STILL held by THIS process (pid ${process.pid}) after 30 s — the prior SdkOutbox did not release. Starting a second Olm account on the same device would fork the E2EE ratchet, so this connect yields. Not connecting.`,
          );
          return false;
        }
        // A DIFFERENT live pid genuinely holds the account (a real second
        // pi session on the same account).
        this.logger.error?.(
          `[matrix] sdk: Matrix account ${this.opts.userId} is already in use by another live pi session (pid ${holderPid}) — one Matrix account/device per pi session. A second Olm account on this device forks the Olm ratchet and breaks E2EE key sharing ("Unable to decrypt message"). Stop the other session or give this one its own account/device. Not connecting.`,
        );
        return false;
      }
    }
  }

  /** Release the account lock (only when this process still holds it —
   *  never unlink a lock re-acquired by a newer process). */
  private releaseAccountLock(): void {
    if (this.lockFd === null) return;
    try {
      closeSync(this.lockFd);
    } catch {
      /* already closed */
    }
    this.lockFd = null;
    try {
      const lockPath = join(dirname(this.opts.credentialsPath), "pi-matrix.lock");
      const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (holder.pid === process.pid) unlinkSync(lockPath);
    } catch {
      /* gone or foreign holder — leave it */
    }
  }

  /** True when the holder pid is alive (EPERM = alive but not ours).
   *  No pid (corrupt lockfile) reads as stale. */
  private pidAlive(pid?: number): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Load the account-store credentials (token + the token's device id). */
  private loadCredentials(): { access_token?: string; device_id?: string } {
    try {
      return JSON.parse(readFileSync(this.opts.credentialsPath, "utf-8")) as {
        access_token?: string;
        device_id?: string;
      };
    } catch {
      return {};
    }
  }

  private normalizeBaseUrl(homeserver: string): string {
    const h = homeserver.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${h}`;
  }

  private async loadSdk(): Promise<SdkModule> {
    if (this.sdk) return this.sdk;
    const mod: SdkModule = await import("matrix-js-sdk");
    return mod;
  }

  /** Alias → `!` room id (a Matrix server quirk: aliases are rejected in
   *  room-path positions, so sends target the resolved id). */
  private async resolveRoom(ref?: string): Promise<string | undefined> {
    const r = ref ?? this.opts.roomId;
    if (r.startsWith("!")) return r;
    if (this.client === null) return undefined;
    try {
      const res = await this.client.getRoomIdForAlias(r);
      const id = (res as { room_id?: string }).room_id;
      return typeof id === "string" ? id : undefined;
    } catch (error) {
      this.logger.warn(`[matrix] sdk alias resolution failed for ${r}: ${error}`);
      return undefined;
    }
  }

  // ==========================================================================
  // Outbox ops (soft-fail: a failure is a `{ success: false, error }`,
  // never a throw into the caller)
  // ==========================================================================

  private async soft(op: string, fn: () => Promise<MatrixHttpResult>): Promise<MatrixHttpResult> {
    if (!this.available()) {
      return {
        success: false,
        error: "sdk transport unavailable (no access token / client not started)",
      };
    }
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(`[matrix] sdk ${op} failed: ${error}`);
      return { success: false, error: String(error) };
    }
  }

  private async postContent(
    content: Record<string, unknown>,
    threadRoot?: string,
  ): Promise<MatrixHttpResult> {
    const client = this.client!;
    const room = this.resolvedRoomId;
    if (!room) {
      return { success: false, error: `room ${this.opts.roomId} did not resolve to a room id` };
    }
    const res = threadRoot
      ? await client.sendMessage(room, threadRoot, content as never, undefined)
      : await client.sendMessage(room, content as never, undefined);
    // Shared-account self-drop: record the event id at SEND time so the
    // confirmed timeline copy of pi's own post dedupes like a re-delivery.
    // "Pi's own post" = sent through this outbox — NOT "sender ===
    // selfUserId": the human may share pi's login account (any account the
    // login picked), so a sender match would drop the human's messages too.
    if (typeof res.event_id === "string" && res.event_id) {
      this.seenEventIds.add(res.event_id);
      this.persistSeen();
    }
    return { success: true, eventId: res.event_id ?? "" };
  }

  async postThreadRoot(body: string, html?: string): Promise<MatrixHttpResult> {
    return this.soft("postThreadRoot", async () =>
      this.postContent({
        msgtype: "m.text",
        body,
        ...(html !== undefined ? { format: "org.matrix.custom.html", formatted_body: html } : {}),
        "m.thread": THREAD_MARKER,
      }),
    );
  }

  /** The flat room send (no thread marker, no thread relation). */
  async postMessage(body: string, html?: string): Promise<MatrixHttpResult> {
    return this.soft("postMessage", async () =>
      this.postContent({
        msgtype: "m.text",
        body,
        ...(html !== undefined ? { format: "org.matrix.custom.html", formatted_body: html } : {}),
      }),
    );
  }

  async postThreadReply(
    body: string,
    rootId: string,
    nestedRoot = false,
    html?: string,
  ): Promise<MatrixHttpResult> {
    return this.soft("postThreadReply", async () =>
      this.postContent(
        {
          msgtype: "m.text",
          body,
          ...(html !== undefined ? { format: "org.matrix.custom.html", formatted_body: html } : {}),
          ...(nestedRoot ? { "m.thread": THREAD_MARKER } : {}),
        },
        rootId,
      ),
    );
  }

  async editMessage(
    targetEventId: string,
    text: string,
    opts?: { threadRoot?: boolean; html?: string },
  ): Promise<MatrixHttpResult> {
    return this.soft("editMessage", async () =>
      this.postContent({
        msgtype: "m.text",
        body: "edited",
        "m.new_content": {
          msgtype: "m.text",
          body: text,
          ...(opts?.html !== undefined
            ? { format: "org.matrix.custom.html", formatted_body: opts.html }
            : {}),
          ...(opts?.threadRoot ? { "m.thread": THREAD_MARKER } : {}),
        },
        "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
      }),
    );
  }

  /**
   * Post a native Matrix poll (MSC3381 `org.matrix.msc3381.poll.start`,
   * extensible-events wire format) — one single-select question the room
   * clients render as tap-to-vote. Answers carry stable `id`s (the tap
   * answers by id, not by label); the mirror owns the id→label map.
   * Thread-routed when `threadRoot` is given (the js-sdk threadId overload
   * adds the m.thread relation). Caps enforced by the mirror's eligibility
   * check (2–10 options, 100-char labels); truncation here is the
   * last-resort guard (MSC3381: 255-char question, 100-char labels).
   */
  async sendPoll(
    question: string,
    answers: { id: string; label: string }[],
    threadRoot?: string,
    maxSelections = 1,
  ): Promise<MatrixHttpResult> {
    return this.soft("sendPoll", async () => {
      const client = this.client!;
      const room = this.resolvedRoomId;
      if (!room) {
        return { success: false, error: `room ${this.opts.roomId} did not resolve to a room id` };
      }
      const body = (s: string) => (s.length > 255 ? `${s.slice(0, 254)}…` : s);
      const label = (s: string) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
      const questionText = body(question);
      const content = {
        "org.matrix.msc3381.poll.start": {
          // kind is the namespaced value (observed 2026-10-13 in a working
          // Element X poll: "org.matrix.msc3381.poll.disclosed" — not the
          // bare spec value "disclosed").
          kind: "org.matrix.msc3381.poll.disclosed",
          question: {
            // Both text fields: the phone client (MSC1767-era) reads
            // org.matrix.msc1767.text; modern clients read body.
            "org.matrix.msc1767.text": questionText,
            body: questionText,
            msgtype: "m.text",
          },
          max_selections: maxSelections,
          answers: answers.map((a) => ({
            msgtype: "m.text",
            body: label(a.label),
            // MSC1767-era clients (observed on the phone client 2026-10-12:
            // its own polls carry answers with org.matrix.msc1767.text and
            // NO body) read the answer text from this field — without it
            // the poll renders empty/invisible there. Both fields are
            // additive; modern clients use body.
            "org.matrix.msc1767.text": label(a.label),
            id: a.id,
          })),
        },
        // Timeline fallback: clients that do not render the poll widget
        // show THIS plain text instead (observed in the working Element X
        // poll 2026-10-13: question + numbered answers). Without it the
        // event is invisible in the timeline on such clients.
        "org.matrix.msc1767.text":
          questionText +
          "\n" +
          answers.map((a, i) => `${i + 1}. ${label(a.label)}`).join("\n"),
      };
      const res = await client.sendEvent(
        room,
        threadRoot ?? null,
        "org.matrix.msc3381.poll.start" as never,
        content as never,
      );
      return { success: true, eventId: res.event_id ?? "" };
    });
  }

  /**
   * Cast pi's OWN vote on one of pi's polls (MSC3381
   * `org.matrix.msc3381.poll.response`). Terminal-side answers have no
   * room event of their own — this vote is what makes them VISIBLE in
   * the poll. Clients count each voter's most recent response, so
   * re-voting REPLACES pi's previous vote (empty `answers` retracts).
   * Flat `m.reference` like poll.end — the poll widget aggregates votes
   * by poll event id, no thread relation.
   */
  async sendPollVote(pollEventId: string, answers: string[], labels: string[]): Promise<MatrixHttpResult> {
    return this.soft("sendPollVote", async () => {
      const client = this.client!;
      const room = this.resolvedRoomId;
      if (!room) {
        return { success: false, error: `room ${this.opts.roomId} did not resolve to a room id` };
      }
      const content = {
        "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
        "org.matrix.msc3381.poll.response": { answers },
        // Timeline fallback for clients that do not render the vote widget
        // (labels, not the opaque answer ids, are what a human reads).
        "org.matrix.msc1767.text":
          answers.length > 0 ? `pi voted: ${labels.join(", ")}` : "pi withdrew the vote it cast for this poll.",
      };
      const res = await client.sendEvent(
        room,
        null,
        "org.matrix.msc3381.poll.response" as never,
        content as never,
      );
      return { success: true, eventId: res.event_id ?? "" };
    });
  }

  /**
   * Close one of pi's polls (MSC3381 `org.matrix.msc3381.poll.end`):
   * stops the vote so the room clients show it as ended instead of
   * accepting taps pi will ignore (the mirror is closed). The poll is
   * referenced via `m.relates_to` (m.reference), flat by design — no
   * thread relation (the stop resolves by poll event id).
   */
  async endPoll(pollEventId: string): Promise<MatrixHttpResult> {
    return this.soft("endPoll", async () => {
      const client = this.client!;
      const room = this.resolvedRoomId;
      if (!room) {
        return { success: false, error: `room ${this.opts.roomId} did not resolve to a room id` };
      }
      const res = await client.sendEvent(
        room,
        "org.matrix.msc3381.poll.end" as never,
        {
          "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
          "org.matrix.msc3381.poll.end": {},
          // MSC1767-era clients parse poll.end strictly (observed 2026-10-13:
          // "Unsupported event (org.matrix.msc3381.poll.end): missing field
          // 'org.matrix.msc1767.text'" on an end without it) — carry the end
          // text the MSC1767 draft carried.
          "org.matrix.msc1767.text": "Poll has ended",
        } as never,
      );
      return { success: true, eventId: res.event_id ?? "" };
    });
  }

  async setRoomTopic(topic: string): Promise<MatrixHttpResult> {
    return this.soft("setRoomTopic", async () => {
      const client = this.client!;
      const room = this.resolvedRoomId;
      if (!room) {
        return { success: false, error: `room ${this.opts.roomId} did not resolve to a room id` };
      }
      const res = await client.setRoomTopic(room, topic);
      return { success: true, eventId: res.event_id ?? "" };
    });
  }

  /**
   * Upload `data` and post it as an `m.file` event. With
   * `attachEncryption: "on"` (the default) the bytes are encrypted
   * MSC4125-v2 first — the VectorIM Element Web `isEncrypted` bug fix:
   * the `file` object carries `key`/`iv`/`hashes`, so the client's
   * MSC4125 decrypter has everything it runs (its
   * `isEncrypted === !!content.file` check always runs on m.file).
   */
  async sendFile(
    name: string,
    data: Buffer,
    contentType: string,
    body?: string,
    threadRoot?: string,
  ): Promise<MatrixHttpResult> {
    return this.soft("sendFile", async () => {
      const client = this.client!;
      const encrypt = (this.opts.attachEncryption ?? "on") === "on";
      let upload: Buffer;
      let fileExtra: Record<string, unknown> = {};
      let size = data.byteLength;
      if (encrypt) {
        const mod: { encryptAttachment?: (b: ArrayBuffer) => Promise<{ data: ArrayBuffer; info: Record<string, unknown> }> } =
          await import("matrix-encrypt-attachment");
        const encryptAttachment =
          mod.encryptAttachment ?? (mod as { default?: { encryptAttachment?: typeof mod.encryptAttachment } }).default?.encryptAttachment;
        if (!encryptAttachment) {
          return { success: false, error: "matrix-encrypt-attachment unavailable" };
        }
        // The Buffer may be a view over a pool — hand over an owned
        // ArrayBuffer (the classic slice bug).
        const owned = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const enc = await encryptAttachment(owned);
        upload = Buffer.from(enc.data);
        size = enc.data.byteLength;
        // IEncryptedFile = { key (JWK), iv, v, hashes } — spreads straight
        // into the m.file `file` object next to `url` (the exact shape
        // VectorIM's decryptAttachment reads).
        fileExtra = { ...enc.info };
      } else {
        upload = data;
      }
      const res = await client.uploadContent(upload, {
        type: contentType,
        name,
      });
      const mxc: string =
        (res as { content_uri?: string }).content_uri ??
        (res as { contentUri?: string }).contentUri ??
        "";
      if (!mxc) return { success: false, error: "media upload returned no content_uri" };
      return this.postContent(
        {
          msgtype: "m.file",
          body: body ?? name,
          filename: name,
          // The `info.size` is the CIPHERTEXT size (the client downloads
          // the uploaded bytes); `mimetype` stays the original type.
          info: { size, mimetype: contentType },
          file: { url: mxc, ...fileExtra },
        },
        threadRoot,
      );
    });
  }

  // ==========================================================================
  // Read side (the sync pipeline + on-demand reads)
  // ==========================================================================

  /**
   * Start sync-based delivery: `Room.timeline` events for the configured
   * room, normalized through the shared `parseMatrixEvent` and fed to
   * the same callbacks the poll loop feeds. The initial sync's backfill
   * is the seed round (baselined, never emitted — the poller's seed
   * semantics); live events emit. Idempotent.
   */
  startDelivery(callbacks: SdkDeliveryCallbacks): void {
    if (this.deliveryStarted || this.client === null) return;
    this.deliveryStarted = true;
    this.cbs = callbacks;
    this.loadSeen();
    const sdk = this.sdk!;
    const client = this.client;
    const selfUserId = this.opts.userId;

    const handle = (event: SdkMatrixEvent, isLive: boolean) => {
      // v42 keeps `event.event` as the RAW dict — for encrypted events it
      // stays `m.room.encrypted` forever; the decrypted plaintext lives in
      // `event.clearEvent` (MatrixEvent.setClearData). CRITICAL: `clearEvent`
      // is an IClearEvent ({ type, content, room_id? }) and does NOT carry
      // event_id / sender / origin_server_ts — those stay on the outer
      // envelope. Feed parseMatrixEvent the FULL event the way the SDK's own
      // getEffectiveEvent() does (outer + clear merged), else every E2EE
      // message silently drops on the `!event.event_id` guard (2026-10-09:
      // inbound dead the moment the room switched to E2EE). Plaintext events
      // have no clearEvent → the raw dict as-is.
      const outer = event.event as unknown as MatrixEvent;
      const clear = (event as unknown as { clearEvent?: Partial<MatrixEvent> })
        .clearEvent;
      const raw: MatrixEvent = clear ? { ...outer, ...clear } : outer;
      // Poll taps (MSC3381 responses, extensible wire format): the user's
      // vote on one of pi's decision polls. NOT a message — parseMatrixEvent
      // would null it; intercept here, run the same guard chain (send-record
      // drop, ~! temp ids, seen-id dedupe, seed baseline), then hand off on
      // its own callback (never onMessage, never bumpUnread). The tap
      // references the poll via m.relates_to (m.reference) and carries the
      // voted ANSWER IDS in the content key (legacy MSC1767 clients instead
      // put the labels in m.relates_to.selections — both shapes parse).
      if (
        raw.type === "org.matrix.msc3381.poll.response" ||
        raw.type === "m.poll.response" ||
        raw.type === "org.matrix.msc1767.poll.response"
      ) {
        const eventId = typeof raw.event_id === "string" ? raw.event_id : "";
        if (eventId.length === 0 || eventId.startsWith("~!")) return;
        if (this.seenEventIds.has(eventId)) return;
        this.seenEventIds.add(eventId);
        while (this.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
          const oldest = this.seenEventIds.values().next().value;
          if (oldest === undefined) break;
          this.seenEventIds.delete(oldest);
        }
        this.persistSeen();
        if (!isLive) {
          this.seedCount += 1;
          return;
        }
        const content = (raw.content ?? {}) as Record<string, unknown>;
        const relates = (content["m.relates_to"] ?? {}) as { event_id?: unknown; selections?: unknown };
        if (typeof relates.event_id !== "string") return;
        const extensible = (content["org.matrix.msc3381.poll.response"] ??
          content["m.poll.response"]) as { answers?: unknown } | undefined;
        const ids = Array.isArray(extensible?.answers)
          ? (extensible!.answers as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        const legacy = Array.isArray(relates.selections)
          ? (relates.selections as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        const refs = ids.length > 0 ? ids : legacy;
        if (refs.length === 0) return;
        this.logger.debug(
          `[matrix] sdk poll response ${eventId}: poll=${relates.event_id} refs=${JSON.stringify(refs)}`,
        );
        callbacks.onPollResponse?.({
          pollEventId: relates.event_id,
          refs,
          timestamp: raw.origin_server_ts ?? 0,
        });
        return;
      }
      const message = parseMatrixEvent(raw, selfUserId, this.opts.roomId);
      if (!message) return;
      // Self-drop by send record, not sender: the human may send from pi's
      // own login account (the shared-account setup, any account), so
      // sender === selfUserId marks the human's messages too. Pi's own
      // posts are the ones recorded at send time (postContent →
      // seenEventIds; their confirmed copies hit the re-delivery guard
      // below) plus ~! temp ids (js-sdk local echoes, always pi's own).
      if (message.eventId.startsWith("~!")) return;
      // Re-delivery guard (limited-sync resets can re-deliver backfill).
      if (this.seenEventIds.has(message.eventId)) return;
      this.seenEventIds.add(message.eventId);
      while (this.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest === undefined) break;
        this.seenEventIds.delete(oldest);
      }
      this.persistSeen();
      // Seed round: the initial-sync backfill (non-live events) is
      // baselined — remembered, never emitted (no cutover-day flood).
      if (!isLive) {
        this.seedCount += 1;
        return;
      }
      if (this.seeding) {
        this.seeding = false;
        callbacks.onSeedComplete?.(this.seedCount);
      }
      // Shared-account semantics: anything that survives the send-record
      // guards above is NOT a pi post, even when the sender is pi's own
      // user id (the human sharing the login account). The downstream
      // isFromPi gates (inbound injection, room-ux, reaction dispatch)
      // must treat it as user input.
      message.isFromPi = false;
      if (message.reactionKey !== undefined) {
        callbacks.onReaction(message);
        return;
      }
      callbacks.bumpUnread(this.opts.roomId, {
        ts: message.timestamp,
        preview: message.body,
        eventId: message.eventId,
        threadRoot: message.threadRoot,
        isThreadRoot: message.isThreadRoot,
      });
      callbacks.onMessage(message);
    };

    client.on(
      sdk.RoomEvent.Timeline as never,
      (event: SdkMatrixEvent, room: SdkRoom | undefined, _toStart: boolean | undefined, removed: boolean, data?: { liveEvent?: boolean }) => {
        if (removed) return;
        // Room-scoped: the client re-emits timeline events for every room.
        if (room && this.resolvedRoomId && room.roomId !== this.resolvedRoomId) return;
        const isLive = data?.liveEvent === true;
        const rawType = (event.event as unknown as { type?: string } | undefined)?.type;
        // Hop log: this line is the delivery-chain's first observable
        // link (2026-09-18: the whole chain was silent, so drops were
        // un-diagnosable). Absence of this line = the handler is not
        // seeing timeline events at all.
        this.logger.debug(
          `[matrix] sdk timeline: ${(event.event as { event_id?: string; sender?: string })?.event_id ?? "?"} ${rawType ?? "?"} live=${isLive} from=${(event.event as { sender?: string })?.sender ?? "?"}`,
        );
        // Decrypt-then-deliver: encrypted events enter the timeline as
        // `m.room.encrypted` — the WASM decrypts them async, in place.
        // Re-feed the pipeline on `Event.decrypted` (the SDK's own
        // pattern, rust-crypto.js processEvent), else parseMatrixEvent
        // sees `m.room.encrypted` and drops the message. Applies to
        // live AND backfill events (the 2026-09-18 `test123` case: a
        // message sent during the initial-sync window is backfill, not
        // live, and would otherwise be parsed encrypted + baselined).
        if (rawType === "m.room.encrypted") {
          const onDecrypted = (decrypted: SdkMatrixEvent, error?: unknown): void => {
            event.off(sdk.MatrixEventEvent.Decrypted as never, onDecrypted);
            if (!this.deliveryStarted) return; // stopped while decryption was pending
            const dec = (decrypted ?? event).event as unknown as { event_id?: string; origin_server_ts?: number };
            // Recent backfill: sent while this client was down → emit
            // (the seed-baseline gap); old backfill keeps baselining.
            const recentBackfill =
              !isLive &&
              typeof dec.origin_server_ts === "number" &&
              dec.origin_server_ts > Date.now() - BACKFILL_GRACE_MS;
            if (error) {
              // Old undecryptable backfill is already warn-stormed by
              // the rust layer — only surface the recent losses.
              if (isLive || recentBackfill) {
                this.logger.warn(
                  `[matrix] sdk: decryption failed for ${dec.event_id} — not delivered`,
                );
              }
              return;
            }
            this.logger.debug(
              `[matrix] sdk: decrypted ${dec.event_id} — feeding pipeline (live=${isLive} recent-backfill=${recentBackfill})`,
            );
            handle(decrypted ?? event, isLive || recentBackfill);
          };
          event.on(sdk.MatrixEventEvent.Decrypted as never, onDecrypted);
          return;
        }
        handle(event, isLive);
      },
    );

    // The seed baseline is complete once the first live event lands (or,
    // for a quiet room, when the sync loop has turned over once — the
    // onSeedComplete callback is best-effort bookkeeping, not a gate).
  }

  stopDelivery(): void {
    if (!this.deliveryStarted || this.client === null) return;
    const sdk = this.sdk!;
    this.client.removeAllListeners(sdk.RoomEvent.Timeline as never);
    this.deliveryStarted = false;
    this.cbs = null;
  }

  /**
   * Download a media resource (`mxc://server/mediaId[/filename]`) —
   * voice transcription. Plain `fetch` with the access
   * token instead of the SDK's `http.authedRequest` (that layer JSON
   * decodes non-error responses; binary media would not survive it).
   * E2EE rooms: the returned bytes are the SSS ciphertext when the
   * filename is `org.matrix.msc2666.v1` — the caller decides what to do
   * (the voice leg treats that as undecryptable on this device).
   */
  async downloadMedia(mxcUrl: string, timeoutMs = 30_000): Promise<Buffer | null> {
    if (!this.token) return null;
    if (!mxcUrl.startsWith("mxc://")) return null;
    // mxc://server/mediaId[/filename] — the download endpoint takes
    // serverName + mediaId only (no filename, no query).
    // ponytail: prefix-check + split instead of a regex — a regex literal
    // containing `//` breaks this codebase's jiti transpiler (ParseError).
    const path = mxcUrl.slice("mxc://".length).split("/").slice(0, 2).join("/");
    try {
      const res = await fetch(
        `${this.normalizeBaseUrl(this.opts.homeserver)}/_matrix/client/v1/media/download/${path}`,
        { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) {
        this.logger.warn(`[matrix] sdk: media download ${res.status} for ${mxcUrl}`);
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      this.logger.warn(`[matrix] sdk: media download failed: ${error}`);
      return null;
    }
  }

  /**
   * Read the latest N messages (newest `limit`, oldest → newest) for the
   * `matrix_get_messages` tool + backfill needs — via the SDK's own http
   * layer (token + auth handled by the SDK), then decrypted in place for
   * E2EE rooms (`readableEvents`). `dir:"b"` (backward from the tail) is
   * what makes it "the latest N" — `dir:"f"` would read from the room's
   * first events and miss the newest ones entirely.
   */
  async readMessages(limit: number = 10): Promise<MatrixMessage[]> {
    if (!this.available() || this.client === null || !this.resolvedRoomId) return [];
    try {
      const res = await this.client.http.authedRequest(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.resolvedRoomId)}/messages`,
        { dir: "b", limit },
        undefined,
        { prefix: "" },
      );
      return this.parseRawMessages(await this.readableEvents(res), limit);
    } catch (error) {
      this.logger.warn(`[matrix] sdk readMessages failed: ${error}`);
      return [];
    }
  }

  /** The summarizer's thread-delta read: newest-first, the caller filters to a thread. */
  async readTimeline(
    limit = 100,
  ): Promise<{ success: boolean; messages: ThreadDeltaMessage[]; error?: string }> {
    if (!this.available() || this.client === null || !this.resolvedRoomId) {
      return {
        success: false,
        messages: [],
        error: "sdk transport unavailable (no access token / client not started)",
      };
    }
    try {
      const res = await this.client.http.authedRequest(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(this.resolvedRoomId)}/messages`,
        { dir: "b", limit },
        undefined,
        { prefix: "" },
      );
      const messages = this.parseRawMessages(await this.readableEvents(res));
      return { success: true, messages };
    } catch (error) {
      this.logger.warn(`[matrix] sdk readTimeline failed: ${error}`);
      return { success: false, messages: [], error: String(error) };
    }
  }

  /**
   * Make one-shot `/messages` events readable (E2EE-aware) — the central
   * decrypt step every on-demand read goes through (readMessages +
   * readTimeline + the summarizer's room delta all ride it). A raw HTTP
   * chunk carries `m.room.encrypted` ciphertext in an encrypted room —
   * the one-shot read bypasses the sync pipeline's in-place decryption —
   * so each ciphertext event is decrypted here through the client's own
   * rust backend (the same OlmMachine the sync loop uses: one
   * decryption path, no second). `getEffectiveEvent()` yields "what it
   * would look like unencrypted": the decrypted dict for a ciphertext
   * event, a plain copy for plaintext. A standalone `new sdk.MatrixEvent`
   * (NOT `client.getEventMapper()`, which re-emits `Decrypted` on reused
   * in-room events and would re-fire the delivery pipeline's per-event
   * listeners → duplicate messages). Plaintext chunks (non-E2EE rooms,
   * test fakes) skip the crypto path entirely.
   */
  private async readableEvents(res: { chunk?: unknown[] }): Promise<unknown[]> {
    const chunk: unknown[] = Array.isArray(res?.chunk) ? (res.chunk as unknown[]) : [];
    if (!chunk.some((e) => (e as { type?: string })?.type === "m.room.encrypted")) {
      return chunk; // plaintext room / fake client: nothing to decrypt.
    }
    const client = this.client;
    const sdk = this.sdk;
    if (!client || !sdk) return chunk;
    const out: unknown[] = [];
    for (const raw of chunk) {
      if ((raw as { type?: string })?.type !== "m.room.encrypted") {
        out.push(raw);
        continue;
      }
      const ev = new sdk.MatrixEvent(raw as never);
      // Kick off the attempt (a no-op for plaintext) and await its
      // promise when in flight. Capped so a hung / undecryptable event
      // can't stall the read — it then reads back as ciphertext and is
      // dropped by parseMatrixEvent ("can't read what you can't
      // decrypt", matching the sync path's drop-on-decrypt-failure).
      try {
        const p = client.decryptEventIfNeeded(ev, { emit: false });
        await Promise.race([p, new Promise((r) => setTimeout(r, DECRYPT_WAIT_MS))]);
      } catch {
        // A decryption failure is a drop, not an error.
      }
      out.push(ev.getEffectiveEvent());
    }
    return out;
  }

  private parseRawMessages(
    events: unknown[],
    _limit?: number,
  ): (MatrixMessage & Partial<ThreadDeltaMessage>)[] {
    const out: (MatrixMessage & Partial<ThreadDeltaMessage>)[] = [];
    for (const raw of events) {
      const event = raw as unknown as MatrixEvent;
      const message = parseMatrixEvent(event, this.opts.userId, this.opts.roomId);
      if (message) out.push(message);
    }
    // Newest-first (dir=b) → oldest → newest for the message-shape read.
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /** Room members from post-sync state (the `roomState` op). */
  async roomMembers(): Promise<string[]> {
    if (!this.available() || this.client === null || !this.resolvedRoomId) return [];
    try {
      // v42: membership is post-sync room state — joined members directly.
      const room = this.client.getRoom(this.resolvedRoomId);
      return (room?.getJoinedMembers() ?? [])
        .map((m) => m.userId)
        .filter((u): u is string => u !== undefined);
    } catch (error) {
      this.logger.warn(`[matrix] sdk roomMembers failed: ${error}`);
      return [];
    }
  }

  /** The connected room's real encryption state (room-state source of truth). */
  isRoomEncrypted(): boolean | undefined {
    if (!this.available() || this.client === null || !this.resolvedRoomId) return undefined;
    try {
      const room = this.client.getRoom(this.resolvedRoomId);
      if (!room) return undefined;
      return !!room.currentState.getStateEvents("m.room.encryption", "");
    } catch {
      return undefined;
    }
  }

  /** Room ids + aliases for the alias resolver. */
  async roomInfo(): Promise<{ rooms: Array<{ room_id?: string; alias?: string | null }> }> {
    if (!this.available() || this.client === null) return { rooms: [] };
    try {
      const rooms = this.client
        .getRooms()
        .filter((r) => r.getMyMembership() === "join")
        .map((r) => ({
          room_id: r.roomId,
          alias: r.getCanonicalAlias() ?? null,
        }));
      return { rooms };
    } catch (error) {
      this.logger.warn(`[matrix] sdk roomInfo failed: ${error}`);
      return { rooms: [] };
    }
  }
}

/**
 * Build an `SdkOutbox` for a `MatrixConfig`-shaped input. The config
 * fields (transport-and-state.md): `e2ee`, `attachEncryption`, `cryptoStoreDir`,
 * `deviceId`, `syncTimeoutMs` + the identity/room fields every transport
 * needs.
 */
export function createSdkOutbox(config: {
  homeserver?: string;
  userId?: string;
  roomId: string;
  credentialsPath: string;
  deviceId?: string;
  e2ee?: "on" | "off";
  attachEncryption?: "on" | "off";
  cryptoStoreDir?: string;
  storePassphrase?: string;
  syncTimeoutMs?: number;
  logPath?: string;
  /** Seen-event-id persistence file (dedupe across reconnects). */
  seenPath?: string;
  logger?: MatrixLogger;
}): SdkOutbox {
  return new SdkOutbox({
    homeserver: config.homeserver ?? "",
    userId: config.userId ?? "",
    roomId: config.roomId,
    credentialsPath: config.credentialsPath,
    deviceId: config.deviceId,
    e2ee: config.e2ee,
    attachEncryption: config.attachEncryption,
    cryptoStoreDir: config.cryptoStoreDir,
    storePassphrase: config.storePassphrase,
    syncTimeoutMs: config.syncTimeoutMs,
    logPath: config.logPath,
    seenPath: config.seenPath,
    logger: config.logger,
  });
}
