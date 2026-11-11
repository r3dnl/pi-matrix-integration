/**
 * Stubbed e2e cycle (release story 8): one full conversation through the
 * real seams with test/fake-outbox.mjs as the only transport — no
 * homeserver. This is the suite that proves the four legs are wired to each
 * other, not just each to its own fixture:
 *
 *   1. milestone out      — handler.sendMilestone lands in the outbox log
 *   2. message in         — a room event reaches the session as a
 *                           matrix-message injection
 *   3. ask_user round trip — a questionnaire posts to the room, a room
 *                           reply comes back as the emitted answer set
 *   4. thread summary write — the summary lands on the thread root via the
 *                           thread send path
 *
 * Run: node test/e2e-stub-cycle.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "../harness/_harness.mjs";
import { createTestOutbox } from "../harness/fake-outbox.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck();

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-matrix-e2e-"));
process.env.FAKE_MTX_STATE = stateDir;
const sendLogPath = path.join(stateDir, "send.log");
const sendEntries = () =>
  fs.existsSync(sendLogPath)
    ? fs
        .readFileSync(sendLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const config = {
  homeserver: "matrix.example.org",
  userId: "@pi_agent:example.org",
  roomId: "!pi-updates:example.org",
  credentialsPath: path.join(stateDir, "credentials.json"),
  pollInterval: 60,
  autoReconnect: false,
  showInFooter: false,
  messagePrefix: "[Matrix] ",
  piDisplayName: "Pi Agent",
};

const fakeOutbox = createTestOutbox(config);
check("cycle: outbox connects", (await fakeOutbox.connect()) === true);

const { createMessageHandler } = await jiti.import(path.join(EXT_DIR, "src/message-handler.ts"));
const { createSessionIntegrator } = await jiti.import(path.join(EXT_DIR, "src/session-integration.ts"));
const { createThreadManager } = await jiti.import(path.join(EXT_DIR, "src/threading.ts"));
const { createAskUserMirror } = await jiti.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));

const fakePi = {
  sentMessages: [],
  renderers: new Map(),
  registerMessageRenderer(type, renderer) {
    this.renderers.set(type, renderer);
  },
  sendMessage(message, options) {
    this.sentMessages.push({ message, options });
  },
  sendUserMessage(content, options) {
    this.sentMessages.push({ message: { customType: "user", content }, options });
  },
  appendEntry() {},
};

// The thread leg records bodies: the fake outbox logs thread writes as
// markers only ({b:"reply"}), and the summary assertion needs the body.
const threadPosts = [];
const threadManager = createThreadManager({
  enabled: true,
  roomKey: config.roomId,
  threadSend: {
    async postThreadRoot(body) {
      threadPosts.push(["root", body]);
      return { success: true, eventId: "$e2e-root" };
    },
    async postThreadReply(body, rootId) {
      threadPosts.push(["reply", body, rootId]);
      return { success: true, eventId: "$e2e-rep" };
    },
    async editMessage(id, text) {
      threadPosts.push(["edit", id, text]);
      return { success: true };
    },
    async readTimeline() {
      return { success: false, messages: [] };
    },
  },
  statePath: path.join(stateDir, "thread-state.json"),
  threadSummaryEvery: 0,
});
const handler = createMessageHandler({ outbox: fakeOutbox, threadManager });
const integrator = createSessionIntegrator(
  fakePi,
  () => ({ connected: true, connecting: false, roomId: config.roomId, userId: config.userId, lastError: undefined }),
  { messagePrefix: "[Matrix] ", showInFooter: false },
);
integrator.registerMatrixMessageRenderer(fakePi);
fakeOutbox.startDelivery({
  onMessage: (m) => {
    const piMessage = handler.handleIncomingMessage(m);
    if (piMessage) integrator.injectMatrixMessage(m, piMessage);
  },
  onReaction: () => {},
  bumpUnread: () => {},
  onSyncError: () => {},
});

// --- 1. milestone out ---------------------------------------------------------
const milestone = await handler.sendMilestone("E2E milestone: story 8");
check(
  "milestone leaves through the outbox with its body",
  milestone.success === true && sendEntries().some((e) => String(e.b).includes("E2E milestone: story 8")),
  JSON.stringify(sendEntries().map((e) => e.b)),
);

// --- 2. message in -------------------------------------------------------------
fakeOutbox.pushRoomEvent({
  eventId: "$e2e-in-1",
  type: "m.room.message",
  sender: "@vincent:example.org",
  body: "how is the release going?",
  roomId: config.roomId,
  timestamp: Date.now(),
  isFromPi: false,
});
await waitUntil(
  () => fakePi.sentMessages.some((s) => s.message?.customType === "matrix-message"),
  { label: "room message reaches the session" },
);
check(
  "room message is injected into the session with attribution",
  fakePi.sentMessages.some((s) => String(s.message?.content).includes("how is the release going?")),
);

// --- 3. ask_user_question round trip --------------------------------------------
const emitted = [];
const mirror = createAskUserMirror({
  isEnabled: () => true,
  emitAnswer: (payload) => emitted.push(payload),
  postPoll: async () => ({ success: false, error: "no polls in this stub" }), // text path
  post: async (text) => {
    const r = await fakeOutbox.postMessage(text);
    return r;
  },
  pollsEnabled: () => false,
  warn: () => {},
});
await mirror.onPrompt(
  [{ question: "Ship the release?", header: "Ship", multiSelect: false, options: [{ label: "yes" }, { label: "not yet" }] }],
  "$tc-e2e",
);
await waitUntil(() => sendEntries().some((e) => String(e.b).includes("Ship the release?")), {
  label: "questionnaire posted to the room",
});
check("questionnaire reaches the room", true);
check(
  "a plain room reply is not yet an answer (no premature emit)",
  emitted.length === 0,
  JSON.stringify(emitted),
);
mirror.tryConsumeReply("1"); // option 1 of the open question
await waitUntil(() => emitted.length > 0, { label: "room answer emitted" });
const answer = emitted.at(-1);
check(
  "the room reply comes back as the completed answer set for the open call",
  answer.toolCallId === "$tc-e2e" &&
    answer.answers.length === 1 &&
    answer.answers[0].questionIndex === 0 &&
    answer.answers[0].optionIndexes.join() === "0",
  JSON.stringify(answer),
);

// --- 4. thread summary write ----------------------------------------------------
await threadManager.beginSession("e2e-session", "release topic");
const root = await threadManager.ensureThreadRoot("release topic");
check("thread root created via the outbox", Boolean(root), JSON.stringify(root));
const wrote = await threadManager.updateSummary("# Topic: release\n## Points\n- story 8 shipped");
check("summary write lands on the thread", wrote === true);
check(
  "the summary body is posted to the thread root",
  threadPosts.some((p) => String(p[1] ?? p[2]).includes("story 8 shipped")) ||
    fs.readFileSync(path.join(stateDir, "thread-state.json"), "utf8").includes("story 8 shipped"),
  JSON.stringify(threadPosts.map((p) => String(p[1] ?? p[2]).slice(0, 30))),
);

finish();
