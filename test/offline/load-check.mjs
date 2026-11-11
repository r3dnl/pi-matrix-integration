/**
 * Reproduction harness: loads the pi-matrix-integration extension the same way
 * pi does (jiti + module aliases) and invokes the factory with a mock
 * ExtensionAPI mirroring pi's createExtensionAPI().
 *
 * HERMETIC (like test-gates): the fake outbox (PI_MATRIX_TEST_OUTBOX) records every
 * send and no
 * real homeserver connection is opened. The factory still reads the live
 * config (sendMilestones / sendFinalMessages on), so the simulated
 * session_start / message_end / turn_end events DO go through the real
 * send path — but into the fake's state dir, never the real room.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPiJiti, EXT_DIR } from "../harness/_harness.mjs";

const EXT_PATH = path.join(EXT_DIR, "index.ts");
const jiti = await createPiJiti(import.meta.url);

// ---- hermetic setup (mirror test-gates.mjs) ---------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-repro-"));
// Single transport (TO-BE Slice 6): the PI_MATRIX_TEST_OUTBOX seam — the
// fake outbox stands in for the SdkOutbox; its state-file call logs are
// the send recording (state-file call logs; the shell-spawn recording is gone).
process.env.PI_MATRIX_TEST_OUTBOX = path.join(EXT_DIR, "test", "harness", "fake-outbox.mjs");
// Hermetic credentials: the config derives userId/homeserver from the
// credentials file (DESIGN-TRANSPORT-AND-IDENTITY §2.1), so a missing file
// fails validation and the factory early-returns (no registrations). The
// fake outbox still stands in for every transport call — no real homeserver
// connection in any phase.
const fakeCreds = path.join(tmp, "credentials.json");
fs.writeFileSync(
  fakeCreds,
  JSON.stringify({ user_id: "@pi_agent:test.example.org", homeserver: "test.example.org" }, null, 2),
);
process.env.PI_MATRIX_CREDENTIALS_PATH = fakeCreds;
// Keep the run hermetic: warnings go to a temp log, not the real one.
process.env.PI_MATRIX_LOG_PATH = path.join(tmp, "repro-matrix.log");
// Flat send-recording protocol: threads OFF — the milestone/final sends
// must ride the flat outbox.postMessage path (the exact-string assertions
// below compare the recorded flat bodies). Threads on would soft-attach
// the pending-session milestone to the shared thread-map's latest root
// (the live session's state) and the fake would log the thread-reply
// token instead of the body.
process.env.PI_MATRIX_THREADS = "false";
// Send recording (fake-outbox call-log state).
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.FAKE_MTX_STATE = stateDir;
/** The last recorded send (the fake outbox's "send" JSON-line call log —
 * one line per call, `{ b: body, h: html }`; the body comes back whole,
 * multi-line candidate lists included). */
const lastSend = () => {
  const p = path.join(stateDir, "send.log");
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return null;
  try {
    const o = JSON.parse(lines[lines.length - 1]);
    return o.b;
  } catch {
    return lines[lines.length - 1].split("\t")[0];
  }
};

// ---- mock ExtensionAPI (mirrors pi's createExtensionAPI) -------------------
function createMockApi() {
  const extension = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
    flags: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
  };
  const notAllowed = (name) => () => {
    throw new Error(
      `mock: ${name} not available in this phase (like pi's pre-bind runtime)`,
    );
  };
  const api = {
    on(event, handler) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },
    registerTool(tool) {
      extension.tools.set(tool.name, tool);
    },
    registerCommand(name, options) {
      extension.commands.set(name, options);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer(type, renderer) {
      extension.messageRenderers.set(type, renderer);
    },
    registerMarkdownTransformer() {},
    registerEntryRenderer() {},
    // pi pre-bind: action methods THROW until bound
    sendMessage: notAllowed("sendMessage"),
    sendUserMessage: notAllowed("sendUserMessage"),
    appendEntry: notAllowed("appendEntry"),
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    exec: notAllowed("exec"),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
  };
  return { api, extension };
}

const notifications = [];
const mockCtx = {
  ui: {
    setStatus() {},
    setWidget() {},
    notify(msg, kind) {
      notifications.push({ msg: String(msg), kind });
    },
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
    input: () => Promise.resolve(undefined),
  },
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  sessionManager: {
    getEntries: () => [],
    getBranch: () => [],
    buildContextEntries: () => [],
    getLeafId: () => undefined,
  },
  signal: undefined,
};

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

