/**
 * Shared thread metadata + event normalization
 * (transport-and-state.md: "factor it into one shared
 * extractThreadMeta(event) helper ... so the mtx-branch and
 * matrix-http-branch of the poll loop can never diverge on what a
 * root/reply is").
 *
 * That divergence guard still holds trivially: the mtx and matrix-http
 * poll transports are gone  and the one remaining transport
 * — the SdkOutbox sync pipeline — normalizes every raw timeline event
 * through `parseMatrixEvent` (this file), so the whole inbound stream
 * (including `m.reaction`) shares one definition of root/reply/flat and
 * `emitMessage` dispatch works unchanged.
 */

import type { MatrixEvent, MatrixMessage } from './types.js';

/** Thread grouping for one event:
 * - an event whose content carries the `m.thread` marker is a ROOT →
 *   its own conversation unit (`threadRoot` stays undefined; the root
 *   keys under its own event id in the unread model);
 * - an event with `m.relates_to { rel_type: "m.thread" }` (spec) or
 *   `org.matrix.msc1767.thread_root` (legacy MSC1767) is a REPLY →
 *   nested under its root;
 * - an event with neither is a FLAT message. */
export interface ThreadMeta {
  /** The thread root this reply belongs to (undefined for roots/flat). */
  threadRoot?: string;
  /** The event carries the `m.thread` marker (it is a root). */
  isThreadRoot: boolean;
}

/**
 * Extract thread meta from an event's content — the one shared definition
 * of root/reply/flat (spec + legacy MSC1767).
 */
export function extractThreadMeta(content: MatrixEvent['content']): ThreadMeta {
  const relatesTo = content?.['m.relates_to'];
  const threadRoot =
    relatesTo?.rel_type === 'm.thread' && typeof relatesTo.event_id === 'string'
      ? relatesTo.event_id
      : content?.['org.matrix.msc1767.thread_root'];
  return {
    threadRoot: typeof threadRoot === 'string' ? threadRoot : undefined,
    isThreadRoot: content?.['m.thread'] !== undefined,
  };
}

/**
 * Normalize one raw timeline event to `MatrixMessage` (or null when it
 * carries nothing emittable). The one normalizer of the sync pipeline:
 * - `m.reaction` → a reaction message (`reactionKey`/`parentEventId`,
 *   `04c1963`) that dispatches to `onReaction`, never `onMessage`;
 * - `m.room.message` → the ordinary message shape + thread meta;
 * - everything else (state, membership, ...) → null.
 *
 * `selfUserId` marks the single identity this extension logs in as (`isFromPi`);
 * `defaultRoomId` fills `roomId` when the event lacks one.
 */
export function parseMatrixEvent(
  event: MatrixEvent,
  selfUserId?: string,
  defaultRoomId?: string,
): MatrixMessage | null {
  if (!event || !event.event_id) {
    return null;
  }

  // Reactions (annotation relations): no `body` — the emoji is the
  // `m.relates_to` key. They dispatch to `onReaction` handlers, never
  // `onMessage` (04c1963).
  if (event.type === 'm.reaction') {
    const relatesTo = event.content?.['m.relates_to'];
    const key = relatesTo?.key;
    if (typeof key !== 'string' || key.length === 0) {
      return null;
    }
    return {
      eventId: event.event_id,
      sender: event.sender,
      body: key,
      reactionKey: key,
      parentEventId: typeof relatesTo?.event_id === 'string' ? relatesTo.event_id : undefined,
      timestamp: event.origin_server_ts || 0,
      roomId: event.room_id || defaultRoomId || '',
      isFromPi: event.sender === selfUserId,
    };
  }

  if (event.type !== 'm.room.message') {
    return null;
  }

  // Edit placeholder (m.replace: body "edited" + m.new_content): NOT a
  // message. Under the shared-account semantics every surviving @pi_agent
  // event is injected as user input (a sender-match would drop the
  // human's messages too), so a sibling pi session's edit would otherwise
  // show up in the terminal as a literal "edited" chat line. Dropping it
  // here also keeps the read tools from surfacing placeholder rows.
  if (event.content?.['m.new_content'] !== undefined) {
    return null;
  }

  const body = event.content?.body;
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }

  // Thread metadata: shared extraction.
  const meta = extractThreadMeta(event.content);

  // Media fields (voice transcription): carried when present —
  // the inbound funnel's voice leg keys on msgtype + mediaUrl. MSC4125
  // (encrypted attachments) puts the media URL in `content.file.url`, so
  // that wins over `content.url` when both exist.
  const content = event.content;
  const mediaUrl =
    typeof content?.file?.url === 'string' ? content.file.url : content?.url;

  return {
    eventId: event.event_id,
    sender: event.sender,
    body,
    formattedBody: event.content?.formatted_body,
    timestamp: event.origin_server_ts || 0,
    roomId: event.room_id || defaultRoomId || '',
    isFromPi: event.sender === selfUserId,
    threadRoot: meta.threadRoot,
    isThreadRoot: meta.isThreadRoot,
    msgtype: typeof content?.msgtype === 'string' ? content.msgtype : undefined,
    mediaUrl: typeof mediaUrl === 'string' ? mediaUrl : undefined,
    mediaInfo: content?.info,
    mediaFile: content?.file,
  };
}
