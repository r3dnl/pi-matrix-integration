/**
 * Pi Matrix Integration — Login dialogue core (configuration-and-room-behaviour.md).
 *
 * `saveCredentials`: the single writer of the accounts store
 * (`<credsDir>/<localpart>--<domain>/credentials.json`, dir 0700 / file 0600,
 * temp-file + rename). `probeLoginCapability` checks the homeserver's
 * `/_matrix/client/v3/login` flows. The QR method (2025 variant,
 * MSC4108/MSC4388) lives in src/qr2025 behind the `qr2025` toggle (default
 * off; configuration-and-room-behaviour.md) and feeds this same dialogue tail.
 * `runLoginDialogue` is the plain state machine: probe → homeserver →
 * username → password → login → save + live config. Failure/cancel discipline
 * : it never throws, and nothing is written before a successful login.
 *
 * Wiring (lifecycle / commands) is a later story — this module only exports
 * the four pieces.
 */

import { mkdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Input, Text } from "@earendil-works/pi-tui";
import { domainOf, localpartOf } from "./classify.js";
import type { ProjectRoomManifest } from "./types.js";
import { encryptionNotice } from "./encryption-status.js";

/** The four keys the credentials file carries — nothing else (transport-and-state.md schema). */
export interface Credentials {
  user_id: string;
  homeserver: string;
  device_id: string;
  access_token: string;
}

/**
 * Write the credentials file for `creds.user_id` under `credsDir` and return
 * the absolute file path. Account leaf name is `<localpart>--<domain>`
 * (`@vincent:example.com` → `vincent--example.com`). Dir 0700, file 0600,
 * atomic (tmp + rename in the same dir). Re-login overwrites idempotently.
 */
