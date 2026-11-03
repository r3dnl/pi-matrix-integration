/**
 * MSC4108 (2025 variant, MSC4388) QR login — feature toggle `qr2025`
 * (default off). configuration-and-room-behaviour.md–configuration-and-room-behaviour.md
 *
 * ISOLATION: this module is only imported dynamically by src/login.ts when
 * the toggle is on. The three vendored files (src/qr2025/*.ts, js-sdk PoC
 * PR 5219) are its only new code; no other extension file changed.
 *
 * Prerequisites (all checked at probe time, configuration-and-room-behaviour.md):
 *   - Synapse `experimental_features.msc4388_mode: open` (our terminal is
 *     the NEW device creating the rendezvous; `authenticated` mode refuses
 *     unauthenticated creation).
 *   - MAS (delegated OIDC) with the device authorization grant (MAS >= 0.8).
 *   - @matrix-org/matrix-sdk-crypto-wasm exposing `HpkeRecipientChannel`
 *     (the MSC4388 secure-channel HPKE). Absent in every published snapshot
 *     as of 2026-10-09 — when missing, the probe reports it and the QR
 *     branch self-disables; the credentials path is untouched.
 *
 * ponytail: v1 is QR generation only (the new-device role — no scanning),
 * a static QR pane (Esc cancels), and the secrets bundle is NOT imported
 * (login + E2EE for new rooms work; old-message history stays locked until
 * a secrets import lands). Upgrade paths: overlay status component ,
 * secrets import, drop the vendored copy once js-sdk ships MSC4388.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import {
  ClientPrefix,
  MatrixClient,
  MatrixError,
  Method,
  OAuthGrantType,
  generateScope,
} from "matrix-js-sdk";
import type {
  DeviceAccessTokenResponse,
  ValidatedAuthMetadata,
} from "matrix-js-sdk/lib/oauth/index.js";
import {
  MSC4108FailureReason,
  RendezvousError,
} from "matrix-js-sdk/lib/rendezvous/index.js";
import {
  signInByGeneratingQR,
  type MSC4108v2025SignInWithQR,
} from "./MSC4108v2025SignInWithQR.js";
import type { LoginUi } from "../login.js";

// ===========================================================================
// Capability probe
// ===========================================================================

export type Qr2025Availability = { ok: true } | { ok: false; reason: string };

/** True when the installed crypto-wasm exposes the MSC4388 secure channel. */
export async function cryptoChannelAvailable(): Promise<boolean> {
  try {
    const w: any = await import("@matrix-org/matrix-sdk-crypto-wasm");
    await w.initAsync?.();
    return typeof w.HpkeRecipientChannel === "function";
  } catch {
    return false;
  }
}

function makeClient(homeserver: string, fetchImpl: typeof fetch): MatrixClient {
  return new MatrixClient({ baseUrl: homeserver, fetchFn: fetchImpl });
}

/**
 * configuration-and-room-behaviour.md capability probe (order: MAS metadata → MSC4388 discovery → local
 * crypto). Each failure returns an actionable reason, not an error.
 */
export async function isQr2025Available(
  homeserver: string,
  fetchImpl?: typeof fetch,
  /** Test hook: override the local crypto check (the real one imports the
   *  installed crypto-wasm, which tests cannot fake). */
  opts?: { cryptoChannel?: boolean },
): Promise<Qr2025Availability> {
  const fetchFn = fetchImpl ?? fetch;
  if (opts?.cryptoChannel === undefined && !(await cryptoChannelAvailable())) {
    return {
      ok: false,
      reason:
        "crypto-wasm lacks the MSC4388 HPKE bindings (HpkeRecipientChannel) — blocked on @matrix-org/matrix-sdk-crypto-wasm publishing them; credentials login is unaffected",
    };
  }
  const client = makeClient(homeserver, fetchFn);
  try {
    const metadata = await client.getAuthMetadata();
    if (!metadata.grant_types_supported.includes(OAuthGrantType.DeviceAuthorization)) {
      return {
        ok: false,
        reason: "server has no delegated OIDC with device authorization (MAS) — credentials only",
      };
    }
    try {
      const body = await client.http.request<{ create_available?: boolean }>(
        Method.Get,
        "/io.element.msc4388/rendezvous",
        undefined,
        undefined,
        { prefix: ClientPrefix.Unstable },
      );
      return typeof body.create_available === "boolean" && body.create_available
        ? { ok: true }
        : {
            ok: false,
            reason: "server reports rendezvous creation unavailable (msc4388_mode)",
          };
    } catch (e) {
      if (e instanceof MatrixError && e.httpStatus === 404) {
        return {
          ok: false,
          reason:
            "MSC4388 rendezvous disabled on the server — set experimental_features.msc4388_mode: open",
        };
      }
      if (e instanceof MatrixError && e.httpStatus === 401) {
        return {
          ok: false,
          reason:
            "server runs msc4388_mode: authenticated — QR login needs `open` mode (the new device is unauthenticated)",
        };
      }
      throw e;
    }
  } finally {
    try {
      client.stopClient();
    } catch {
      // stopping a never-started client is a no-op
    }
  }
}

