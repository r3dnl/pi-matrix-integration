/**
 * Voice transcription (backlog #4) — the runnable check.
 *
 * Proves the full chain on a real fixture:
 *   1. parseMatrixEvent carries msgtype/mediaUrl/mediaInfo/mediaFile;
 *   2. the transcriber downloads (fake), decodes (ffmpeg) and transcribes
 *      (local Whisper — the dictate-local chain) an ogg/opus voice clip;
 *   3. the SSS (E2EE) media shape short-circuits without a download;
 *   4. the inbound funnel's voice leg injects the transcript as the
 *      sender's message (the "[voice] …" expansion).
 *
 * The fixture is a real macOS TTS recording re-encoded to ogg/opus (the
 * exact codec Element voice messages use). Skips cleanly when `say` or
 * `ffmpeg` is missing (the chain is then untestable on this host).
 *
 * Run: node test/voice-transcribe.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("voice-transcribe");

// ── fixture: real speech → ogg/opus (Element's voice codec) ──────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-tx-"));
function have(cmd) {
  try {
    execFileSync(cmd, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── 0. failure reasons (fixture-free: no audio needed) ───────────────────
// A dropped voice message must carry a room-safe reason (inbound.ts posts
// it to the room instead of dropping silently). These two paths never
// reach ffmpeg, so they run even when the fixture tools are missing.
const { createVoiceTranscriber: makeTx } = await jiti.import(path.join(EXT_DIR, "src/voice.ts"));
const failTx = makeTx({ logger: { warn() {}, debug() {} }, download: async () => null });
const baseMsg = { eventId: "$f1", sender: "@u:e.org", body: "x.ogg", timestamp: 1, roomId: "!r:e.org", isFromPi: false, msgtype: "m.audio" };
const noUrl = await failTx.transcribe({ ...baseMsg });
check("fail: no media URL names the cause", /no downloadable media/.test(noUrl.fail ?? ""), JSON.stringify(noUrl));
const noDownload = await failTx.transcribe({ ...baseMsg, eventId: "$f2", mediaUrl: "mxc://x/y" });
check("fail: failed download names the cause", /download/.test(noDownload.fail ?? ""), JSON.stringify(noDownload));
check("fail: failures never carry text or throw", !noUrl.text && !noDownload.text && !noUrl.sss);

// ── 0b. remote STT leg (stub server: no ffmpeg/say needed) ─────────────────
// Remote-primary, local-fallback: a configured OpenAI-shaped endpoint is
// tried first with the clip bytes; any failure falls back to the local
// chain. The stub proves the request contract (multipart file/model/
// response_format) and the fallthrough. The 45 s timeout constant is not
// exercised — the 500 case covers the same catch/fallback shape.
const { createServer } = await import("node:http");
function stubStt(respond) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((req, res) => {
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        seen.push({ url: req.url, contentType: req.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
        respond(res);
      });
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ base: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => srv.close() }),
    );
  });
}
const fakeOgg = Buffer.from("fake-ogg-bytes");
const remoteTx = (base, model) =>
  makeTx({
    logger: { warn() {}, debug() {} },
    download: async () => fakeOgg,
    sttBaseUrl: base,
    sttModel: model,
  });
const remoteMsg = { ...baseMsg, eventId: "$r1", mediaUrl: "mxc://x/r1" };

// Happy path: 200 + text wins, request carries the contract fields.
const okStub = await stubStt((res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text: "remote says hi" }));
});
const okRes = await remoteTx(okStub.base, "test-model").transcribe(remoteMsg);
check("remote: 200+text used as transcript", okRes.text === "remote says hi", JSON.stringify(okRes));
check("remote: engine attributed to the model id", okRes.engine === "test-model", JSON.stringify(okRes));
check("remote: POST hit /audio/transcriptions", okStub.seen[0]?.url === "/v1/audio/transcriptions", okStub.seen[0]?.url);
check(
  "remote: multipart carries clip + model + json format",
  /multipart\/form-data/.test(okStub.seen[0]?.contentType ?? "") &&
    okStub.seen[0]?.body.includes("fake-ogg-bytes") &&
    okStub.seen[0]?.body.includes("test-model") &&
    okStub.seen[0]?.body.includes("response_format"),
  okStub.seen[0]?.contentType,
);
okStub.close();

// Failure paths fall back to the local chain: 500 and empty-text both
// hand over, and the fake bytes then fail local decode — so the result
// must be a classified failure, never the remote error, never a throw.
const badStub = await stubStt((res) => {
  res.writeHead(500);
  res.end("boom");
});
const http500 = await remoteTx(badStub.base, "m").transcribe(remoteMsg);
check(
  "remote: HTTP 500 falls back (no text, classified fail)",
  !http500.text && !!http500.fail,
  JSON.stringify(http500),
);
badStub.close();

const emptyStub = await stubStt((res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text: "" }));
});
const emptyRes = await remoteTx(emptyStub.base, "m").transcribe(remoteMsg);
check("remote: empty text falls back", !emptyRes.text && !!emptyRes.fail, JSON.stringify(emptyRes));
emptyStub.close();

// Unreachable endpoint (connect refused) falls back the same way.
const gone = await remoteTx("http://127.0.0.1:1/v1", "m").transcribe(remoteMsg);
check("remote: unreachable endpoint falls back", !gone.text && !!gone.fail, JSON.stringify(gone));

// No baseUrl configured = local-only, remote leg never runs (regression:
// default deployments stay exactly as before).
const localOnly = await makeTx({ logger: { warn() {}, debug() {} }, download: async () => fakeOgg }).transcribe(remoteMsg);
check("remote: unset baseUrl keeps the leg off", !localOnly.text && !!localOnly.fail, JSON.stringify(localOnly));

// ── 0c. the room echo: transcript + engine attribution ────────────────────
// A voice message that transcribes must answer in the room with the text
// and the engine name — and still inject into the session (fixture-free:
// the transcriber is stubbed here, the funnel leg is the real code).
{
  const { createInbound } = await jiti.import(path.join(EXT_DIR, "src/inbound.ts"));
  const echoed = [];
  const echoedIn = [];
  const echoInbound = createInbound({
    cfg: { voiceTranscription: true, slashRelay: false, mirrorAskUser: false },
    logger: { warn() {}, debug() {} },
    pi: { sendUserMessage: () => {}, getCommands: () => [] },
    threadManager: { enabled: () => false, activeRoot: () => undefined, adoptRoot: () => {} },
    mirror: { tryConsumeReply: () => false },
    roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
    messageHandler: {
      handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
      post: async (text) => { echoed.push(text); return { success: true }; },
    },
    sessionIntegrator: { injectMatrixMessage: (m) => echoedIn.push(m.body) },
    voiceTranscriber: { transcribe: async () => ({ text: "echo me", engine: "whisper-small (test)" }) },
  });
  // Fresh timestamp: the stale-message guard (30 min) drops epoch-0
  // messages before the voice leg — same as a real relay would.
  echoInbound.dispatch({ ...baseMsg, eventId: "$echo1", timestamp: Date.now(), mediaUrl: "mxc://x/echo" });
  try {
    await waitUntil(() => echoed.length === 1, { timeoutMs: 5_000, label: "voice room echo" });
  } catch {
    /* checked below */
  }
  check(
    "echo: room gets transcript + engine",
    echoed[0]?.includes("echo me") && echoed[0]?.includes("whisper-small (test)"),
    JSON.stringify(echoed),
  );
  check("echo: session injection still happens", echoedIn[0]?.startsWith("[voice] echo me"), JSON.stringify(echoedIn));
}

