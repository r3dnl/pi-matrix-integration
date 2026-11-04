/**
 * Thin Matrix client-server API helper for the live scenario suite.
 *
 * This is the suite's INDEPENDENT READER: scenarios act through the real
 * extension seams, then assert on what this helper fetches from the homeserver
 * (messages, thread, edited state). Never on internal variables — internal
 * state assertions passed while the room showed nothing, which is the failure
 * mode behind the summary-loop incident in the project history.
 *
 * Credentials come from the environment only (live-tier discipline): the
 * primary account logs in with a password or presents a token; the second
 * account (the "human" in receive scenarios) needs a token or a password.
 *
 * No internal hostnames here: everything derives from PI_MATRIX_* at run
 * time; examples in docs use matrix.example.org.
 */

export class RoomApi {
  /**
   * @param {string} homeserver base URL, e.g. https://matrix.example.org
   */
  constructor(homeserver) {
    this.hs = homeserver.replace(/\/+$/, "");
    this.token = null;
    this.userId = null;
  }

  async #req(method, path, body, opts = {}) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (this.token && !opts.noAuth) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${this.hs}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok && !opts.allowNonOk) {
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return json;
  }

  /** Password login (m.login.password). MAS-shaped responses fall back to whoami. */
  async loginWithPassword(username, password) {
    const j = await this.#req("POST", "/_matrix/client/v3/login", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
    });
    this.token = j.access_token;
    this.userId = j.user_id ?? (await this.whoami());
    if (!this.userId) this.userId = `@${username}:${new URL(this.hs).host}`;
    return this;
  }

  /** Token login: whoami supplies the user id. */
  static async withToken(homeserver, token) {
    const api = new RoomApi(homeserver);
    api.token = token;
    api.userId = await api.whoami();
    if (!api.userId) throw new Error("token login: whoami returned no user_id");
    return api;
  }

  async whoami() {
    const j = await this.#req("GET", "/_matrix/client/v3/account/whoami");
    return j.user_id;
  }

  /** Create a room (invite members), returns the room id. */
  async createRoom({ name, topic, invite = [], initial = [] }) {
    const j = await this.#req("POST", "/_matrix/client/v3/createRoom", {
      name,
      topic,
      invite,
      preset: "trusted_private_chat",
      visibility: "private",
      initial_state: initial,
    });
    return j.room_id;
  }

  async join(roomId) {
    return this.#req(
      "POST",
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {},
    );
  }

  /** Post a plain text message; optionally in-thread. Returns the event id. */
  async send(roomId, body, opts = {}) {
    const content = { msgtype: "m.text", body };
    if (opts.threadRoot) content["m.relates_to"] = { rel_type: "m.thread", event_id: opts.threadRoot, is_falling_back: true, "m.in_reply_to": { event_id: opts.threadRoot } };
    const j = await this.#req(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
    );
    return j.event_id;
  }

  /**
   * Read the room timeline (recent events, chronological).
   * Returns [{event_id, sender, type, body, threadRoot, edited, ts}].
   */
  async messages(roomId, { limit = 100, from = "" } = {}) {
    const q = new URLSearchParams({ dir: "b", limit: String(limit) });
    if (from) q.set("from", from);
    const j = await this.#req(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${q}`,
    );
    const chunk = (j.chunk ?? []).slice().reverse();
    return chunk.map((ev) => this.#flatten(ev));
  }

  #flatten(ev) {
    const c = ev.content ?? {};
    const relates = c["m.relates_to"] ?? {};
    const edit = relates.rel_type === "m.replace" ? c["m.new_content"] : undefined;
    return {
      event_id: ev.event_id,
      sender: ev.sender,
      type: ev.type,
      body: edit?.body ?? c.body ?? "",
      // the body as FIRST posted (before any m.replace edit): the proof that
      // an edit targeted THIS event and did not just happen to match later.
      original_body: c.body ?? "",
      edited: Boolean(edit),
      editedId: edit ? relates.event_id : undefined,
      threadRoot: relates.rel_type === "m.thread" ? relates.event_id : undefined,
      // m.file / m.image payloads (attachment round trip asserts on these):
      url: edit?.url ?? c.url,
      file: edit?.file ?? c.file,
      filename: edit?.filename ?? c.filename ?? c.body,
      ts: ev.origin_server_ts ?? 0,
    };
  }

  /** Wait until `pred(events)` holds over the fetched timeline. */
  async waitUntil(roomId, pred, { timeoutMs = 30_000, intervalMs = 1000, label = "room condition", seen = [] } = {}) {
    const deadline = Date.now() + timeoutMs;
    let all = [...seen];
    for (;;) {
      const fresh = await this.messages(roomId, { limit: 50 });
      const byId = new Map(all.map((e) => [e.event_id, e]));
      for (const e of fresh) byId.set(e.event_id, e);
      all = [...byId.values()].sort((a, b) => a.ts - b.ts);
      const hit = pred(all);
      if (hit) return { hit, all };
      if (Date.now() >= deadline) {
        throw new Error(
          `room-api waitUntil timed out (${timeoutMs}ms) waiting for ${label}; last bodies: ${JSON.stringify(
            all.slice(-12).map((e) => e.body.slice(0, 70)),
          )}`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** All events of a thread (root + replies), fetched from the thread timeline. */
  async thread(roomId, rootId) {
    const j = await this.#req(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(rootId)}/m.thread?limit=100`,
    );
    return (j.chunk ?? []).map((ev) => this.#flatten(ev));
  }

  /** Current state event of the room (undefined when unset). */
  async state(roomId, type) {
    const j = await this.#req(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}`,
      undefined,
      { allowNonOk: true },
    );
    return j.errcode ? undefined : j;
  }

  async members(roomId) {
    const j = await this.#req(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`,
    );
    return (j.chunk ?? [])
      .filter((ev) => ev.content?.membership === "join")
      .map((ev) => ev.state_key);
  }

  /** Download mxc media through the authenticated API. */
  async downloadMxc(mxcUrl) {
    const path = mxcUrl.replace(/^mxc:\/\//, "/_matrix/media/v3/download/");
    const res = await fetch(`${this.hs}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`download ${mxcUrl}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Upload media as this account; returns the mxc:// URI. */
  async uploadMedia(buffer, contentType = "application/octet-stream") {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await fetch(
      `${this.hs}/_matrix/media/v3/upload?filename=probe-${suffix}`,
      {
        method: "PUT",
        headers: { "content-type": contentType, authorization: `Bearer ${this.token}` },
        body: buffer,
      },
    );
    if (!res.ok) throw new Error(`upload: ${res.status} ${await res.text()}`);
    const uploaded = /** @type {{ content_uri?: string }} */ (await res.json());
    return uploaded.content_uri;
  }
}

/**
 * Second-actor credentials from the environment (never literals):
 * PI_MATRIX_SECOND_TOKEN preferred; PI_MATRIX_SECOND_USER +
 * PI_MATRIX_SECOND_PASSWORD as fallback. Throws naming what is missing.
 */
export async function connectSecondActor(homeserver) {
  if (process.env.PI_MATRIX_SECOND_TOKEN) {
    return RoomApi.withToken(homeserver, process.env.PI_MATRIX_SECOND_TOKEN);
  }
  const user = process.env.PI_MATRIX_SECOND_USER;
  const password = process.env.PI_MATRIX_SECOND_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "live scenario suite needs a second actor: set PI_MATRIX_SECOND_TOKEN, or PI_MATRIX_SECOND_USER + PI_MATRIX_SECOND_PASSWORD (see docs/dev/developing.md, \"Running the live tier\")",
    );
  }
  const api = new RoomApi(homeserver);
  await api.loginWithPassword(user, password);
  return api;
}
