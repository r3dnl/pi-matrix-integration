/**
 * Pi Matrix Integration - TUI Footer
 *
 * Formats the `[matrix]` status slot shown in the Pi terminal footer and
 * manages its set/clear lifecycle.
 *
 * Layout:
 *   `[💬 (env) user:domain/#room 🧵 on]`
 *
 *   💬 = connected, ✗ = down, … = connecting.
 *
 * The room URI follows the Matrix URI convention: the domain comes *before*
 * the room name (`user:domain/#room`), and each of the three parts — user,
 * domain, room — is rendered in its own text color (cyan / orange / green).
 * The footer renders these status strings raw, so the colors are embedded as
 * ANSI SGR codes directly (the same convention the built-in dim parts use).
 *
 * The thread indicator (🧵 on / faded 🧵 off) is read from a
 * `getThreadStatus` callback, which the caller points at the
 * `ThreadManager` in threading.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { domainOf, localpartOf } from "./classify.js";
import type { ConnectionStatus } from "./types.js";
import { encryptionBadge } from "./encryption-status.js";

/** The thread-routing status the footer renders (icon + on/off). */
export type ThreadStatus = { icon: string; enabled: boolean };

/** Configuration for a TuiFooter. */
export type TuiFooterConfig = {
  /** Whether the footer slot is managed at all. Defaults to true. */
  showInFooter?: boolean;
  /** Connected-state icon. Defaults to "💬" (hosts without a color-emoji
   *  font can set a safe character, e.g. "M" — the down state stays "✗"). */
  footerIcon?: string;
  /** Read the live thread-routing status for the 🧵 indicator. */
  getThreadStatus?: () => ThreadStatus;
  /** Read the connected room's real encryption state (true = E2EE). Omit or
   *  return undefined (no room / not yet synced) to hide the lock segment. */
  getRoomEncryption?: () => boolean | undefined;
};

/** ANSI SGR helpers — the footer renders status strings raw (verbatim). */
const cUser = (s: string): string => `\u001b[36m${s}\u001b[39m`; // cyan
const cDomain = (s: string): string => `\u001b[38;5;208m${s}\u001b[39m`; // orange (256-color)
const cRoom = (s: string): string => `\u001b[32m${s}\u001b[39m`; // green
const cEncOn = (s: string): string => `\u001b[32m${s}\u001b[39m`; // green  (encrypted)
const cEncOff = (s: string): string => `\u001b[31m${s}\u001b[39m`; // red     (plaintext)

/** ANSI dim/faint + reset — the "faded" rendering of the 🧵 off indicator. */
function dim(text: string): string {
  return `\u001b[2m${text}\u001b[22m`;
}

/**
 * Split a Matrix MXID into local part + domain (the shared extractors;
 * the domain spans a `:port`, so only `@user` without a domain returns
 * undefined).
 */
function splitMxid(id: string): { local: string; domain: string } | undefined {
  const domain = domainOf(id);
  return domain === undefined ? undefined : { local: localpartOf(id), domain };
}

/**
 * Local part of a room URI: `#alias:domain` / `!roomId:domain` →
 * `#alias` / `!roomId`. A bare value (no domain) is returned unchanged.
 * First colon: the alias/id never carries one, the domain may (`:port`).
 */
function roomLocalPart(uri: string): string | undefined {
  if (!uri) return undefined;
  const i = uri.indexOf(":");
  return i > 0 ? uri.slice(0, i) : uri;
}

/**
 * Formats the `[matrix]` footer slot for a TUI.
 */
export class TuiFooter {
  private config: {
    showInFooter: boolean;
    footerIcon: string;
    getThreadStatus?: () => ThreadStatus;
    getRoomEncryption?: () => boolean | undefined;
  };

  constructor(config: TuiFooterConfig = {}) {
    this.config = {
      showInFooter: config.showInFooter ?? true,
      footerIcon: config.footerIcon ?? "💬",
      getThreadStatus: config.getThreadStatus,
      getRoomEncryption: config.getRoomEncryption,
    };
  }

  /**
   * Set the matrix status slot in the footer from a connection status.
   * No-op when the footer is disabled.
   */
  update(ctx: ExtensionContext, status: ConnectionStatus): void {
    if (!this.config.showInFooter) {
      return;
    }
    ctx.ui.setStatus("matrix", this.formatStatus(status));
  }

  /**
   * Clear the footer status slot.
   */
  clear(ctx: ExtensionContext): void {
    ctx.ui.setStatus("matrix", undefined);
  }

  /**
   * Format connection status for footer display.
   */
  formatStatus(status: ConnectionStatus): string {
    // `[💬 user:domain/#room 🧵 on]`
    const state = status.connected ? this.config.footerIcon : "✗";
    const connecting = status.connecting ? "…" : "";
    let line = `${state}${connecting} ${this.formatRoomSegment(status)}`;
    if (!status.connected && status.lastError) {
      line += ` · ${status.lastError}`;
    }
    // Thread indicator: bright `🧵 on` when threading routes sends, faded
    // `🧵 off` (dim-ANSI) when it is toggled off. The dim wraps the whole
    // segment, not just the icon: many terminals can't dim color-emoji, but
    // they always dim the text label, so the faded state stays readable.
    const threads = this.config.getThreadStatus?.();
    if (threads) {
      const seg = `${threads.icon} ${threads.enabled ? "on" : "off"}`;
      line += ` ${threads.enabled ? seg : dim(seg)}`;
    }
    // Lock segment: green 🔒 encrypted / red 🔓 plaintext. Only when connected
    // and the room's encryption state is known (undefined = no room yet /
    // not synced → hide, do not alarm).
    if (status.connected) {
      const enc = this.config.getRoomEncryption?.();
      if (enc !== undefined) {
        const b = encryptionBadge(enc);
        const seg = `${b.icon} ${b.label}`;
        line += ` ${enc ? cEncOn(seg) : cEncOff(seg)}`;
      }
    }
    return `[${line}]`;
  }

  /**
   * The Matrix URI part of the footer: `user:domain/#room`, each part in its
   * own color (user cyan, domain dim, room green). Falls back to the plain,
   * uncolored room URI when the user identity is unavailable.
   */
  private formatRoomSegment(status: ConnectionStatus): string {
    const user = status.userId ? splitMxid(status.userId) : undefined;
    const room = roomLocalPart(status.roomUri);
    const domain = user?.domain ?? splitMxid(status.roomUri)?.domain;

    // No user identity → fall back to the raw room URI (old layout).
    if (!user || !room || !domain) {
      return this.truncate(status.roomUri || user?.local || "");
    }

    return `${cUser(user.local)}:${cDomain(domain)}/${cRoom(this.truncate(room))}`;
  }

  /**
   * Truncate a value for footer display. Room IDs keep their head + tail;
   * aliases keep the leading part.
   */
  private truncate(value: string): string {
    if (value.length <= 30) {
      return value;
    }
    if (value.startsWith("!")) {
      return `${value.substring(0, 10)}...${value.substring(value.length - 10)}`;
    }
    return value.substring(0, 27) + "...";
  }
}

/**
 * Create a TuiFooter.
 */
export function createTuiFooter(config: TuiFooterConfig = {}): TuiFooter {
  return new TuiFooter(config);
}