// ── 0d. echo threading: same route logic as text turns ───────────────────
// (1) A voice message in a pending session opens the root with the
// TRANSCRIPT as topic (not the filename body) — before the echo posts,
// so the echo rides the thread. (2) A voice message that carries a
// threadRoot adopts it and the echo is posted without `flat` (routing is
// the messageHandler's; inbound must not force it flat).
{
  const { createInbound } = await jiti.import(path.join(EXT_DIR, "src/inbound.ts"));
  // (1) pending session: root topic = transcript, root lands before echo
  // (the order[] ledger proves the root-first invariant).
  const topics = [];
  const order = [];
  let pending = true;
  const pendingEchoed = [];
  const pendingInbound = createInbound({
    cfg: { voiceTranscription: true, slashRelay: false, mirrorAskUser: false },
    logger: { warn() {}, debug() {} },
    pi: { sendUserMessage: () => {}, getCommands: () => [] },
    threadManager: {
      enabled: () => true,
      pending: () => pending,
      activeRoot: () => undefined,
      adoptRoot: () => {},
      ensureThreadRoot: async (topic) => {
        topics.push(topic);
        order.push("root");
        pending = false; // the real manager switches pending → active here
        return { eventId: "$root1", topic };
      },
    },
    mirror: { tryConsumeReply: () => false },
    roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
    messageHandler: {
      handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
      post: async (text, kind, opts) => { order.push("echo"); pendingEchoed.push({ text, opts }); return { success: true }; },
    },
    sessionIntegrator: { injectMatrixMessage: () => {} },
    voiceTranscriber: { transcribe: async () => ({ text: "open a thread please", engine: "test-engine" }) },
  });
  pendingInbound.dispatch({ ...baseMsg, eventId: "$th1", body: "voice-message-recording.ogg", timestamp: Date.now(), mediaUrl: "mxc://x/th1" });
  let pendingOk = true;
  try {
    await waitUntil(() => pendingEchoed.length === 1, { timeoutMs: 5_000, label: "threaded voice echo" });
  } catch {
    pendingOk = false;
  }
  check(
    "thread: root topic is the transcript, not the filename",
    topics[0] === "open a thread please" && !topics.some((t) => /\.ogg/.test(t)),
    JSON.stringify(topics),
  );
  check("thread: root is created before the echo posts", order.join(",") === "root,echo", JSON.stringify(order));
  check(
    "thread: echo is posted WITHOUT flat (rides the active thread)",
    pendingOk && pendingEchoed[0]?.opts?.flat !== true,
    JSON.stringify(pendingEchoed),
  );

  // (2) threaded voice message in a thread other than the active one:
  // the funnel adopts it (follow-the-user), no new root, echo not flat.
  const adopted = [];
  const threadedEchoed = [];
  const threadedInbound = createInbound({
    cfg: { voiceTranscription: true, slashRelay: false, mirrorAskUser: false },
    logger: { warn() {}, debug() {} },
    pi: { sendUserMessage: () => {}, getCommands: () => [] },
    threadManager: {
      enabled: () => true,
      pending: () => false,
      activeRoot: () => ({ eventId: "$other-thread", topic: "t" }),
      adoptRoot: (r) => adopted.push(r),
      ensureThreadRoot: async () => { throw new Error("must not open a second root"); },
    },
    mirror: { tryConsumeReply: () => false },
    roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
    messageHandler: {
      handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
      post: async (text, kind, opts) => { threadedEchoed.push({ text, opts }); return { success: true }; },
    },
    sessionIntegrator: { injectMatrixMessage: () => {} },
    voiceTranscriber: { transcribe: async () => ({ text: "in a thread", engine: "test-engine" }) },
  });
  threadedInbound.dispatch({ ...baseMsg, eventId: "$th2", timestamp: Date.now(), mediaUrl: "mxc://x/th2", threadRoot: "$existing" });
  let threadedOk = true;
  try {
    await waitUntil(() => threadedEchoed.length === 1, { timeoutMs: 5_000, label: "thread-adopted voice echo" });
  } catch {
    threadedOk = false;
  }
  check("thread: existing root adopted once", adopted.length === 1 && adopted[0] === "$existing", JSON.stringify(adopted));
  check(
    "thread: echo not flat, no second root opened",
    threadedOk && threadedEchoed[0]?.opts?.flat !== true && threadedEchoed[0]?.text.includes("in a thread"),
    JSON.stringify(threadedEchoed),
  );
}

