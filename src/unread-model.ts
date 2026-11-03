/**
 * Pi Matrix Integration - Unread model
 *
 * Port of the `mtx` account-store unread model (tools/mtx/mtx/unread.py,
 * transport-and-state.md) **plus the D1 thread dimension**
 * (TRANSPORT-DECISION D1, transport-and-state.md): one unread unit per conversation with new
 * activity, not one per event.
 *
 * D1 semantics (option B, settled): `total = new_flat_messages +
 * threads_with_new_replies`. A thread counts ONCE for any number of new
 * replies since the last clear; flat messages count per message; a new
 * thread root is a new conversation, so it counts as one unit like a flat
 * message. `clear()` wipes the flat counter AND the thread map.
 *
 * Structural deltas vs the Python model (phase 6 option A, documented):
 * - `since` is **per-room** (this extension is single-account, single-room
 *   per config), not account-level; it is a `number` (ms), matching
 *   Python's `int` so the cross-language shadow diff type-joins.
 * - `total` is the D1 conversation-unit count, not per-event counting.
 * - the `count?` per-thread reply counter (D1 option C, deferred) ships
 *   from day one — zero migration when a UI adopts it later.
 *
 * Invariants (the Python originals'): U-01 atomic save (tmp + replace),
 * U-04 idempotent watermark (`since` advances only past seen events), U-06
 * load degrades (absent/corrupt → empty), and never storing full bodies
 * (transport-and-state.md: count + a length-bounded, single-line preview only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** A one-line, length-bounded preview (never the full body, transport-and-state.md). */
export const PREVIEW_LIMIT = 80;

export const API_VERSION = 'pi-matrix/v1';
export const SCHEMA = 'pi-matrix/unread';
/** v3 = the Python v2 layout (per-room map + watermark) + the D1 thread map. */
export const VERSION = 3;

