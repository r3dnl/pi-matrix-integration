/** Split from test-logic.mjs (story 8): assertions preserved verbatim. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "../_harness.mjs";
import { createTestOutbox } from "../fake-outbox.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck();
const { tmp, stateDir, TS, config, fakeOutbox, connOk, fakePi, handler, integrator, evt } = await import("./_setup.mjs");
// ============================================================================
// ---- sdk-client: Outbox ops against a fake client (addendum §2) ----------
// ============================================================================
{
  const { SdkOutbox } = await jiti.import(path.join(EXT_DIR, "src/sdk-client.ts"));
  const sdkModule = {
    RoomEvent: { Timeline: "Room.timeline" },
    SyncState: { Syncing: "SYNCING", Error: "ERROR", Stopped: "STOPPED" },
    MemoryStore: class {},
  };

  const calls = { sends: [], threadReplies: 0, uploads: [], topic: [], http: [] };
  const fakeClient = {
    _listeners: new Map(),
    on(ev, cb) { this._listeners.set(ev, cb); },
    removeAllListeners(ev) { this._listeners.delete(ev); },
    async sendMessage(a, b, c, d) {
      // v42: (room, content, txnId) | (room, threadId, content, txnId)
      if (typeof b === "string" && c !== undefined && c !== null && typeof c === "object") {
        calls.threadReplies++;
        calls.sends.push({ threadId: b, content: c });
      } else {
        calls.sends.push({ content: b });
      }
      return { event_id: "$sdk-evt-1" };
    },
    async sendEvent(room, a, b, c) {
      // (room, type, content) | (room, threadId, type, content)
      if (typeof a === "string" && b !== undefined && typeof b === "object" && c === undefined) {
        calls.sends.push({ type: a, content: b });
      } else {
        calls.sends.push({ threadId: a ?? null, type: b, content: c });
      }
      return { event_id: "$poll-evt" };
    },
    async setRoomTopic(room, topic) { calls.topic.push([room, topic]); return { event_id: "$topic" }; },
    async readTimeline() { return { success: false, messages: [] }; },
    async uploadContent(data, opts) { calls.uploads.push({ data, opts }); return { content_uri: "mxc://srv/m-123" }; },
    http: {
      async request(method, p, qp) { calls.http.push({ method, path: p, qp }); return { chunk: [] }; },
      async authedRequest(method, p, qp) { calls.http.push({ method, path: p, qp }); return { chunk: [] }; },
    },
    async getRoomIdForAlias() { return { room_id: "!resolved:test" }; },
    getRoom() { return { getJoinedMembers: () => [], getCanonicalAlias: () => null, getMyMembership: () => "join", roomId: "!resolved:test" }; },
    getRooms() { return []; },
  };
  const baseOpts = {
    homeserver: "test.example.org",
    userId: "@pi-agent:test.example.org",
    roomId: "#pi-updates:test.example.org",
    credentialsPath: "/nonexistent/credentials.json",
    logger: { warn() {}, error() {}, debug() {}, info() {} },
  };
  const outbox = new SdkOutbox(baseOpts);
  check("sdk outbox: unavailable before the client is installed", outbox.available() === false);
  const unavail = await outbox.postMessage("hi");
  check(
    "sdk outbox: a pre-start op soft-fails (never throws)",
    unavail.success === false && /unavailable/.test(unavail.error ?? ""),
  );

  outbox.setTestClient(fakeClient, "!resolved:test", sdkModule);
  check("sdk outbox: available after the client is installed", outbox.available() === true);

  const flat = await outbox.postMessage("hello", "<b>hello</b>");
  const flatC = calls.sends.at(-1).content;
  check(
    "sdk postMessage → m.text + formatted_body, NO thread marker",
    flat.success && flatC.msgtype === "m.text" && flatC.body === "hello" &&
      flatC.formatted_body === "<b>hello</b>" && flatC["m.thread"] === undefined,
  );

  const rootR = await outbox.postThreadRoot("root", "<i>r</i>");
  const rootC = calls.sends.at(-1).content;
  check(
    "sdk postThreadRoot → the m.thread marker a spec-compliant homeserver retains (MSC1767 shape)",
    rootR.success && rootC["m.thread"]?.["m.topological_ordering"] === 1 &&
      rootC["m.thread"]?.["m.message_count"] === 1 && rootC.body === "root",
  );

  await outbox.postThreadReply("reply", "$root-1", true, "<i>x</i>");
  const replyC = calls.sends.at(-1);
  check(
    "sdk postThreadReply → the threadId send variant + the nested root marker",
    calls.threadReplies === 1 && replyC.threadId === "$root-1" &&
      replyC.content["m.thread"] !== undefined && replyC.content.body === "reply",
  );

  await outbox.editMessage("$target", "new text", { threadRoot: true });
  const editC = calls.sends.at(-1).content;
  check(
    "sdk editMessage → m.new_content + the m.replace relation",
    editC["m.new_content"]?.body === "new text" &&
      editC["m.new_content"]["m.thread"] !== undefined &&
      editC["m.relates_to"]?.rel_type === "m.replace" &&
      editC["m.relates_to"]?.event_id === "$target",
  );

  const topicR = await outbox.setRoomTopic("doing it");
  check(
    "sdk setRoomTopic → the client verb against the resolved room",
    topicR.success && calls.topic.at(-1)?.[0] === "!resolved:test" && calls.topic.at(-1)?.[1] === "doing it",
  );

  // MSC4125 sendFile — attachEncryption defaults to "on": the upload is
  // CIPHERTEXT; the m.file object carries key/iv/v/hashes.sha256 (the shape
  // VectorIM Element Web's `isEncrypted === !!content.file` reads).
  const payload = Buffer.from("the artifact bytes 0123456789");
  const fileR = await outbox.sendFile("note.md", payload, "text/markdown", "caption", "$root-1");
  const up = calls.uploads.at(-1);
  check(
    "sdk sendFile (on): the uploaded bytes are CIPHERTEXT (AES-CTR: same length, different content)",
    fileR.success && Buffer.from(up.data).equals(payload) === false && up.data.byteLength === payload.byteLength,
  );
  const fileC = calls.sends.at(-1).content;
  check(
    "sdk sendFile (on): the m.file shape — VectorIM reads key/iv/v/hashes",
    fileC.msgtype === "m.file" && fileC.body === "caption" &&
      fileC.info.size === up.data.byteLength && fileC.info.mimetype === "text/markdown" &&
      fileC.file.url === "mxc://srv/m-123" && fileC.file.key?.kty === "oct" &&
      fileC.file.key?.alg === "A256CTR" && typeof fileC.file.iv === "string" &&
      fileC.file.v === "v2" && typeof fileC.file.hashes?.sha256 === "string",
  );
  check(
    "sdk sendFile (on): hashes.sha256 is over the CIPHERTEXT (the VectorIM check, unpadded base64)",
    fileC.file.hashes?.sha256 ===
      createHash("sha256").update(up.data).digest("base64").replace(/=+$/, ""),
  );
  check(
    "sdk sendFile (on): the in-thread upload posts through the threadId variant",
    calls.sends.at(-1).threadId === "$root-1",
  );

  // attachEncryption off → plaintext upload, a plain m.file (no key).
  const offBox = new SdkOutbox({ ...baseOpts, attachEncryption: "off" });
  offBox.setTestClient(fakeClient, "!resolved:test", sdkModule);
  const upCountBefore = calls.uploads.length;
  const plainR = await offBox.sendFile("n.md", payload, "text/markdown");
  const up2 = calls.uploads.at(-1);
  const plainC = calls.sends.at(-1).content;
  check(
    "sdk sendFile (off): plaintext upload, no file.key (the legacy m.file shape)",
    plainR.success && calls.uploads.length === upCountBefore + 1 &&
      Buffer.from(up2.data).equals(payload) && plainC.file?.url === "mxc://srv/m-123" &&
      plainC.file?.key === undefined,
  );

  // soft-fail: a throwing upload never escapes the op.
  const failBox = new SdkOutbox({ ...baseOpts, credentialsPath: "/nonexistent/credentials.json" });
  failBox.setTestClient(fakeClient, "!resolved:test", sdkModule);
  const failClient = { ...fakeClient, uploadContent: async () => { throw new Error("boom"); } };
  failBox.setTestClient(failClient, "!resolved:test", sdkModule);
  const failedR = await failBox.sendFile("n.md", payload, "text/markdown");
  check(
    "sdk sendFile: a failing upload soft-fails (no throw)",
    failedR.success === false && /boom/.test(failedR.error ?? ""),
  );

  // Poll wire shape (Element X MSC1767-era client, observed 2026-10-13:
  // the working poll + the "missing field org.matrix.msc1767.text" poll.end
  // error). Namespaced kind, question with BOTH text fields, answers with
  // the 1767 field, timeline fallback text; the end carries the 1767 text.
  const pollR = await outbox.sendPoll(
    "Pick one",
    [
      { id: "1", label: "alpha" },
      { id: "2", label: "beta" },
    ],
    "$thread-root",
    2,
  );
  const pollSend = calls.sends.at(-1);
  check(
    "sdk sendPoll → thread-routed poll.start",
    pollR.success && pollSend.threadId === "$thread-root" &&
      pollSend.type === "org.matrix.msc3381.poll.start",
    JSON.stringify(pollSend),
  );
  const pc = pollSend.content["org.matrix.msc3381.poll.start"];
  check(
    "sdk sendPoll → namespaced kind + question with BOTH text fields",
    pc.kind === "org.matrix.msc3381.poll.disclosed" &&
      pc.question["org.matrix.msc1767.text"] === "Pick one" &&
      pc.question.body === "Pick one" && pc.max_selections === 2,
    JSON.stringify(pc),
  );
  check(
    "sdk sendPoll → answers carry id + both text fields",
    pc.answers.length === 2 && pc.answers[0].id === "1" &&
      pc.answers[0].body === "alpha" && pc.answers[0]["org.matrix.msc1767.text"] === "alpha",
    JSON.stringify(pc.answers),
  );
  check(
    "sdk sendPoll → timeline fallback (question + numbered answers)",
    pollSend.content["org.matrix.msc1767.text"] === "Pick one\n1. alpha\n2. beta",
    JSON.stringify(pollSend.content["org.matrix.msc1767.text"]),
  );
  const endR = await outbox.endPoll("$poll-evt");
  const endSend = calls.sends.at(-1);
  check(
    "sdk endPoll → flat poll.end with the 1767 end text + reference",
    endR.success && endSend.type === "org.matrix.msc3381.poll.end" &&
      endSend.threadId === undefined &&
      endSend.content["org.matrix.msc1767.text"] === "Poll has ended" &&
      endSend.content["m.relates_to"]?.event_id === "$poll-evt",
    JSON.stringify(endSend),
  );

  // reads go through the SDK's http layer (the client-API prefix, dir=b).
  const readBox = new SdkOutbox({ ...baseOpts });
  readBox.setTestClient(fakeClient, "!resolved:test", sdkModule);
  fakeClient.http.authedRequest = async (m, p, qp) => {
    calls.http.push({ method: m, path: p, qp });
    return {
      chunk: [{ event_id: "$r1", sender: "@v:dom", type: "m.room.message", origin_server_ts: 1700000000000, room_id: "!resolved:test", content: { body: "hi", msgtype: "m.text" } }],
    };
  };
  const tlR = await readBox.readTimeline(40);
  check(
    "sdk readTimeline → the SDK http layer (client-API path, dir=b, limit)",
    tlR.success === true && calls.http.at(-1).qp.dir === "b" && calls.http.at(-1).qp.limit === 40 &&
      calls.http.at(-1).path ===
        `/_matrix/client/v3/rooms/${encodeURIComponent("!resolved:test")}/messages` &&
      tlR.messages.length === 1 && tlR.messages[0].eventId === "$r1",
  );

  // E2EE read path (the 2026-09-21 frozen-thread-summary bug): a raw /messages
  // read in an encrypted room returns m.room.encrypted ciphertext, which the
  // old parse dropped → an empty delta. readableEvents() now routes the
  // ciphertext through the client's own crypto backend (the same OlmMachine
  // the sync pipeline uses — one decryption path) and reads the effective
  // (decrypted) event. Uses the REAL sdk.MatrixEvent (the linchpin is the
  // SDK's getEffectiveEvent/setClearData semantics) but a fake
  // decryptEventIfNeeded (no WASM / network) and a fake http chunk.
  {
    const realMatrixEvent = (await import("matrix-js-sdk")).MatrixEvent;
    const encSdkModule = { ...sdkModule, MatrixEvent: realMatrixEvent };
    const encClient = { ...fakeClient };
    encClient.http.authedRequest = async () => ({
      chunk: [
        { event_id: "$enc-1", sender: "@v:dom", type: "m.room.encrypted", room_id: "!resolved:test", origin_server_ts: 1700000001000, content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", sender_key: "k" } },
        { event_id: "$plain-2", sender: "@v:dom", type: "m.room.message", room_id: "!resolved:test", origin_server_ts: 1700000002000, content: { body: "plain hello", msgtype: "m.text" } },
      ],
    });
    encClient.decryptEventIfNeeded = async (ev) => {
      ev.setClearData({
        clearEvent: {
          event_id: ev.getId(),
          sender: ev.getSender(),
          type: "m.room.message",
          origin_server_ts: 1700000001000,
          room_id: "!resolved:test",
          content: { body: "secret decrypted", msgtype: "m.text" },
        },
      });
    };
    const encBox = new SdkOutbox(baseOpts);
    encBox.setTestClient(encClient, "!resolved:test", encSdkModule);
    const encTl = await encBox.readTimeline(40);
    check(
      "sdk readTimeline (E2EE): ciphertext is decrypted via the client crypto backend, plaintext passes through",
      encTl.success === true && encTl.messages.length === 2 &&
        encTl.messages[0].eventId === "$enc-1" && encTl.messages[0].body === "secret decrypted" &&
        encTl.messages[1].eventId === "$plain-2" && encTl.messages[1].body === "plain hello",
      JSON.stringify(encTl),
    );
  }

  // delivery: seed (non-live) vs live, self-drop, reaction routing (R9).
  const emitted = [], reactions = [], bumped = [];
  let seeded = -1;
  readBox.startDelivery({
    onMessage: (m) => emitted.push(m.eventId),
    onReaction: (m) => reactions.push(m.reactionKey ?? "?"),
    bumpUnread: (rk, e) => bumped.push(e.eventId),
    onSeedComplete: (n) => { seeded = n; },
    onSyncError: () => {},
  });
  const tlHandler = fakeClient._listeners.get("Room.timeline");
  check("sdk delivery: a client-level Room.timeline handler is registered", typeof tlHandler === "function");
  const ev = (id, sender, type, content, ts = 1700000000000) => ({
    event: { event_id: id, sender, type, origin_server_ts: ts, room_id: "!resolved:test", content },
    getContent: () => content,
  });
  tlHandler(ev("$seed-1", "@v:dom", "m.room.message", { body: "backfill" }), { roomId: "!resolved:test" }, false, false, { liveEvent: false });
  tlHandler(ev("$live-1", "@v:dom", "m.room.message", { body: "live message" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  tlHandler(ev("$self-1", "@pi-agent:test.example.org", "m.room.message", { body: "my own post" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  tlHandler(ev("$react-1", "@v:dom", "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: "$live-1", key: "👍" } }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  check(
    "sdk delivery: backfill is BASELINED — no emit, no unread bump (the seed event itself)",
    !emitted.includes("$seed-1") && !bumped.includes("$seed-1") && seeded === 1,
  );
  check("sdk delivery: live events emit + bump the D1 model", emitted.includes("$live-1") && bumped.includes("$live-1"));
  // Shared-account self-drop (2026-10-09): "sender === self" is no longer
  // the drop criterion — the human may share pi's login account (any
  // account the login picked). A live event from self that was NOT sent
  // through the outbox is user input (emit + bump).
  check(
    "sdk delivery: a self-sender event not sent via the outbox is user input (shared account)",
    emitted.includes("$self-1") && bumped.includes("$self-1"),
  );
  // A post sent via the outbox is recorded at send time → its confirmed
  // copy dedupes (no emit, no bump); ~! temp ids (js-sdk local echoes)
  // always drop.
  fakeClient.sendMessage = async () => ({ event_id: "$own-sent" });
  const ownSent = await readBox.postMessage("sent via outbox");
  check("sdk delivery: the outbox send records the event id", ownSent.success === true && ownSent.eventId === "$own-sent", JSON.stringify(ownSent));
  tlHandler(ev("$own-sent", "@pi-agent:test.example.org", "m.room.message", { body: "confirmed copy" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  check("sdk delivery: the confirmed copy of an outbox send drops (send record, not sender)", !emitted.includes("$own-sent") && !bumped.includes("$own-sent"));
  tlHandler(ev("~!temp-1", "@pi-agent:test.example.org", "m.room.message", { body: "local echo" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  check("sdk delivery: a ~! temp-id local echo drops", !emitted.includes("~!temp-1") && !bumped.includes("~!temp-1"));
  check("sdk delivery: reactions route to onReaction (never onMessage)", reactions.includes("👍") && !emitted.includes("$react-1"));
  readBox.stopDelivery();
  check("sdk delivery: stopDelivery detaches the handler", fakeClient._listeners.has("Room.timeline") === false);
}

// ============================================================================
// ---- MSC4125 attach-encryption round-trip (addendum §4) -------------------
// ============================================================================
{
  const mma = await import("matrix-encrypt-attachment");
  const encryptAttachment = mma.encryptAttachment ?? mma.default?.encryptAttachment;
  const decryptAttachment = mma.decryptAttachment ?? mma.default?.decryptAttachment;
  const rt = Buffer.from("round-trip payload 0123456789");
  const enc = await encryptAttachment(rt.buffer.slice(rt.byteOffset, rt.byteOffset + rt.byteLength));
  const decBuf = await decryptAttachment(enc.data, enc.info);
  check("attach round-trip: decrypt(encrypt(x)) == x", Buffer.from(decBuf).equals(rt));
  check(
    "attach format: v2 + an oct A256CTR JWK + UNPADDED standard base64 iv/sha256 (the MSC4125 v2 wire shape)",
    enc.info.v === "v2" && enc.info.key.kty === "oct" && enc.info.key.alg === "A256CTR" &&
      /^[A-Za-z0-9+/]+$/.test(enc.info.iv) && /^[A-Za-z0-9+/]+$/.test(enc.info.hashes?.sha256 ?? ""),
  );
}

// ============================================================================
// ---- project-scoped config + state (option C) ----------------------------
// ============================================================================
{
  const {
    resolveConfigPath,
    getProjectConfigPath,
    getActiveConfigDir,
    getStateDir,
    getExtensionDir,
  } = await jiti.import(path.join(EXT_DIR, "src", "config-utils.ts"));
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pmi-proj-"));
  const projCfgDir = path.join(projRoot, ".pi", "matrix");
  fs.mkdirSync(projCfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(projCfgDir, "matrix-config.json"),
    JSON.stringify({ roomId: "#proj:example.local" }),
  );
  const { loadConfig, seedConfigDefaults } = await jiti.import(
    path.join(EXT_DIR, "src", "config-utils.ts"),
  );
  const origCwd = process.cwd();
  const origLogEnv = process.env.PI_MATRIX_LOG_PATH;
  delete process.env.PI_MATRIX_LOG_PATH;
  process.chdir(projRoot);
  const cwd = process.cwd(); // canonical (macOS /var → /private/var)
  const expectedCfgDir = path.join(cwd, ".pi", "matrix");
  const expectedStateLog = path.join(expectedCfgDir, "state", "pi-matrix.log");
  try {
    const active = resolveConfigPath();
    check(
      "project .pi/matrix config wins over the shipped config",
      active === getProjectConfigPath(),
      active ?? "(no config resolved)",
    );
    check(
      "active config dir is the project dir",
      getActiveConfigDir() === path.dirname(active),
      getActiveConfigDir() ?? "(undefined)",
    );
    check(
      "state co-locates next to the active project config (.pi/matrix/state)",
      getStateDir() === path.join(path.dirname(active), "state"),
      getStateDir(),
    );
    check(
      "loadConfig() reads the project manifest (shared resolution)",
      loadConfig().roomId === "#proj:example.local" && loadConfig().credentialsPath !== undefined,
    );
    check(
      "unpinned logPath co-locates with the project state (.pi/matrix/state/pi-matrix.log)",
      loadConfig().logPath === expectedStateLog,
      loadConfig().logPath,
    );
    seedConfigDefaults();
    check(
      "seeding the project manifest writes the project-local logPath (not the global default)",
      JSON.parse(fs.readFileSync(path.join(expectedCfgDir, "matrix-config.json"), "utf-8")).logPath ===
        expectedStateLog,
    );
    const explicitCfg = path.join(projRoot, "explicit.json");
    fs.writeFileSync(explicitCfg, "{}");
    check(
      "explicit configPath still has top precedence",
      resolveConfigPath(explicitCfg) === explicitCfg,
      resolveConfigPath(explicitCfg) ?? "(none)",
    );
  } finally {
    process.chdir(origCwd);
    if (origLogEnv === undefined) delete process.env.PI_MATRIX_LOG_PATH;
    else process.env.PI_MATRIX_LOG_PATH = origLogEnv;
  }
  // Hermetic cwd: the checkout itself may carry a real .pi/matrix/ project
  // config (a live session run from this directory), which would legitimately
  // activate project-local state and break this extension-fallback assertion.
  {
    const cleanCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-state-clean-"));
    const cwdBefore = process.cwd();
    process.chdir(cleanCwd);
    check(
      "without a project config, state falls back to the extension-local dir (no silent migration)",
      getStateDir() === path.join(getExtensionDir(), "state"),
      getStateDir(),
    );
    process.chdir(cwdBefore);
    fs.rmSync(cleanCwd, { recursive: true, force: true });
  }
}

// F3 regression: the voice leg resolves rpiv-voice lazily UNDER THE
// PI LOADER (this suite runs on the same jiti), so a relocated npm
// store can no longer break the extension's module load.
{
  const { loadVoiceModules } = await jiti.import(path.join(EXT_DIR, "src/voice.ts"));
  const mods = await loadVoiceModules({ debug() {}, warn() {}, error() {} });
  // mirror src/voice.ts voiceRootCandidates(): presence at either root
  // means the peer is installed; absence is the degradation path.
  const voiceRoots = [
    path.resolve(EXT_DIR, "../../npm/node_modules/@juicesharp/rpiv-voice"),
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-voice"),
  ];
  const voicePresent = voiceRoots.some((r) => fs.existsSync(r));
  if (!voicePresent) {
    // Cold install (the docker harness): rpiv-voice is an OPTIONAL peer —
    // npm never fetches it, and voice transcription degrades off. Absence
    // is the graceful-degradation path, not a failure; presence is checked
    // by the same assertion below.
    check("voice: optional peer absent — degradation path, nothing to resolve", true);
  } else {
    check(
      "voice: rpiv-voice bundle resolves lazily under the pi loader",
      mods !== null && typeof mods.stt?.createSttEngine === "function" &&
        typeof mods.pcm?.bufferToFloat32 === "function" &&
        typeof mods.hal?.isHallucination === "function" &&
        typeof mods.model?.getModelPaths === "function",
      mods === null ? "null (store not found)" : "loaded",
    );
  }
}

finish();