if (!have("say") || !have("ffmpeg")) {
  console.log("SKIP  voice fixture chain (say/ffmpeg missing) — section 0 checks above still apply");
  finish(); // must run: the section-0 failures have to reach the exit code
}
const aiff = path.join(tmp, "speech.aiff");
const ogg = path.join(tmp, "voice.ogg");
execFileSync("say", ["-o", aiff, "The quick brown fox jumps over the lazy dog"]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", aiff, "-c:a", "libopus", "-b:a", "24k", ogg]);
const media = fs.readFileSync(ogg);
check("fixture: ogg/opus fixture generated", media.byteLength > 1000, `${media.byteLength} bytes`);

// ── 1. parseMatrixEvent carries the media fields ─────────────────────────
const { parseMatrixEvent } = await jiti.import(path.join(EXT_DIR, "src/thread-meta.ts"));
const realVoiceEvent = {
  type: "m.room.message",
  event_id: "$voice1",
  origin_server_ts: 1_700_000_000_000,
  sender: "@vincent:example.org",
  room_id: "!room:example.org",
  content: {
    msgtype: "m.audio",
    body: "voice-message-recording.ogg",
    url: "mxc://matrix.example.org/abc123",
    info: { duration: 3100, mimetype: "audio/ogg", size: 19252 },
    "org.matrix.msc1767.audio": { duration: 3100, waveform: [1, 2, 3] },
  },
};
const parsed = parseMatrixEvent(realVoiceEvent, "@pi:example.org", "!room:example.org");
check("parse: msgtype carried", parsed?.msgtype === "m.audio", parsed?.msgtype);
check("parse: mediaUrl carried", parsed?.mediaUrl === "mxc://matrix.example.org/abc123", parsed?.mediaUrl);
check("parse: mediaInfo carried", parsed?.mediaInfo?.duration === 3100);
check("parse: body is the filename (unchanged)", parsed?.body === "voice-message-recording.ogg");

// MSC4125: the file.url wins over content.url.
const msc4125Event = {
  ...realVoiceEvent,
  event_id: "$voice2",
  content: {
    ...realVoiceEvent.content,
    url: "mxc://matrix.example.org/cipher",
    file: { url: "mxc://matrix.example.org/real-media", v: "v2", key: { kty: "oct", k: "AAAA" }, iv: "BBBB" },
  },
};
const parsed2 = parseMatrixEvent(msc4125Event, "@pi:example.org", "!room:example.org");
check("parse: MSC4125 file.url wins", parsed2?.mediaUrl === "mxc://matrix.example.org/real-media", parsed2?.mediaUrl);
check("parse: MSC4125 mediaFile carried", parsed2?.mediaFile?.iv === "BBBB");

// ── 2. the transcriber: download → ffmpeg → Whisper ──────────────────────
const { createVoiceTranscriber } = await jiti.import(path.join(EXT_DIR, "src/voice.ts"));
const downloads = [];
const quietLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const transcriber = createVoiceTranscriber({
  logger: quietLogger,
  download: async (url) => {
    downloads.push(url);
    return url === "mxc://matrix.example.org/abc123" ? media : null;
  },
});

const t0 = Date.now();
const result = await transcriber.transcribe({
  ...parsed,
  body: "voice-message-recording.ogg",
});
const took = Date.now() - t0;
check("transcribe: exactly one download", downloads.length === 1, JSON.stringify(downloads));
check("transcribe: produced text", typeof result.text === "string" && result.text.length > 0, JSON.stringify(result));
check(
  "transcribe: recognized the phrase",
  typeof result.text === "string" && /quick|brown|fox|jumps|lazy|dog/i.test(result.text),
  JSON.stringify(result.text),
);
console.log(`  (transcript: "${result.text}" — ${took} ms incl. first engine load)`);

// SSS short-circuit: no download attempt at all.
const downloadsBefore = downloads.length;
const sssResult = await transcriber.transcribe({
  eventId: "$voice3",
  sender: "@vincent:example.org",
  body: "Voice message",
  timestamp: 1,
  roomId: "!room:example.org",
  isFromPi: false,
  msgtype: "m.audio",
  mediaUrl: "mxc://matrix.example.org/deadbeef/org.matrix.msc2666.v1",
});
check("sss: flagged undecryptable", sssResult.sss === true, JSON.stringify(sssResult));
check("sss: no download attempted", downloads.length === downloadsBefore, `${downloads.length}`);

// Undownloadable media → empty result (a log-only failure, never a throw).
const badResult = await transcriber.transcribe({
  eventId: "$voice4",
  sender: "@vincent:example.org",
  body: "x.ogg",
  timestamp: 1,
  roomId: "!room:example.org",
  isFromPi: false,
  msgtype: "m.audio",
  mediaUrl: "mxc://matrix.example.org/missing",
});
check("fail: missing media resolves empty (no throw)", !badResult.text && !badResult.sss, JSON.stringify(badResult));
check("fail: missing media names the download cause", /download/.test(badResult.fail ?? ""), JSON.stringify(badResult));

// ── 3. the funnel leg: transcript injected as the sender's message ───────
const { createInbound } = await jiti.import(path.join(EXT_DIR, "src/inbound.ts"));
const injected = [];
const inbound = createInbound({
  cfg: { voiceTranscription: true, slashRelay: false, mirrorAskUser: false },
  logger: quietLogger,
  pi: { sendUserMessage: () => {}, getCommands: () => [] },
  threadManager: { enabled: () => false, activeRoot: () => undefined, adoptRoot: () => {} },
  mirror: { tryConsumeReply: () => false },
  roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
  messageHandler: {
    handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
    post: async () => ({ success: true }),
  },
  sessionIntegrator: {
    injectMatrixMessage: (m, piMsg) => {
      injected.push({ body: m.body, pi: piMsg.content, sender: m.sender });
    },
  },
  voiceTranscriber: transcriber,
});

// Give the async leg a moment to settle (it is fire-and-forget by design):
// wait for the actual condition (the decode takes ~300 ms, the 50 ms sleep
// below the old version was a race).
inbound.dispatch({ ...parsed, isFromPi: false, threadRoot: undefined });
try {
  await waitUntil(() => injected.length === 1, { timeoutMs: 15_000, label: "voice injection" });
} catch {
  /* checked below */
}
check("funnel: voice message injected once", injected.length === 1, JSON.stringify(injected));
check(
  "funnel: injected body is the transcript, prefixed",
  injected[0]?.body?.startsWith("[voice] ") && /fox|quick|dog/i.test(injected[0]?.body ?? ""),
  injected[0]?.body,
);
check("funnel: sender attribution preserved", injected[0]?.sender === "@vincent:example.org");

// A plain text message must NOT take the voice leg (regression guard).
inbound.dispatch({
  eventId: "$text1",
  sender: "@vincent:example.org",
  body: "plain hello",
  timestamp: 2,
  roomId: "!room:example.org",
  isFromPi: false,
});
await new Promise((r) => setTimeout(r, 20));
check("funnel: plain text falls through to normal injection", injected[1]?.body === "plain hello", JSON.stringify(injected[1]));

finish();
