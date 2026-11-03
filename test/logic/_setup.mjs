/**
 * Shared environment for the logic suites (split from test-logic.mjs by
 * subsystem — story 8). Hermetic per process: fresh tmp dir, connected fake
 * outbox, and the three module factories the original file shared.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR } from "../_harness.mjs";
import { createTestOutbox } from "../fake-outbox.mjs";

const jiti = await createPiJiti(import.meta.url);

// The fake outbox (the PI_MATRIX_TEST_OUTBOX seam) logs its calls under
// ${FAKE_MTX_STATE} — keep that at the suite's hermetic state dir.
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-fake-"));
export const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.FAKE_MTX_STATE = stateDir;

export const TS = 1_700_000_000_000;

export const config = {
  homeserver: "tst2-matrix.r3d.nl",
  userId: "@pi-agent:tst2-matrix.r3d.nl",
  roomId: "!pi-updates:tst2-matrix.r3d.nl",
  credentialsPath: path.join(stateDir, "credentials.json"),
  pollInterval: 60,
  autoReconnect: false,
  showInFooter: false,
  messagePrefix: "[Matrix] ",
  piDisplayName: "Pi Agent",
};

export const fakeOutbox = createTestOutbox(config);
export const connOk = await fakeOutbox.connect();

const { createMessageHandler } = await jiti.import(path.join(EXT_DIR, "src/message-handler.ts"));
const { createSessionIntegrator } = await jiti.import(path.join(EXT_DIR, "src/session-integration.ts"));

export const fakePi = {
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

export const handler = createMessageHandler({ outbox: fakeOutbox });
export const integrator = createSessionIntegrator(
  fakePi,
  () => ({
    connected: connOk,
    connecting: false,
    roomId: config.roomId,
    userId: config.userId,
    lastError: undefined,
  }),
  { messagePrefix: "[Matrix] ", showInFooter: false },
);

export const evt = (eventId, { body, type = "m.room.message", reaction, sender } = {}) => ({
  eventId,
  type,
  sender: sender ?? "@vincent:tst2-matrix.r3d.nl",
  body: body ?? "",
  roomId: config.roomId,
  timestamp: Date.now(),
  isFromPi: (sender ?? "@vincent:tst2-matrix.r3d.nl") === config.userId,
  ...(reaction ? { reactionKey: reaction.key, parentEventId: reaction.event_id } : {}),
});
