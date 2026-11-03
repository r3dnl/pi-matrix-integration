/**
 * Pi Matrix Integration — Outbox seam .
 *
 * The transport surface `threading.ts` and the composition root code
 * against for room writes + state reads. The single transport
 * implementation is `SdkOutbox` (src/sdk-client.ts) — matrix-js-sdk ops
 * + MSC4125 attach encryption + E2EE (the legacy raw-HTTP matrix-http
 * client is deleted in phase 6).
 *
 * Every op keeps the `{ success, error }` soft-fail shape: a failed op never
 * throws into the caller (the poller's "no message is ever dropped"
 * contract).
 */
import type { MatrixMessage } from "./types.js";
import type { ThreadDeltaMessage } from "./summarize.js";

/**
 * Soft-fail op result shape shared by every Outbox op. Re-homed from
 * the legacy transport (deleted in phase 6) — the seam's canonical home
 * owns the type every op signature returns .
 */
export interface MatrixHttpResult {
  success: boolean;
  eventId?: string;
  error?: string;
  /** Media upload: the mxc uri the file was uploaded to. */
  mxc?: string;
}

export interface Outbox {
  /** True when the transport can reach the homeserver (token + started). */
  available(): boolean;

  /** Post a plain room message (no thread marker — the flat send). */
  postMessage(body: string, html?: string): Promise<MatrixHttpResult>;

  /** Post a thread root (`m.thread` marker). */
  postThreadRoot(body: string, html?: string): Promise<MatrixHttpResult>;

  /** Post an in-thread reply (spec `m.relates_to` thread relation). */
  postThreadReply(
    body: string,
    rootId: string,
    nestedRoot?: boolean,
    html?: string,
  ): Promise<MatrixHttpResult>;

  /** Edit our own event via `m.replace`. */
  editMessage(
    targetEventId: string,
    text: string,
    opts?: { threadRoot?: boolean; html?: string },
  ): Promise<MatrixHttpResult>;

  /** Read the room's recent timeline (newest-first, the summarizer's delta). */
  readTimeline(
    limit?: number,
  ): Promise<{ success: boolean; messages: ThreadDeltaMessage[]; error?: string }>;

  /** Update the room topic state event. */
  setRoomTopic(topic: string): Promise<MatrixHttpResult>;

  /** Upload `data` and post it as an `m.file` event (MSC4125 on the SDK path). */
  sendFile(
    name: string,
    data: Buffer,
    contentType: string,
    body?: string,
    threadRoot?: string,
  ): Promise<MatrixHttpResult>;

  /**
   * Read the room's recent messages (oldest → newest) for `/matrix-messages`
   * and the `matrix_get_messages` tool. The SdkOutbox serves it through the
   * SDK's own http layer; `[]` when unavailable (soft-fail).
   */
  readMessages(limit?: number): Promise<MatrixMessage[]>;

  /** Joined room-member user ids (post-sync room state on the SDK path). */
  roomMembers(): Promise<string[]>;

  /** Room ids + aliases, the shape the alias resolver consumes. */
  roomInfo(): Promise<{ rooms: Array<{ room_id?: string; alias?: string | null }> }>;

  /** True when the connected room carries `m.room.encryption`. Read live
   *  from room state (the source of truth), NOT from config. undefined when
   *  no room is resolved / not yet synced (the indicator hides itself). */
  isRoomEncrypted?(): boolean | undefined;
}
