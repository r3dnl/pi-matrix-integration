/**
 * Thread root opened FROM the room — the runnable check (roadmap 0.9.1).
 *
 * New terminal session, conversation starts in the Matrix room: the flat ask
 * used to stay outside the thread while the first outgoing send created a bare
 * `🧵 New Conversation` root — the ask was never captured. Proves the inbound
 * funnel's root leg:
 *   1. a flat room message on a pending session opens the thread root with the
 *      ask as its topic, and still injects;
 *   2. a second flat message does not open a second root;
 *   3. a threaded room message adopts the user's thread instead (no new root);
 *   4. threading off → no root write, injection unchanged.
 *
 * Run: node test/room-thread-root.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "../harness/_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("room-thread-root");

const { createInbound } = await jiti.import(`${EXT_DIR}/src/inbound.ts`);
const { createThreadManager } = await jiti.import(`${EXT_DIR}/src/threading.ts`);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-room-root-"));
let built = 0;

function build({ threading = true } = {}) {
  const injected = [];
  const calls = [];
  let n = 0;
  const threadSend = {
    async postThreadRoot(body) { calls.push(["root", body]); return { success: true, eventId: `$root-${++n}` }; },
    async postThreadReply(body, rootId) { calls.push(["reply", body, rootId]); return { success: true, eventId: `$rep-${++n}` }; },
    async editMessage() { return { success: true }; },
    async setRoomTopic() { return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
  };
  const threadManager = createThreadManager({
    enabled: threading,
    roomKey: `!room-${built}:example.org`,
    threadSend,
    statePath: path.join(stateDir, `map-${built++}.json`),
  });
  threadManager.beginSession("new", "sess-1");
  const inbound = createInbound({
    cfg: {
      slashRelay: false,
      mirrorAskUser: false,
      voiceTranscription: false,
      userId: "@pi_agent:example.org",
      maxMessageAgeMinutes: 30,
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pi: { sendUserMessage: () => {}, getCommands: () => [] },
    threadManager,
    mirror: { tryConsumeReply: () => false },
    roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
    messageHandler: {
      handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
      post: async () => ({ success: true }),
    },
    sessionIntegrator: { injectMatrixMessage: (m) => injected.push(m.body) },
    voiceTranscriber: { transcribe: async () => ({ text: "" }) },
  });
  return { threadManager, inbound, injected, calls };
}

const msg = (eventId, extra = {}) => ({
  eventId,
  sender: "@vincent:example.org",
  body: `body ${eventId}`,
  timestamp: Date.now(),
  roomId: "!room:example.org",
  isFromPi: false,
  ...extra,
});

// 1 + 2: flat ask opens the root with the ask as topic; no second root after.
const a = build();
a.inbound.dispatch({ ...msg("$ask1"), body: "please review the deploy script" });
await waitUntil(() => a.calls.length > 0, { timeoutMs: 3_000, label: "room-originated root" }).catch(() => {});
check(
  "flat room ask on a pending session opens the root with the ask as topic",
  a.calls[0]?.[0] === "root" && a.calls[0]?.[1] === "🧵 New Conversation: please review the deploy script",
  JSON.stringify(a.calls[0]),
);
check("the ask is still injected into the session", a.injected.length === 1, JSON.stringify(a.injected));
check("session is no longer pending", a.threadManager.pending() === false);
a.inbound.dispatch(msg("$ask2"));
await new Promise((r) => setTimeout(r, 50));
check(
  "a later flat message does not open a second root",
  a.calls.filter((c) => c[0] === "root").length === 1,
  JSON.stringify(a.calls),
);

// 3: a threaded room message adopts the user's thread — no new root write.
const b = build();
b.inbound.dispatch(msg("$ask3", { threadRoot: "$user-root" }));
await new Promise((r) => setTimeout(r, 50));
check(
  "threaded message adopts the user's thread, no root write",
  b.threadManager.activeRoot()?.eventId === "$user-root" && b.calls.length === 0,
  JSON.stringify(b.calls),
);

// 4: threading off → no root write, injection unchanged.
const c = build({ threading: false });
c.inbound.dispatch(msg("$ask4"));
await new Promise((r) => setTimeout(r, 50));
check("threading off: no root write", c.calls.length === 0, JSON.stringify(c.calls));
check("threading off: message still injected", c.injected.length === 1, JSON.stringify(c.injected));

finish();