async function main() {
  console.log("== importing extension module ==");
  let factory;
  try {
    factory = await jiti.import(EXT_PATH, { default: true });
  } catch (err) {
    console.error("MODULE IMPORT FAILED:", err);
    process.exit(1);
  }
  if (typeof factory !== "function") {
    console.error("default export is not a function:", typeof factory);
    process.exit(1);
  }
  check("module imports via jiti like pi does", true);

  console.log("== invoking factory ==");
  const { api, extension } = createMockApi();
  try {
    await factory(api);
    check("factory(api) completes", true);
  } catch (err) {
    check("factory(api) completes", false, String(err));
  }

  check(
    "3 tools registered",
    extension.tools.size === 3,
    JSON.stringify([...extension.tools.keys()]),
  );
  check(
    "15 commands registered",
    extension.commands.size === 15,
    JSON.stringify([...extension.commands.keys()]),
  );
  check(
    "matrix-login command registered",
    extension.commands.has("matrix-login"),
  );
  check(
    "matrix-introduction-tour command registered",
    extension.commands.has("matrix-introduction-tour"),
    JSON.stringify([...extension.commands.keys()]),
  );
  check(
    "matrix-switch command registered",
    extension.commands.has("matrix-switch"),
    JSON.stringify([...extension.commands.keys()]),
  );
  check(
    "matrix-message renderer registered",
    extension.messageRenderers.has("matrix-message"),
    JSON.stringify([...extension.messageRenderers.keys()]),
  );
  for (const ev of ["session_start", "message_end", "turn_end"]) {
    check(`handler registered for ${ev}`, (extension.handlers.get(ev) ?? []).length > 0);
  }

  console.log("== simulate session_start ==");
  try {
    const h = (extension.handlers.get("session_start") ?? []).at(-1);
    if (h) await h({ type: "session_start", reason: "startup" }, mockCtx);
    check("session_start handler runs", true);
  } catch (err) {
    check("session_start handler runs", false, String(err));
  }
  // autoConnect default: session start must attempt a Matrix connect
  // (success or a graceful failure — never a silent no-op, never a crash).
  check(
    "session_start attempts Matrix connect (autoConnect default)",
    notifications.some((n) => /Connected to Matrix|Failed to connect/.test(n.msg)),
    JSON.stringify(notifications),
  );

  console.log("== simulate message_end ==");
  try {
    const h = (extension.handlers.get("message_end") ?? []).at(-1);
    if (h)
      await h(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Milestone: finished the refactor" }],
          },
        },
        mockCtx,
      );
    check("message_end handler runs", true);
  } catch (err) {
    check("message_end handler runs", false, String(err));
  }
  // sendMilestones (live config) → the marker heuristic must have produced
  // the milestone send, recorded by the fake outbox.
  check(
    "message_end send recorded (marker heuristic)",
    lastSend() === "🎯 Milestone: finished the refactor",
    JSON.stringify(lastSend()),
  );

  console.log("== simulate turn_end ==");
  try {
    const h = (extension.handlers.get("turn_end") ?? []).at(-1);
    if (h)
      await h(
        {
          type: "turn_end",
          turnIndex: 0,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "TODO: progress on task 3" }],
          },
        },
        mockCtx,
      );
    check("turn_end handler runs", true);
  } catch (err) {
    check("turn_end handler runs", false, String(err));
  }
  // turn_end emits the TODO milestone first, then (sendFinalMessages) the
  // final broadcast — last recorded send is the final.
  check(
    "turn_end send recorded (final broadcast last)",
    lastSend() === "💬 Pi: TODO: progress on task 3",
    JSON.stringify(lastSend()),
  );

  console.log("== call matrix-status command handler ==");
  try {
    const cmd = extension.commands.get("matrix-status");
    if (cmd) await cmd.handler("", mockCtx);
    check("matrix-status handler runs", extension.commands.has("matrix-status"));
  } catch (err) {
    check("matrix-status handler runs", false, String(err));
  }

  console.log("== invoke a tool execute (matrix_get_messages) ==");
  try {
    const tool = extension.tools.get("matrix_get_messages");
    if (tool) {
      const res = await tool.execute("tc-1", { limit: 5 }, undefined, undefined, mockCtx);
      check("matrix_get_messages returns content", Boolean(res?.content?.length), JSON.stringify(res).slice(0, 200));
    } else {
      check("matrix_get_messages returns content", false, "tool missing");
    }
  } catch (err) {
    check("matrix_get_messages returns content", false, String(err));
  }

  if (failures === 0) {
    console.log("ALL CHECKS PASSED");
    process.exit(0);
  }
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}

main();
