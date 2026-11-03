/**
 * Pi Matrix Integration — Outbox seam.
 *
 * The transport surface `threading.ts` and the composition root code
 * against for room writes + state reads. The single transport
 * implementation is `SdkOutbox` (src/sdk-client.ts) — matrix-js-sdk ops
 * + MSC4125 attach encryption + E2EE (the legacy raw-HTTP matrix-http
 * client was deleted; this seam is all that remains).
 *
 * No op throws into the caller — the "no message is ever dropped" contract
 * this seam owns. Result-returning ops report the soft-fail shape
 * `{ success, error }`; the collection reads answer with an empty value
 * instead (`readMessages` and `roomMembers` -> `[]`, `roomInfo` ->
 * `{ rooms: [] }`).
 */
import type { MatrixMessage } from "./types.js";
import type { ThreadDeltaMessage } from "./summarize.js";

/**
 * Soft-fail op result shape shared by the result-returning Outbox ops.
 * Named for the seam that owns it; every op signature returns this, and the
 * transport behind every one of them is matrix-js-sdk.
 */
/** The thread-delta read: a soft-fail answers with `error` and an empty list
 *  (a read on this seam never throws). */
export interface TimelineRead {
  success: boolean;
  messages: ThreadDeltaMessage[];
  error?: string;
}

export interface OutboxResult {
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
  postMessage(body: string, html?: string): Promise<OutboxResult>;

  /** Post a thread root (`m.thread` marker). */
  postThreadRoot(body: string, html?: string): Promise<OutboxResult>;

  /** Post an in-thread reply (spec `m.relates_to` thread relation). */
  postThreadReply(
    body: string,
    rootId: string,
    nestedRoot?: boolean,
    html?: string,
  ): Promise<OutboxResult>;

  /** Edit our own event via `m.replace`. */
  editMessage(
    targetEventId: string,
    text: string,
    opts?: { threadRoot?: boolean; html?: string },
  ): Promise<OutboxResult>;

  /** Read the room's recent timeline (newest-first, the summarizer's delta). */
  readTimeline(limit?: number): Promise<TimelineRead>;

  /** Update the room topic state event. */
  setRoomTopic(topic: string): Promise<OutboxResult>;

  /** Upload `data` and post it as an `m.file` event (MSC4125 on the SDK path). */
  sendFile(
    name: string,
    data: Buffer,
    contentType: string,
    body?: string,
    threadRoot?: string,
  ): Promise<OutboxResult>;

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