export function saveCredentials(credsDir: string, creds: Credentials): string {
  const { localpart, domain } = accountFromUserId(creds.user_id);
  const accountDir = join(credsDir, `${localpart}--${domain}`);
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  const file = join(accountDir, "credentials.json");
  // Mode on the tmp file (not a chmod after rename); umask can only
  // tighten it, never widen it.
  const tmp = join(accountDir, `credentials.json.${process.pid}.tmp`);
  const body: Record<string, string> = {
    access_token: creds.access_token,
    device_id: creds.device_id,
    homeserver: creds.homeserver,
    user_id: creds.user_id,
  };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** `@localpart:domain` → the account leaf pieces; a bare localpart keeps its own domain. */
function accountFromUserId(userId: string): { localpart: string; domain: string } {
  const localpart = localpartOf(userId);
  return { localpart, domain: domainOf(userId) ?? localpart };
}

/**
 * Normalize a homeserver address for the login probe: a bare domain
 * gets `https://` — Node `fetch` requires a scheme, so a bare host throws
 * "Failed to parse URL" and reads as "Homeserver unreachable". An explicit
 * scheme (`https://` or `http://`) is kept as-is. Empty stays empty (the
 * dialogue asks for the address first when nothing is prefilled).
 */
export function normalizeHomeserver(input: string): string {
  const s = input.trim();
  if (!s || /^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/**
 * note: an explicit `http://` input raises a stern warning (credentials
 * travel in the clear) but the address is still tried — a test network's
 * homeserver may legitimately speak http. One line, no confirm.
 */
function warnIfHttp(ui: LoginUi, raw: string): void {
  if (/^http:\/\//i.test(raw.trim())) {
    ui.notify(
      "Heads-up: http:// is not secure — Matrix homeservers should use https:// (credentials travel in the clear over http).",
      "warning",
    );
  }
}

/**
 * GET `{baseUrl}/_matrix/client/v3/login` and report capability:
 * `reachable` (the endpoint answered) + `password` (an `m.login.password`
 * flow exists). Network or parse errors → `{reachable: false, password: false}`
 * — never throws.
 */
export async function probeLoginCapability(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reachable: boolean; password: boolean }> {
  try {
    const res = await fetchImpl(`${baseUrl}/_matrix/client/v3/login`);
    const body = (await res.json()) as { flows?: unknown };
    const flows = Array.isArray(body?.flows) ? body.flows : [];
    const password = flows.some(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "m.login.password",
    );
    return { reachable: true, password };
  } catch {
    return { reachable: false, password: false };
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * First-run gate (configuration-and-room-behaviour.md): loadable = the file exists, parses, and
 * carries a non-empty `access_token`. Anything else → the dialogue.
 */
export function hasLoadableCredentials(credentialsPath?: string): boolean {
  if (!credentialsPath) return false;
  try {
    const data = JSON.parse(readFileSync(credentialsPath, "utf-8")) as { access_token?: unknown };
    return typeof data?.access_token === "string" && data.access_token !== "";
  } catch {
    return false;
  }
}

/**
 * Masked single-line input (configuration-and-room-behaviour.md step 3): `render()` shows one `•`
 * per character — the plaintext never appears in the rendered lines — while
 * `getValue()`/`setValue()` keep the real value and all key handling comes
 * free from `Input`.
 */
export class MaskedInput extends Input {
  /** The base class keeps `prompt` private; the masked render needs it. */
  private readonly promptText: string;
  constructor(value = "", options?: { prompt?: string }) {
    super(options ?? {});
    this.promptText = options?.prompt ?? "> ";
    this.setValue(value);
  }

  override render(width: number): string[] {
    const prompt = this.promptText;
    const availableWidth = width - prompt.length;
    if (availableWidth <= 0) return [prompt];
    // ponytail: full mask, no cursor glyph or horizontal scroll — the base
    // render's scroll math reads the real value, so it cannot be reused.
    const masked = this.getValue().replace(/./gu, "•");
    const shown = masked.length > availableWidth ? masked.slice(0, availableWidth) : masked;
    return [prompt + shown + " ".repeat(Math.max(0, availableWidth - shown.length))];
  }
}

/**
 * QR pane: static QR text + Esc cancels (configuration-and-room-behaviour.md v1 — the status overlay
 * is the upgrade path). pi TUI delivers keys via handleInput; bare Esc is
 * the escape byte.
 */
export class QrPane extends Text {
  onEscape?: () => void;
  handleInput(data: string): void {
    if (data === "\u001b") this.onEscape?.();
  }
}

/** The TUI surface the dialogue drives (adapter: `buildLoginUi`). */
export interface LoginUi {
  select(title: string, options: string[], initialIndex?: number): Promise<string | null>;
  input(title: string, placeholder?: string): Promise<string | null>;
  confirm(title: string): Promise<boolean>;
  notify(message: string, kind?: "info" | "warning" | "error"): void;
  /** Masked entry (the adapter renders a MaskedInput via ui.custom). */
  password(title: string): Promise<string | null>;
  /**
   * A dismissable text pane (the QR code, configuration-and-room-behaviour.md). Resolves null on
   * close/cancel. Optional: a UI without one degrades to notify-only QR.
   */
  display?(text: string): Promise<string | null>;
}

/** The pi ctx.ui surface the adapter builds on (core/extensions/types.d.ts). */
export interface PiUi {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
  ): Promise<T>;
}

/**
 * Adapter: pi `ctx.ui` → `LoginUi` (configuration-and-room-behaviour.md). A closed dialog (Esc) is
 * `undefined` in pi's API and maps to `null` (cancel); `password` renders
 * a `MaskedInput` through `ui.custom`, so the plaintext never passes
 * through a pi API that echoes its arguments.
 */
export function buildLoginUi(piUi: PiUi): LoginUi {
  return {
    select: async (title, options) => (await piUi.select(title, options)) ?? null,
    input: async (title, placeholder) => (await piUi.input(title, placeholder)) ?? null,
    confirm: async (title) => piUi.confirm(title, title),
    notify: (message, kind) => piUi.notify(message, kind),
    password: (title) =>
      piUi.custom<string | null>((_tui, _theme, _keybindings, done) => {
        const input = new MaskedInput("", { prompt: `${title}: ` });
        input.onSubmit = () => done(input.getValue());
        input.onEscape = () => done(null);
        return input;
      }),
    display: (text) =>
      piUi.custom<string | null>((_tui, _theme, _keybindings, done) => {
        const pane = new QrPane(text);
        pane.onEscape = () => done(null);
        return pane;
      }),
  };
}

export interface LoginDeps {
  ui: LoginUi;
  /** The accounts directory (credsDir for saveCredentials). */
  credsDir: string;
  /** Point the live config at the new credentials file. */
  updateConfig: (patch: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  /** One client per homeserver: login + the room ops the room step runs
   *  against the fresh token (configuration-and-room-behaviour.md). */
  makeLoginClient: (homeserver: string) => LoginClient;
  /** A login client that starts with the given access token — the QR path
   *  completes the login outside this client, so the room step gets a
   *  fresh one carrying the token (default: `makeLoginClient`). */
  makeLoginClientWithToken?: (homeserver: string, token: string) => LoginClient;
  homeserverPrefill?: string;
  usernamePrefill?: string;
  /** The configured room (alias if one is set) — the room step's proposal. */
  configuredRoomId?: string;
  /** e2ee toggle ("on"/"off"); room creation honours it (configuration-and-room-behaviour.md). */
  e2ee?: string;
  /** QR login (2025 variant) method offer (configuration-and-room-behaviour.md). Default off. */
  qr2025?: boolean;
  /** The `state/` dir — the QR flow persists its registered client id there. */
  stateDir?: string;
  /** Directory to save the project room manifest. */
  manifestDir?: string;
  /** Current working directory for the project. */
  cwd?: string;
}

/** The login response tail the shared tail below consumes. Typed locally:
 *  matrix-js-sdk loads lazily at runtime, so its own type is not imported. */
export interface LoginResponse {
  user_id: string;
  device_id: string;
  access_token: string;
}

/** The js-sdk surface the login + room steps drive (configuration-and-room-behaviour.md). */
export interface LoginClient {
  loginWithPassword(user: string, password: string): Promise<LoginResponse>;
  /** GET /directory/room/{alias} — resolves the alias; 404 when absent. */
  resolveRoomAlias(alias: string): Promise<{ room_id: string }>;
  createRoom(opts: { name: string; invite: string[]; isEncrypted: boolean }): Promise<{ room_id: string }>;
  /** True when an existing room carries `m.room.encryption`. undefined when
   *  unknown (e.g. private room state not readable pre-join). Optional: a
   *  client that cannot probe it omits the method and the join warning skips. */
  isRoomEncrypted?(roomId: string): Promise<boolean | undefined>;
  /** Claim the alias for the room (PUT /directory/room/{alias}). */
  setRoomAlias(roomId: string, alias: string): Promise<void>;
  /** Invite a user to a room by user ID. */
  invite(roomId: string, userId: string): Promise<void>;
}

export type LoginResult =
  | {
      ok: true;
      credentialsPath: string;
      user_id: string;
      device_id: string;
      roomId: string;
      /** The user accepted the introduction tour (configuration-and-room-behaviour.md). The caller runs it after connect. */
      tour: boolean;
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

// ===========================================================================
// Room selection (configuration-and-room-behaviour.md — propose + status + autocreate)
// ===========================================================================

/**
 * The alias domain part of a homeserver URL: scheme + trailing slashes
 * stripped, host:port kept (Matrix alias domains include the port, e.g.
 * `#x:localhost:8008`).
 */
export function homeserverDomain(homeserver: string): string {
  return homeserver.replace(/^https?:\/\//i, "").replace(/\/+$/, "").trim();
}

/**
 * Propose the room alias (configuration-and-room-behaviour.md step 1): the configured room alias when
 * one is set, else `#<project>:<domain>` (project = cwd basename — backlog
 * "default = pi project name"). A configured `!room_id` is not an alias,
 * so it falls back to the default.
 */
export function proposeRoomAlias(
  configuredRoomId: string | undefined,
  cwd: string,
  homeserver: string,
): string {
  if (configuredRoomId && configuredRoomId.startsWith("#")) return configuredRoomId;
  return `#${basename(cwd) || "pi"}:${homeserverDomain(homeserver)}`;
}

/** Canonicalize user input to `#name:domain` (configuration-and-room-behaviour.md step 2). */
export function normalizeRoomAlias(input: string, homeserver: string): string {
  let s = input.trim();
  if (!s) return `#${homeserverDomain(homeserver)}`;
  if (!s.startsWith("#")) s = `#${s}`;
  if (!s.includes(":")) s = `${s}:${homeserverDomain(homeserver)}`;
  return s;
}

/** js-sdk not-found (404 / M_NOT_FOUND / M_UNKNOWN) — the expected "absent". */
function isAliasNotFound(err: unknown): boolean {
  const e = err as { httpStatus?: number; errcode?: string; data?: { errcode?: string } };
  return e?.httpStatus === 404 || ["M_NOT_FOUND", "M_UNKNOWN"].includes(e?.errcode ?? "") || ["M_NOT_FOUND", "M_UNKNOWN"].includes(e?.data?.errcode ?? "");
}

export interface RoomStepDeps {
  ui: LoginUi;
  client: LoginClient;
  homeserver: string;
  /** The configured room alias (proposal prefill) — undefined → default. */
  configuredRoomId?: string;
  /** e2ee toggle ("on"/"off") — creation honours it; default "on". */
  e2ee?: string;
  /** The project cwd for the default proposal. */
  cwd?: string;
}

export type RoomStepResult =
  | { ok: true; roomId: string; alias: string; created: boolean; e2ee: "on" | "off" }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

export type InviteStepResult =
  | { ok: true; invited: string[] }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * The room selection step (configuration-and-room-behaviour.md): propose → check + status → autocreate
 * when absent. Enter re-runs the resolution after an edit; a creation failure
 * (403/429) notifies and asks again. The alias is returned for the
 * config `roomId` (persisted by the caller).
 */
export async function runRoomStep(deps: RoomStepDeps): Promise<RoomStepResult> {
  const { ui, client } = deps;
  const proposed = proposeRoomAlias(deps.configuredRoomId, deps.cwd ?? process.cwd(), deps.homeserver);
  // config `e2ee` is only the DEFAULT the create question pre-selects — it can
  // no longer force encryption on an existing room. The room's
  // real `m.room.encryption` state is the source of truth for everything else.
  const defaultEncrypt = (deps.e2ee ?? "on") === "on";
  for (;;) {
    const entered = await ui.input("Room name", proposed);
    if (entered == null) return { ok: false, cancelled: true };
    const alias = normalizeRoomAlias(entered, deps.homeserver);
    let existing: string | undefined;
    try {
      existing = (await client.resolveRoomAlias(alias)).room_id;
    } catch (err) {
      if (!isAliasNotFound(err)) return { ok: false, cancelled: false, error: errorText(err) };
    }
    if (existing) {
      ui.notify(`${alias} — exists`, "info");
      // Joining an existing room: encryption is whatever that room already is
      // (we cannot rewrite it here). Warn with the startup lock language when
      // it is NOT encrypted; reflect the real state in the returned e2ee.
      const enc = client.isRoomEncrypted
        ? await client.isRoomEncrypted(existing).catch(() => undefined)
        : undefined;
      if (enc === false) ui.notify(encryptionNotice(false), "warning");
      const e2ee: "on" | "off" = enc === undefined ? (defaultEncrypt ? "on" : "off") : enc ? "on" : "off";
      return { ok: true, roomId: existing, alias, created: false, e2ee };
    }
    ui.notify(`${alias} — does not exist (will be created)`, "info");
    // Encryption is a creation-time decision: a config flag
    // cannot enforce it on a room, so ask once, here, only when creating.
    const encChoice = await ui.select("Encrypt this room (end-to-end)?", defaultEncrypt
      ? TOGGLE_E2EE_OPTIONS
      : [TOGGLE_E2EE_OFF, TOGGLE_E2EE_OPTIONS[0]]);
    if (encChoice == null) return { ok: false, cancelled: true };
    const isEncrypted = encChoice !== TOGGLE_E2EE_OFF;
    try {
      // ponytail: no room-topic or preset wiring at creation (configuration-and-room-behaviour.md note);
      // the ThreadManager takes over from the normal connect.
      const { room_id } = await client.createRoom({
        // The room NAME is the alias local part (not the full alias).
        name: alias.replace(/^#/, "").split(":")[0],
        invite: [],
        isEncrypted,
      });
      await client.setRoomAlias(room_id, alias);
      ui.notify(`${alias} — created`, "info");
      if (!isEncrypted) ui.notify(encryptionNotice(false), "warning");
      return { ok: true, roomId: room_id, alias, created: true, e2ee: isEncrypted ? "on" : "off" };
    } catch (err) {
      ui.notify(errorText(err), "error");
      const retry = await ui.select("Room creation failed", ["retry", "cancel"]);
      if (retry !== "retry") return { ok: false, cancelled: true };
      continue;
    }
  }
}

/**
 * The invite step: after room creation, allow inviting other users.
 * Only runs when a new room was created (not when joining an existing room).
 * Returns the list of user IDs that were successfully invited.
 */
export async function runInviteStep(
  ui: LoginUi,
  client: LoginClient,
  roomId: string,
): Promise<InviteStepResult> {
  const invited: string[] = [];
  
  for (;;) {
    const userId = await ui.input("Invite user to room (by Matrix ID, e.g., @user:domain.com) — leave empty to skip", "");
    if (userId == null) return { ok: false, cancelled: true };
    
    if (!userId.trim()) {
      // Empty input means skip inviting
      break;
    }
    
    // Validate the user ID format
    if (!userId.trim().startsWith('@') || !userId.trim().includes(':')) {
      ui.notify("Invalid Matrix ID format. Should be @user:domain.com", "error");
      continue;
    }
    
    try {
      await client.invite(roomId, userId.trim());
      invited.push(userId.trim());
      ui.notify(`Invited ${userId.trim()} to the room`, "info");
      
      // Ask if they want to invite more users
      const choice = await ui.select("Invite another user?", ["Yes", "No"]);
      if (choice !== "Yes") break;
    } catch (err) {
      ui.notify(`Failed to invite ${userId.trim()}: ${errorText(err)}`, "error");
      const choice = await ui.select("Invite failed", ["retry", "skip", "cancel"]);
      if (choice === "cancel") return { ok: false, cancelled: true };
      if (choice === "skip") break;
      // retry will loop back to the input
    }
  }
  
  return { ok: true, invited };
}

/**
 * Generate and save a project room manifest.
 * Captures the room setup for the Pi agent project following a simplified
 * version of the matrix-accounts-py schema.
 */
export function saveProjectRoomManifest(
  manifestDir: string,
  manifest: ProjectRoomManifest,
): string {
  mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  const file = join(manifestDir, "project-room-manifest.json");
  const tmp = join(manifestDir, `project-room-manifest.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/**
 * Add .pi/ directories to .gitignore.
 * Checks if .gitignore exists, and if not, creates it.
 * Adds the rules if not already present.
 * Returns true if changes were made.
 */
export function addPiToGitignore(projectDir: string = process.cwd()): boolean {
  const gitignorePath = join(projectDir, '.gitignore');
  const rules = ['.pi/', '.pi/state'];
  
  let content = '';
  let changed = false;
  
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }
  
  for (const rule of rules) {
    if (!content.includes(rule)) {
      content += (content ? '\n' : '') + rule + '\n';
      changed = true;
    }
  }
  
  if (changed) {
    writeFileSync(gitignorePath, content, 'utf-8');
    return true;
  }
  
  return false;
}

/**
 * Ask user if they want to add .pi/ directories to .gitignore.
 * Returns true if the user agreed and the rules were added.
 */
export async function promptAddPiToGitignore(
  ui: LoginUi,
  projectDir: string = process.cwd(),
): Promise<boolean> {
  const answer = await ui.select(
    "Add .pi/ and .pi/state to .gitignore?",
    ["Yes", "No"]
  );
  
  if (answer === "Yes") {
    const changed = addPiToGitignore(projectDir);
    if (changed) {
      ui.notify("Added .pi/ and .pi/state to .gitignore", "info");
    } else {
      ui.notify(".gitignore already contains the required rules", "info");
    }
    return true;
  }
  
  return false;
}

/**
 * Create a project room manifest from login result and room info.
 */
export function createProjectRoomManifest(
  userId: string,
  deviceId: string,
  homeserver: string,
  roomId: string,
  roomAlias: string,
  invitedUsers: string[],
  config: { e2ee: string; threads: boolean; autoConnect: boolean },
): ProjectRoomManifest {
  return {
    apiVersion: "pi/v1",
    kind: "ProjectRoom",
    project: basename(process.cwd()) || "pi",
    homeserver: homeserverDomain(homeserver),
    roomAlias,
    roomId,
    userId,
    deviceId,
    invitedUsers: invitedUsers.length > 0 ? invitedUsers : undefined,
    createdAt: new Date().toISOString(),
    config: {
      e2ee: config.e2ee === "on",
      threads: config.threads,
      autoConnect: config.autoConnect,
    },
  };
}

// ===========================================================================
// Config toggles + onboarding tour (configuration-and-room-behaviour.md)
// ===========================================================================

// Exactly the three toggles onboarding asks (backlog intent), each with the
// default as the FIRST option and marked. Any answer other than the explicit
// non-default row maps to the default (so a scripted/odd answer never drops
// a setting).
export const TOGGLE_AUTOCONNECT_NO = "No — only via /matrix-connect";
export const TOGGLE_AUTOCONNECT_OPTIONS = ["Yes — connect automatically (default)", TOGGLE_AUTOCONNECT_NO];
export const TOGGLE_THREADS_FLAT = "Flat";
export const TOGGLE_THREADS_OPTIONS = ["Threaded (default)", TOGGLE_THREADS_FLAT];
export const TOGGLE_E2EE_OFF = "Off";
export const TOGGLE_E2EE_OPTIONS = ["On (default)", TOGGLE_E2EE_OFF];
export const TOUR_YES = "Yes — walk me through it";
export const TOUR_OPTIONS = [TOUR_YES, "No — skip for now"];

// The design's copy line for the threads toggle (Element X parity).
const THREADS_QUESTION =
  "Threaded or flat conversation structure?\n" +
  "Threaded mirrors Element's thread replies. Turn on 'Enable thread replies' in your Matrix client (Element X iOS: Settings → Labs) to see it the same way there.";

export type ToggleStepsResult =
  | { ok: true; autoConnect: boolean; threads: boolean; tour: boolean }
  | { ok: false; cancelled: true };

/**
 * The two config toggles + the tour offer (configuration-and-room-behaviour.md). One select per
 * toggle, default first and marked, then the tour offer. Esc/null at any
 * step cancels the whole dialogue (the caller writes nothing). Values are
 * returned for the caller to persist to the live config (existing keys).
 * E2EE is NOT asked here — it is a room-creation decision,
 * asked in runRoomStep only when a room is created, and persisted from there.
 */
export async function runToggleSteps(ui: LoginUi): Promise<ToggleStepsResult> {
  const a1 = await ui.select("Connect to Matrix automatically at Pi startup?", TOGGLE_AUTOCONNECT_OPTIONS);
  if (a1 == null) return { ok: false, cancelled: true };
  const autoConnect = a1 !== TOGGLE_AUTOCONNECT_NO;

  const a2 = await ui.select(THREADS_QUESTION, TOGGLE_THREADS_OPTIONS);
  if (a2 == null) return { ok: false, cancelled: true };
  const threads = a2 !== TOGGLE_THREADS_FLAT;

  const a3 = await ui.select("Run the introduction tour in the room?", TOUR_OPTIONS);
  if (a3 == null) return { ok: false, cancelled: true };
  const tour = a3 === TOUR_YES;

  return { ok: true, autoConnect, threads, tour };
}

/**
 * The onboarding tour prompt (configuration-and-room-behaviour.md): one canned directive telling the
 * agent to walk the room through the feature tour, sourced from the
 * matrix-help text (the same content the room sees from /matrix-help). The
 * agent posts the tour with its normal tools — no new content store.
 */
export function buildTourPrompt(helpContent: string): string {
  return [
    "Onboarding tour: you just finished onboarding in this Matrix room.",
    "Walk the room through this integration now — post a short, friendly introduction tour using your normal tools (matrix_send_milestone and ordinary messages). Keep it conversational: a few short messages, not a wall of text.",
    "Use the guide below as your source for what exists:",
    helpContent,
  ].join("\n");
}

/**
 * Run the credentials login dialogue. Esc/null at any step, or
 * "cancel" on the retry prompt, closes with `{ok:false, cancelled:true}` and
 * writes nothing. Login errors notify and re-ask the password only.
 */
export async function runLoginDialogue(deps: LoginDeps): Promise<LoginResult> {
  const { ui } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // configuration-and-room-behaviour.md: unreachable → one line; retry or cancel. Retry always offers the
  // homeserver input again, with the current value as its placeholder; an
  // empty submit (or Esc) cancels the dialogue, so a bad prefilled URL is
  // fixable instead of being re-probed forever.
  // note: the address is normalized (bare domain → https://) at every
  // entry point, and an explicit http:// raises a stern warning. If nothing
  // is prefilled, the dialogue ASKS FIRST instead of probing the empty URL
  // (the probe can never succeed against "" — that was the phantom
  // "Homeserver unreachable" warning on a fresh machine).
  // ponytail: if the user edits the address in the input step after a
  // successful prefill probe, the probe result is stale — a wrong server
  // fails loudly at login. (No re-probe of the edited value.)
  let homeserver = normalizeHomeserver(deps.homeserverPrefill ?? "");
  let userEntered = false;
  const applyEntered = (entered: string): string => {
    warnIfHttp(ui, entered);
    return normalizeHomeserver(entered);
  };
  if (!homeserver) {
    const entered = await ui.input("Matrix homeserver");
    if (entered == null || entered === "") return { ok: false, cancelled: true };
    homeserver = applyEntered(entered);
    userEntered = true;
  }
  let cap; // hoisted: the credentials fall-through below needs the last probe
  for (;;) {
    cap = await probeLoginCapability(homeserver, fetchImpl);
    if (cap.reachable && cap.password) break;
    if (!cap.reachable) {
      ui.notify("Homeserver unreachable — check the address and connection.", "warning");
      const choice = await ui.select("Homeserver unreachable", ["retry", "cancel"]);
      if (choice !== "retry") return { ok: false, cancelled: true };
      const entered = await ui.input("Matrix homeserver", homeserver);
      if (entered == null || entered === "") return { ok: false, cancelled: true };
      homeserver = applyEntered(entered);
      userEntered = true;
      continue;
    }
    if (!deps.qr2025) {
      ui.notify("Server has no password login (m.login.password).", "warning");
      return { ok: false, cancelled: false, error: "No password login flow on the homeserver" };
    }
    break; // qr2025 on + no password flow: only the QR method remains below
  }

  // The homeserver is only asked here when the user has not entered it yet
  // (a prefilled server is confirmed/edited, not re-asked). An empty entry
  // keeps the prefilled value (Enter = confirm) — never blank the address.
  if (!userEntered) {
    const entered = await ui.input("Matrix homeserver", homeserver);
    if (entered == null) return { ok: false, cancelled: true };
    homeserver = entered === "" ? homeserver : applyEntered(entered);
  }

  // Both methods produce the same login response; the tail (room → toggles
  // → save → config) is shared and runs exactly once.
  let response: LoginResponse | undefined;
  let roomClient: LoginClient | undefined; // the room step's authenticated client

  // QR method (2025 variant, MSC4108/MSC4388) — feature toggle `qr2025`
  // (default off, configuration-and-room-behaviour.md). Any probe failure or the user picking
  // credentials falls through to the password path unchanged.
  if (deps.qr2025) {
    try {
      // NOTE(strict): src/qr2025/ is vendored, read-only Matrix.org PoC code
      // whose own types target the UNPUBLISHED MSC4388 SDK (the KNOWN GAP in
      // its header; tools/check-vendored.mjs is the tripwire), so
      // tsconfig.json excludes it from the typecheck program. The variable
      // specifier keeps this import unanalyzed at compile time; jiti
      // resolves the same string at runtime. Qr2025Module mirrors the two
      // exports used here — the day check-vendored.mjs trips, delete the
      // vendored copy and import from the SDK directly.
      type Qr2025Module = {
        isQr2025Available(
          homeserver: string,
          fetchImpl?: typeof fetch,
          opts?: { cryptoChannel?: boolean },
        ): Promise<{ ok: true } | { ok: false; reason: string }>;
        runQr2025Login(deps: {
          ui: LoginUi;
          homeserver: string;
          fetchImpl?: typeof fetch;
          stateDir?: string;
        }): Promise<
          | { ok: true; user_id: string; device_id: string; access_token: string }
          | { ok: false; cancelled: boolean; error?: string }
        >;
      };
      const qrModule = "./qr2025/index.js";
      const qr: Qr2025Module = await import(qrModule);
      const avail = await qr.isQr2025Available(homeserver, fetchImpl);
      if (avail.ok) {
        const choice = await ui.select("Login method", [
          "scan a QR code",
          "enter credentials",
        ]);
        if (choice === "scan a QR code") {
          const r = await qr.runQr2025Login({ ui, homeserver, fetchImpl, stateDir: deps.stateDir });
          if (r.ok) {
            response = {
              user_id: r.user_id,
              device_id: r.device_id,
              access_token: r.access_token,
            };
            // The QR flow finished on its own client — the room step gets
            // a fresh one carrying the fresh token.
            roomClient = deps.makeLoginClientWithToken
              ? deps.makeLoginClientWithToken(homeserver, r.access_token)
              : deps.makeLoginClient(homeserver);
          } else if (!r.cancelled) {
            // A failed scan falls through to credentials (recoverable, transport-and-state.md);
            // a cancel ends the dialogue.
            ui.notify("Falling back to credentials.", "info");
          } else {
            return { ok: false, cancelled: true };
          }
        }
      } else {
        ui.notify(`QR login not available: ${avail.reason}`, "warning");
      }
    } catch (err) {
      ui.notify(`QR login unavailable (${errorText(err)}) — using credentials.`, "warning");
    }
  }

  if (response == null) {
    if (!cap.password) {
      // QR unavailable (probe reason notified above) and no password flow:
      // nothing to offer — fail fast instead of a doomed username prompt.
      ui.notify("No login method available on the homeserver.", "error");
      return { ok: false, cancelled: false, error: "No login method available on the homeserver" };
    }
    // One client per homeserver (configuration-and-room-behaviour.md) — created only when the
    // credentials path is actually taken (the QR path builds its own).
    const client = deps.makeLoginClient(homeserver);
    roomClient = client; // its loginWithPassword sets the token in place
    const username = await ui.input("Username", deps.usernamePrefill);
    if (username == null) return { ok: false, cancelled: true };
    // configuration-and-room-behaviour.md: bad password / unknown user → notify the error, back to the password.
    for (;;) {
      const password = await ui.password("Password");
      if (password == null) return { ok: false, cancelled: true };
      try {
        response = await client.loginWithPassword(username, password);
        break;
      } catch (err) {
        ui.notify(errorText(err), "error");
      }
    }
  }
  // Room selection (configuration-and-room-behaviour.md) against the fresh token, before anything is
  // written — a cancelled/failed room step discards the whole dialogue
  // (principle 2: nothing is written before the flow completes).
  const room = await runRoomStep({
    ui,
    client: roomClient ?? deps.makeLoginClient(homeserver),
    homeserver,
    configuredRoomId: deps.configuredRoomId,
    e2ee: deps.e2ee,
  });
  if (!room.ok) return room;
  
  // Invite step: only when a new room was created
  let invitedUsers: string[] = [];
  if (room.created) {
    const inviteResult = await runInviteStep(
      ui,
      roomClient ?? deps.makeLoginClient(homeserver),
      room.roomId,
    );
    if (!inviteResult.ok) return inviteResult;
    invitedUsers = inviteResult.invited;
  }
  
  // Config toggles + tour offer (configuration-and-room-behaviour.md) — after the room, before
  // anything is written. A cancel here discards the whole dialogue too
  // (principle 2). The e2ee value is persisted for the future; it does not
  // rewrite the room just created (note: issue 4 must not rewrite an
  // already-created room's encryption).
  const toggles = await runToggleSteps(ui);
  if (!toggles.ok) return toggles;
  const credentialsPath = saveCredentials(deps.credsDir, {
    user_id: response.user_id,
    homeserver,
    device_id: response.device_id,
    access_token: response.access_token,
  });
  deps.updateConfig({
    credentialsPath,
    roomId: room.alias,
    autoConnect: toggles.autoConnect,
    threads: toggles.threads,
    // e2ee now reflects the ROOM's real state (creation answer or joined-room
    // state), not a free-floating toggle.
    e2ee: room.e2ee,
  });
  
  // Save project room manifest  when a new room was created
  if (room.created && deps.manifestDir) {
    const manifest = createProjectRoomManifest(
      response.user_id,
      response.device_id,
      homeserver,
      room.roomId,
      room.alias,
      invitedUsers,
      { e2ee: room.e2ee, threads: toggles.threads, autoConnect: toggles.autoConnect },
    );
    saveProjectRoomManifest(deps.manifestDir, manifest);
  }
  
  // Ask about .gitignore rules 
  await promptAddPiToGitignore(ui, deps.cwd ?? process.cwd());
  
  ui.notify(
    `Logged in as ${response.user_id} in ${room.alias}. This device is unverified — end-to-end-encrypted rooms stay locked until you verify it (in Element or via QR login).`,
    "info",
  );
  return { ok: true, credentialsPath, user_id: response.user_id, device_id: response.device_id, roomId: room.alias, tour: toggles.tour };
}