// ===========================================================================
// QR rendering  + DAG plumbing 
// ===========================================================================

/** Binary payload → terminal half-blocks (error correction Q, configuration-and-room-behaviour.md payload).
 *  qrcode 1.5.x has no sync terminal renderer (toString is async), so the
 *  half-blocks are rendered from the module matrix (QRCode.create). One
 *  module = one pixel; quiet zone 4 modules; rows padded to an even count
 *  for the half-block pairing. */
export function renderQr2025(code: Uint8Array): string {
  const QR: any = (QRCode as any).create ? (QRCode as any) : (QRCode as any).default;
  const matrix: any = QR.create(
    [{ data: Array.from(code), mode: "byte" }],
    { errorCorrectionLevel: "Q" },
  );
  const size = matrix.modules.size;
  const data: Uint8Array = matrix.modules.data;
  const quiet = 4;
  const scale = 2; // jsQR's finder detection is unreliable at 1px/module
  const width = (size + quiet * 2) * scale;
  const height = width + (width % 2 === 0 ? 0 : 1);
  const px: boolean[] = new Array(width * height).fill(false);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!data[my * size + mx]) continue;
      const ox = (mx + quiet) * scale;
      const oy = (my + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          px[(oy + dy) * width + (ox + dx)] = true;
        }
      }
    }
  }
  let out = "";
  for (let y = 0; y < height; y += 2) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const top = px[y * width + x];
      const bottom = px[(y + 1) * width + x];
      row += top && bottom ? "█" : bottom ? "▄" : top ? "▀" : " ";
    }
    out += row + "\n";
  }
  return out;
}

/** RFC 7591 dynamic client registration against the MAS (configuration-and-room-behaviour.md, verified live
 *  on a MAS-enabled server). The client id is persisted under `state/oauth-client-id` so a
 *  re-login reuses it (arbitrary client ids are rejected by the MAS). */
