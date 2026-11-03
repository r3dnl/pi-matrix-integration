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
if (!have("say") || !have("ffmpeg")) {
  console.log("SKIP  voice fixture tools missing (say/ffmpeg) — chain untestable on this host");
  process.exit(0);
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
