/**
 * The PI_MATRIX_TEST_OUTBOX seam fake (TO-BE Slice 6): a call-log SdkOutbox
 * (the fake-mtx.js:92–112 precedent — state-file logs, no shared-process
 * assumptions). The composition root's `createRequire` loads this module
 * when `PI_MATRIX_TEST_OUTBOX` names it; the spawned gate/repro suites
 * read the call logs to assert on sends without shared-process state.
 *
 * 63bf85b check: this fake models matrix-js-sdk v42 property semantics —
 * the `FAKE_OUTBOX_READ_FIXTURE` readMessages channel carries
 * v42-normalized events (plaintext in `event.clearEvent` after
 * decryption, NOT the old plaintext-carrying semantics); fixture rows are
 * the shape SdkOutbox.readMessages (sdk-client.ts:725) emits today. A
 * fixture that re-certifies pre-v42 semantics silently re-proves the
 * 63bf85b bug class.
 *
 * Knobs:
 * - `FAKE_OUTBOX_FAIL_THREADS=1` → thread writes (postThreadRoot/Reply)
 *   fail → the MessageHandler flat fallback fires (the gate suite's
 *   threads-degraded phase).
 * - `FAKE_OUTBOX_CONNECT_ERR=<code>` (e.g. M_UNKNOWN_TOKEN) → connect()
 *   returns false → the connect-failure degrade path (the whoami
 *   M_UNKNOWN_TOKEN salvage from test-matrix-http.mjs).
 * - `FAKE_OUTBOX_READ_FIXTURE=<path>` → readMessages returns the JSON
 *   fixture rows (v42-normalized shape).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

let active = null;
export function getActiveOutbox() {
  return active;
}
export function createTestOutbox(cfg) {
  const dir = process.env.FAKE_MTX_STATE ?? "/tmp/fake-outbox";
  // JSON-line call log (one line per call): send bodies are multi-line
  // (the candidate-list replies), so a plain line-per-log format would
  // split one send across N physical lines and break the readers'
  // line-count / last-line semantics.
  const log = (name, entry) => appendFileSync(join(dir, `${name}.log`), JSON.stringify(entry) + "\n");
  let callbacks = null;
  const failThreadWrites = process.env.FAKE_OUTBOX_FAIL_THREADS === "1";
  // Connect-failure knob (reviewer row C2): the salvage-(b) M_UNKNOWN_TOKEN
  // test sets `FAKE_OUTBOX_CONNECT_ERR=M_UNKNOWN_TOKEN` → connect() fails →
  // the connect-failure degrade path under test.
  const connectErr = process.env.FAKE_OUTBOX_CONNECT_ERR; // e.g. "M_UNKNOWN_TOKEN"
  const outbox = {
    available: () => true,
    // Reviewer row C3: log a bare body when html is undefined — the
    // re-pointed lastSend() exact-string assertions (repro.mjs :233/:260)
    // compare the body only, and a trailing `\t` would never match.
    async postMessage(body, html) {
      log("send", { b: body, h: html ?? null });
      return { success: true, eventId: `$fake-${Date.now()}` };
    },
    async postThreadRoot() {
      if (failThreadWrites) return { success: false, error: "thread writes disabled" };
      log("send", { b: "root", h: null });
      return { success: true, eventId: "$fake-root" };
    },
    async postThreadReply() {
      if (failThreadWrites) return { success: false, error: "thread writes disabled" };
      log("send", { b: "reply", h: null });
      return { success: true, eventId: "$fake-reply" };
    },
    async editMessage() {
      log("edit", { b: "" });
      return { success: true };
    },
    async setRoomTopic() {
      return { success: true };
    },
    async readTimeline() {
      return { success: true, messages: [] };
    },
    async readMessages() {
      log("read", { b: "" });
      const fx = process.env.FAKE_OUTBOX_READ_FIXTURE;
      return fx ? JSON.parse(readFileSync(fx, "utf8")) : [];
    },
    async roomMembers() {
      return [];
    },
    async roomInfo() {
      return { rooms: [{ room_id: cfg.roomId, alias: null }] };
    },
    async sendFile(name) {
      log("send", { b: `file:${name}`, h: null });
      return { success: true, mxc: "mxc://fake" };
    },
    // delivery verbs (the SdkOutbox-only surface the terminal slice wires):
    async connect() {
      log("connect", { b: connectErr ?? "ok" });
      if (connectErr) return false;
      return true;
    },
    startDelivery(cbs) {
      callbacks = cbs;
      active = outbox;
    },
    stopDelivery() {
      callbacks = null;
    },
    async disconnect() {},
    // test hooks the gates/repro suites push room events through:
    pushRoomEvent(m) {
      callbacks?.onMessage(m);
    },
    pushReaction(m) {
      callbacks?.onReaction(m);
    },
  };
  active = outbox;
  return outbox;
}
// settle signal: the mtx read-count / dry-mode analog is the fake's "read"/"send"
// log line counts. MTX_ALLOW_PROD has no outbox analogue — dropped from the gate
// suite (recorded in the Slice-6 Design History entry).