export async function getOrRegisterClientId(
  masBaseUrl: string,
  fetchImpl: typeof fetch,
  stateDir?: string,
): Promise<string> {
  const file = stateDir ? join(stateDir, "oauth-client-id") : undefined;
  if (file) {
    try {
      const saved = readFileSync(file, "utf8").trim();
      if (saved) return saved;
    } catch {
      // first login on this machine
    }
  }
  const res = await fetchImpl(join(masBaseUrl.replace(/\/$/, ""), "oauth2/registration"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pi-matrix-integration",
      client_uri: "https://pi.dev/matrix-integration",
      redirect_uris: ["https://pi.dev/matrix-integration/qr-callback"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(`MAS client registration failed: ${body.error ?? `HTTP ${res.status}`}`);
  }
  if (file) {
    mkdirSync(stateDir!, { recursive: true });
    writeFileSync(file, body.client_id + "\n", { mode: 0o600 });
  }
  return body.client_id;
}

/** New device id for the DAG (uppercase alphanumerics, js-sdk style). */
export function makeDeviceId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** The token response carries no user_id  — ask the homeserver. */
async function whoami(
  homeserver: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(
    `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json().catch(() => ({}))) as { user_id?: string };
  if (!res.ok || !body.user_id) {
    throw new Error(`whoami failed: HTTP ${res.status}`);
  }
  return body.user_id;
}

// ===========================================================================
// The QR login flow (new-device role)
// ===========================================================================

export interface Qr2025LoginDeps {
  ui: LoginUi;
  homeserver: string;
  fetchImpl?: typeof fetch;
  /** The `state/` dir for the registered client id (configuration-and-room-behaviour.md). */
  stateDir?: string;
}

export type Qr2025Result =
  | { ok: true; user_id: string; device_id: string; access_token: string }
  | { ok: false; cancelled: boolean; error?: string };

/**
 * Run the 2025 QR flow against the homeserver: generate the code, render it
 * (the pane stays open until the user closes it), wait for scan + protocol,
 * run the device authorization grant, and complete the login. Esc in the
 * pane cancels. The result feeds the shared login tail (room → toggles →
 * save → config) exactly like the credentials path.
 */
export async function runQr2025Login(deps: Qr2025LoginDeps): Promise<Qr2025Result> {
  const { ui, homeserver } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const client = makeClient(homeserver, fetchImpl);
  let flow: MSC4108v2025SignInWithQR | undefined;
  try {
    flow = await signInByGeneratingQR(client, () => {
      /* surfaced via the thrown RendezvousError + the notify below */
    });
    const code = flow.code;
    if (!code) {
      return { ok: false, cancelled: false, error: "QR code generation failed" };
    }
    ui.notify("Scan the QR code with Element on your phone (same homeserver).", "info");
    if (!ui.display) {
      // ponytail: a headless/UI-less LoginUi cannot show the pane — the QR
      // text is still delivered via notify so a human can transcribe it.
      ui.notify(renderQr2025(code), "info");
    }
    const pane = ui.display?.(renderQr2025(code));
    let escaped = false;
    const paneClosed = pane
      ? pane.then((v) => {
          if (v == null && !escaped) {
            escaped = true;
            // Esc → cancel the in-flight flow so the pending step rejects.
            flow?.cancel(MSC4108FailureReason.UserCancelled).catch(() => {});
          }
          return v;
        })
      : Promise.resolve(null);
    try {
      ui.notify("Waiting for a scan…", "info");
      await flow.negotiateProtocols();
      ui.notify("Scanned. Waiting for confirmation on your phone…", "info");
      const metadata: ValidatedAuthMetadata = await client.getAuthMetadata();
      const clientId = await getOrRegisterClientId(
        metadata.base_url ?? homeserver,
        fetchImpl,
        deps.stateDir,
      );
      const deviceId = makeDeviceId();
      const dag = await flow.deviceAuthorizationGrant({ metadata, clientId, deviceId });
      if (dag.userCode) {
        ui.notify(`Confirm on your phone with code ${dag.userCode}`, "info");
      }
      const token = await flow.completeLoginOnNewDevice({ clientId });
      if (!token || !(token as DeviceAccessTokenResponse).access_token) {
        const err =
          token && "error" in (token as Record<string, unknown>)
            ? String((token as Record<string, unknown>).error)
            : "no access token returned";
        return { ok: false, cancelled: escaped, error: `device authorization failed: ${err}` };
      }
      const user_id = await whoami(homeserver, token.access_token, fetchImpl);
      await paneClosed;
      if (escaped) {
        return { ok: false, cancelled: true };
      }
      ui.notify("Login complete.", "info");
      return { ok: true, user_id, device_id: deviceId, access_token: token.access_token };
    } catch (err) {
      await paneClosed.catch(() => {});
      if (escaped) {
        return { ok: false, cancelled: true };
      }
      const reason =
        err instanceof RendezvousError
          ? `${err.message}${err.reason ? ` (${err.reason})` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      ui.notify(`QR login failed: ${reason}`, "error");
      return { ok: false, cancelled: false, error: reason };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ui.notify(`QR login failed: ${reason}`, "error");
    return { ok: false, cancelled: false, error: reason };
  } finally {
    try {
      await flow?.close();
    } catch {
      // closing an already-closed flow is a no-op
    }
    try {
      client.stopClient();
    } catch {
      // stopping a never-started client is a no-op
    }
  }
}