export function makePreview(body: string, limit: number = PREVIEW_LIMIT): string {
  const text = String(body).split(/\s+/).join(' ');
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

/** Per-thread unread entry (D1): keyed by thread root id. */
export interface ThreadUnread {
  lastTs: number;
  preview: string;
  /** Per-thread reply counter (D1 option C deferred; the field ships now). */
  count?: number;
}

/** One room's unread state: watermark + flat counter + D1 thread map. */
export interface RoomUnread {
  /** Watermark: the newest `origin_server_ts` (ms) already counted. */
  since: number;
  /** Unread flat (non-thread) messages since the last clear. */
  flat: number;
  /** D1: rootId → entry. Each present key is one "new conversation" unit. */
  threads: Map<string, ThreadUnread>;
}

/** One account's unread (this extension: single room per config). */
export class UnreadModel {
  rooms: Map<string, RoomUnread> = new Map();

  /** Get-or-create a room's unread entry (bump/clear mutate in place). */
  room(roomId: string): RoomUnread {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { since: 0, flat: 0, threads: new Map() };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** The room's persisted watermark (0 = never seeded). */
  sinceFor(roomId: string): number {
    return this.rooms.get(roomId)?.since ?? 0;
  }

  /** Set the room's watermark without touching the counters. */
  setSince(roomId: string, since: number): void {
    this.room(roomId).since = since;
  }

  /** D1 bump (TRANSPORT-DECISION D1, transport-and-state.md):
   * - a thread root (content carries `m.thread`) keys under its own event
   *   id — a new conversation, one unit;
   * - a reply (`threadRoot` set) keys under its root — the first reply
   *   since the last clear adds one unit; further replies update
   *   lastTs/preview/count only, never the total;
   * - anything else is a flat message: one unit per message.
   */
  bump(
    roomId: string,
    event: {
      ts: number;
      preview?: string;
      /** The event's own id (the key for new roots). */
      eventId?: string;
      /** The thread root this reply belongs to (spec `m.relates_to` or
       *  legacy MSC1767 `org.matrix.msc1767.thread_root`). */
      threadRoot?: string;
      /** The event carries the `m.thread` marker (it is a root). */
      isThreadRoot?: boolean;
    },
  ): void {
    const room = this.room(roomId);
    // Conversation-unit key: a root keys under its own event id (a new
    // conversation), a reply under its root (the first reply adds the
    // unit, later ones only update it). Same bookkeeping either way.
    const key = event.isThreadRoot ? (event.eventId ?? event.threadRoot ?? '') : event.threadRoot;
    if (key !== undefined && key !== "") {
      const existing = room.threads.get(key);
      if (existing) {
        existing.lastTs = event.ts;
        if (event.preview !== undefined) existing.preview = makePreview(event.preview);
        existing.count = (existing.count ?? 1) + 1;
      } else {
        room.threads.set(key, {
          lastTs: event.ts,
          preview: makePreview(event.preview ?? ''),
          count: 1,
        });
      }
    } else {
      room.flat += 1;
    }
    room.since = Math.max(room.since, event.ts);
  }

  /** Zero a room's unread (flat counter AND the D1 thread map; U-02).
   *  Other rooms are untouched; an unseen room is a no-op. The watermark
   *  (`since`) is NOT cleared — it is read progress, not unread state. */
  clear(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.flat = 0;
    room.threads.clear();
  }

  /** The D1 total for one room (the number the footer shows):
   *  one unit per flat message + one unit per thread with new replies
   *  since the last clear. */
  totalFor(roomId: string): number {
    const room = this.rooms.get(roomId);
    return room ? room.flat + room.threads.size : 0;
  }

  /** The D1 total across all rooms (the Python account-level property). */
  total(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.flat + room.threads.size;
    return n;
  }

  hasData(): boolean {
    return this.rooms.size > 0;
  }

  toDict(): Record<string, unknown> {
    const rooms: Record<string, unknown> = {};
    for (const [roomId, room] of this.rooms) {
      const threads: Record<string, unknown> = {};
      for (const [rootId, entry] of room.threads) {
        threads[rootId] = { lastTs: entry.lastTs, preview: entry.preview, count: entry.count ?? 1 };
      }
      rooms[roomId] = { since: room.since, flat: room.flat, threads };
    }
    return { apiVersion: API_VERSION, schema: SCHEMA, version: VERSION, rooms };
  }

  static fromDict(data: Record<string, unknown>): UnreadModel {
    const model = new UnreadModel();
    const rooms = (data.rooms ?? {}) as Record<
      string,
      { since?: number; flat?: number; threads?: Record<string, Partial<ThreadUnread>> }
    >;
    for (const [roomId, roomData] of Object.entries(rooms ?? {})) {
      const room = model.room(roomId);
      room.since = Number(roomData.since ?? 0);
      room.flat = Number(roomData.flat ?? 0);
      for (const [rootId, entry] of Object.entries(roomData.threads ?? {})) {
        room.threads.set(rootId, {
          lastTs: Number(entry.lastTs ?? 0),
          preview: String(entry.preview ?? ''),
          // toDict always writes a count; the reader defaults the same way
          // so the round-trip is stable.
          count: Number(entry.count ?? 1),
        });
      }
    }
    return model;
  }

  /** Load from disk. Absent/corrupt → empty (degradable, U-06: readers
   *  show "stale", never error). */
  static load(path: string): UnreadModel {
    let raw: string | undefined;
    try {
      if (!existsSync(path)) return new UnreadModel();
      raw = readFileSync(path, 'utf-8');
    } catch {
      return new UnreadModel();
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return new UnreadModel();
      return UnreadModel.fromDict(data);
    } catch {
      return new UnreadModel();
    }
  }

  /** Atomically write to disk (tmp + replace, U-01). A failed replace
   *  removes the temp file — no partial or leftover. */
  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const payload = JSON.stringify(this.toDict(), null, 2);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, payload, 'utf-8');
    try {
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* the temp is gone or unremovable — surface the original error */
      }
      throw error;
    }
  }
}
