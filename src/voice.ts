/**
 * Pi Matrix Integration — voice-message transcription.
 *
 * An `m.audio`/`m.voice` room message is downloaded, decoded to 16 kHz
 * mono PCM (ffmpeg), transcribed by the local Whisper engine (the
 * rpiv-voice leaf modules — the same chain dictate-local runs) and
 * handed back as text for the inbound funnel to inject as the sender's
 * message.
 *
 * Engine lifecycle mirrors dictate-local: the recognizer is created
 * lazily on the first voice message and kept warm for the process
 * lifetime (first use pays the ~0.4–1.5 s native load once; every
 * voice message after that decodes in ~100–300 ms).
 *
 * Media variants (observed content shapes):
 * - plain `mxc://` URL (plaintext rooms, or E2EE-off clients) — direct
 *   download;
 * - MSC4125 `content.file` object (Element "encrypted attachments") —
 *   download then decrypt with the in-event key (`matrix-encrypt-attachment`);
 * - SSS (`content.url` ending `org.matrix.msc2666.v1`, E2EE rooms) —
 *   the ciphertext is useless without the user's SSS key, which this
 *   device does not hold: reported as `sss-encrypted` so the caller can
 *   tell the user.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The rpiv-voice engine modules live in the pi npm store. pi's jiti
// loader only aliases pi-internal bare specifiers, so npm-store
// packages are reached by path — the dictate-local pattern. One
// deliberate delta from dictate-local: there the engine IS the
// extension, so a static import is right; HERE voice is one leg of a
// larger extension, so a missing package must drop the voice leg, never
// the module load. The imports are therefore lazy (first voice message)
// and tried against candidate roots: PI_RPIV_VOICE_PATH (explicit), the
// store relative to this file (the layout both extensions ship in), and
// ~/.pi/agent/npm (a different install location, e.g. a relocated home).
// NOTE(strict): the four engine modules resolve at runtime from the pi npm
// store by path (voiceRootCandidates), and the published package ships .ts
// sources whose own types pull optional native deps — so the surface is
// stated here from the call sites instead of `typeof import()`. If
// rpiv-voice changes a signature, update these lines; the casts at the load
// site below carry no compile-time check.
interface VoiceModelPaths {
  encoderPath: string;
  decoderPath: string;
  tokensPath: string;
}
interface VoiceSttEngine {
  recognize(samples: Float32Array, sampleRate: number): Promise<string>;
  release(): void;
}
type VoiceModules = {
  stt: { createSttEngine(modelPaths: VoiceModelPaths): Promise<VoiceSttEngine> };
  model: {
    isModelDownloaded(): boolean;
    getModelPaths(): VoiceModelPaths;
    assertModelIntact(): void;
    removeModelInstall(): void;
    ensureModelDownloaded(onProgress: (progress: unknown) => void, signal?: AbortSignal): Promise<VoiceModelPaths>;
  };
  pcm: { bufferToFloat32(buf: Buffer): Float32Array };
  hal: { isHallucination(text: string): boolean };
};
type SttEngine = VoiceSttEngine;

const VOICE_PACKAGE = "@juicesharp/rpiv-voice";

function voiceRootCandidates(logger: MatrixLogger): string[] {
  const roots: string[] = [];
  if (process.env.PI_RPIV_VOICE_PATH) roots.push(process.env.PI_RPIV_VOICE_PATH);
  try {
    roots.push(fileURLToPath(new URL(`../../../npm/node_modules/${VOICE_PACKAGE}`, import.meta.url)));
  } catch (error) {
    logger.debug(`[matrix] voice: import.meta.url root unavailable: ${error}`);
  }
  roots.push(join(homedir(), ".pi", "agent", "npm", "node_modules", VOICE_PACKAGE));
  return roots;
}

let modulesPromise: Promise<VoiceModules | null> | null = null;

/** Resolve the rpiv-voice module bundle once; null (logged) when no
 *  candidate root loads — the voice leg then drops, the extension
 *  stays up. A failed load is not cached: the next message retries.
 *  Specifier order covers both loaders: a plain absolute path (jiti's
 *  require path) then the file:// URL (native ESM import).
 *  Exported for the logic test — it runs under the same jiti loader Pi
 *  uses, so it verifies the resolution actually works in the runtime. */
export function loadVoiceModules(logger: MatrixLogger): Promise<VoiceModules | null> {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      for (const root of voiceRootCandidates(logger)) {
        const bundle = (base: string): Promise<[unknown, unknown, unknown, unknown]> =>
          Promise.all([
            import(`${base}/audio/stt-engine.js`),
            import(`${base}/audio/model-download.js`),
            import(`${base}/audio/pcm.js`),
            import(`${base}/audio/hallucination-filter.js`),
          ]);
        try {
          const mods = await bundle(root).catch(() => bundle(pathToFileURL(root).href));
          return {
            stt: mods[0] as VoiceModules["stt"],
            model: mods[1] as VoiceModules["model"],
            pcm: mods[2] as VoiceModules["pcm"],
            hal: mods[3] as VoiceModules["hal"],
          };
        } catch {
          // wrong root: try the next candidate
        }
      }
      logger.warn(`[matrix] voice: ${VOICE_PACKAGE} not found — voice leg disabled`);
      return null;
    })().catch((error) => {
      modulesPromise = null;
      logger.warn(`[matrix] voice: module load failed: ${error}`);
      return null;
    });
  }
  return modulesPromise;
}

import type { MatrixMessage } from "./types.js";
import type { MatrixLogger } from "./logger.js";

// ── Tuning (dictate-local's proven values) ──────────────────────────────────
const SAMPLE_RATE = 16000; // Whisper's fixed input rate
/** Decode + ffmpeg budgets (ms). A 15 min clip on CPU must fit. */
const FFMPEG_TIMEOUT_MS = 60_000;
/** Recognition budget (ms) — the Promise.race guard around
 *  engine.recognize (a hung native decode must never wedge the voice
 *  leg; dictate-local's finalize safety net). */
const RECOGNIZE_TIMEOUT_MS = 60_000;
// ── Remote STT leg (OpenAI-shaped endpoint, remote-primary) ────────────────
/** Remote budget (ms): the server may cold-load its model on the first
 *  call (~30 s observed on mlx-audio); beyond this the attempt is
 *  abandoned and the local chain runs. Voice is already fire-and-forget,
 *  so a generous budget costs latency, never a dropped message. */
const REMOTE_STT_TIMEOUT_MS = 45_000;

/** Longer than this is not a voice message (info.duration is ms). */
const MAX_DURATION_MS = 15 * 60 * 1000;
/** Shorter than this carries no speech (0.3 s of int16 samples). */
const MIN_PCM_BYTES = 2 * SAMPLE_RATE * 0.3;
/** The E2EE SSS ciphertext filename marker (Element's media encryption). */
const SSS_FILENAME = "org.matrix.msc2666.v1";

export interface VoiceTranscribeResult {
  /** The transcript (caller injects it as the sender's text). */
  text?: string;
  /** Set when the media is SSS-encrypted and this device cannot decrypt
   *  it — the caller should tell the user (a log-only failure would look
   *  like a silently dropped message). */
  sss?: boolean;
  /** Room-safe one-line reason when transcription failed — the caller
   *  posts it so the sender learns what happened instead of watching a
   *  silent drop. Internal error detail (paths, stderr) stays in the
   *  log; only this classified reason crosses into the room. */
  fail?: string;
  /** Which engine produced the text — the configured remote model id, or
   *  the local model directory name suffixed "(local)". Posted into the
   *  room next to the transcript so the sender sees who transcribed. */
  engine?: string;
}

export interface VoiceTranscriberDeps {
  logger: MatrixLogger;
  /** Authenticated media download (`mxc://…` → bytes, null on failure). */
  download: (mxcUrl: string) => Promise<Buffer | null>;
  /** OpenAI-shaped remote STT base (e.g. `http://192.168.2.11:8002/v1`).
   *  Set = remote-primary: the clip is POSTed to
   *  `{sttBaseUrl}/audio/transcriptions` before the local engine runs;
   *  any remote failure falls back to it. Unset = local-only (default). */
  sttBaseUrl?: string;
  /** Model id sent to the remote endpoint (`sttBaseUrl` only). */
  sttModel?: string;
}

export interface VoiceTranscriber {
  /** Transcribe one voice message. Never throws — failures resolve to
   *  an empty result (the caller logs). */
  transcribe(message: MatrixMessage): Promise<VoiceTranscribeResult>;
}

export function createVoiceTranscriber(deps: VoiceTranscriberDeps): VoiceTranscriber {
  const { logger, download } = deps;

  // ── Warm engine (process-lifetime cache, dictate-local's policy) ──────
  let enginePromise: Promise<SttEngine> | null = null;
  function getEngine(): Promise<SttEngine> {
    if (!enginePromise) {
      enginePromise = (async () => {
        const mods = await loadVoiceModules(logger);
        if (!mods) throw new Error(`${VOICE_PACKAGE} unavailable`);
        if (!mods.model.isModelDownloaded()) {
          await mods.model.ensureModelDownloaded(() => undefined);
        }
        // Corrupt/partial install → drop + redownload (rpiv-voice's
        // recovery, reused verbatim from dictate-local).
        try {
          mods.model.assertModelIntact();
        } catch {
          mods.model.removeModelInstall();
          await mods.model.ensureModelDownloaded(() => undefined);
          mods.model.assertModelIntact();
        }
        return mods.stt.createSttEngine(mods.model.getModelPaths());
      })().catch((error) => {
        // Reset so the next voice message retries with a fresh attempt
        // (a failed load must not poison the cache).
        enginePromise = null;
        logger.warn(`[matrix] voice: engine load failed: ${error}`);
        throw error;
      });
    }
    return enginePromise;
  }

  // ── ffmpeg: ogg/opus (or anything ffmpeg reads) → 16 kHz mono s16le ──
  function decodeToPcm(media: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        ["-v", "error", "-i", "pipe:0", "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
      );
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => {
        ff.kill("SIGKILL");
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS} ms`));
      }, FFMPEG_TIMEOUT_MS);
      ff.stdout.on("data", (d: Buffer) => out.push(d));
      ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
      ff.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ff.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(out));
        } else {
          reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 300) || "unknown error"}`));
        }
      });
      ff.stdin.on("error", () => undefined); // EPIPE when ffmpeg dies early
      ff.stdin.end(media);
    });
  }

  // ── MSC4125 in-event-key decrypt (Element "encrypted attachments") ───
  async function decryptMsc4125(data: Buffer, file: Record<string, unknown>): Promise<Buffer> {
    const mod = await import("matrix-encrypt-attachment");
    const decryptAttachment =
      mod.decryptAttachment ?? (mod as unknown as { default?: typeof mod }).default?.decryptAttachment;
    if (!decryptAttachment) throw new Error("matrix-encrypt-attachment unavailable");
    // The Buffer may be a view over a pool — hand over an owned ArrayBuffer.
    const owned = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return Buffer.from(
      await decryptAttachment(owned, file as unknown as Parameters<typeof decryptAttachment>[1]),
    );
  }

  // ── Remote STT: OpenAI-shaped multipart POST, clip bytes as-is ─────────
  // Returns the transcript, or null when the leg is off or failed (logged)
  // — the caller then runs the local chain. Never throws: the remote is
  // an optimization, the local engine is the guarantee.
  async function transcribeRemote(media: Buffer): Promise<string | null> {
    const base = deps.sttBaseUrl?.replace(/\/+$/, "");
    if (!base) return null;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(media)]), "voice.ogg");
      form.append("model", deps.sttModel ?? "");
      form.append("response_format", "json");
      const res = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(REMOTE_STT_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn(`[matrix] voice: remote STT HTTP ${res.status} — falling back to the local engine`);
        return null;
      }
      const text = String(((await res.json()) as { text?: unknown }).text ?? "").trim();
      if (!text) {
        logger.warn("[matrix] voice: remote STT returned no text — falling back to the local engine");
        return null;
      }
      return text;
    } catch (error) {
      logger.warn(
        `[matrix] voice: remote STT failed (${String(error).slice(0, 120)}) — falling back to the local engine`,
      );
      return null;
    }
  }

  return {
    async transcribe(message): Promise<VoiceTranscribeResult> {
      const url = message.mediaUrl;
      if (!url) {
        logger.warn(`[matrix] voice ${message.eventId}: no media URL`);
        return { fail: "the message carries no downloadable media attachment" };
      }

      // E2EE SSS media: the ciphertext is useless without the user's SSS
      // key (this device does not hold one) — report it, do not download.
      const lastSegment = url.split("?")[0].split("/").pop() ?? "";
      if (lastSegment === SSS_FILENAME) {
        logger.debug(`[matrix] voice ${message.eventId}: SSS-encrypted media (undecryptable on this device)`);
        return { sss: true };
      }

      // Guard against non-voice media (a 2-hour ogg is not a voice note).
      const duration = message.mediaInfo?.duration;
      if (typeof duration === "number" && duration > MAX_DURATION_MS) {
        logger.warn(`[matrix] voice ${message.eventId}: ${Math.round(duration / 60000)} min exceeds the ${MAX_DURATION_MS / 60000} min voice cap`);
        return { fail: `the clip is longer than the ${MAX_DURATION_MS / 60000} minute voice cap` };
      }

      let media = await download(url);
      if (!media || media.byteLength === 0) {
        logger.warn(`[matrix] voice ${message.eventId}: media download failed`);
        return { fail: "the media download from the homeserver failed" };
      }

      // MSC4125: the event carries its own key — decrypt before decode.
      if (message.mediaFile && typeof message.mediaFile.key === "object" && message.mediaFile.key !== null) {
        try {
          media = await decryptMsc4125(media, message.mediaFile);
        } catch (error) {
          logger.warn(`[matrix] voice ${message.eventId}: MSC4125 decrypt failed: ${error}`);
          return { fail: "the encrypted attachment could not be decrypted" };
        }
      }

      // Remote-primary, local-fallback: the endpoint takes the clip bytes
      // (already MSC4125-decrypted); empty/failure falls through to the
      // local chain below, which owns the failure classification.
      const remote = await transcribeRemote(media);
      if (remote) {
        logger.debug(`[matrix] voice ${message.eventId}: remote STT → "${remote.slice(0, 60)}"`);
        return { text: remote, engine: deps.sttModel?.trim() || "remote STT" };
      }

      let pcm: Buffer;
      try {
        pcm = await decodeToPcm(media);
      } catch (error) {
        logger.warn(`[matrix] voice ${message.eventId}: decode failed: ${error}`);
        // ENOENT means the ffmpeg binary is missing on the bridge host —
        // the one failure mode the operator can actually fix, so name it.
        const enoent = /ENOENT/.test(String(error));
        return {
          fail: enoent
            ? "audio decoding needs ffmpeg, which is not installed on the bridge host"
            : "the audio could not be decoded (unsupported or corrupt media)",
        };
      }
      if (pcm.byteLength < MIN_PCM_BYTES) {
        logger.debug(`[matrix] voice ${message.eventId}: no speech (pcm ${pcm.byteLength} bytes)`);
        return { fail: "no speech detected — the clip was too short or silent" };
      }

      // The recognition + timeout race (dictate-local's finalize safety
      // net: a hung native call must never wedge the voice leg forever).
      let engine: SttEngine;
      try {
        engine = await getEngine();
      } catch {
        return { fail: "the local speech-recognition engine failed to load (see the bridge log)" }; // already logged
      }
      const mods = await loadVoiceModules(logger);
      if (!mods) return { fail: "the local speech-recognition engine is not installed" }; // already logged
      let text: string;
      try {
        text = await Promise.race([
          engine.recognize(mods.pcm.bufferToFloat32(pcm), SAMPLE_RATE),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`recognition timed out after ${RECOGNIZE_TIMEOUT_MS} ms`)), RECOGNIZE_TIMEOUT_MS),
          ),
        ]);
      } catch (error) {
        logger.warn(`[matrix] voice ${message.eventId}: recognition failed: ${error}`);
        return { fail: "speech recognition failed or timed out (see the bridge log)" };
      }
      text = text.trim();
      if (!text || mods.hal.isHallucination(text)) {
        logger.debug(`[matrix] voice ${message.eventId}: empty or hallucinated transcript`);
        return { fail: "no speech detected — the clip was silent or unclear" };
      }
      logger.debug(`[matrix] voice ${message.eventId}: transcribed ${pcm.byteLength / 2 / SAMPLE_RATE}s → "${text.slice(0, 60)}"`);
      // Engine identity for the room echo: the model directory name
      // (~/.pi/models/whisper-base → "whisper-base"), read from the
      // module's own paths so the string never drifts from what loads.
      const localModel = basename(dirname(mods.model.getModelPaths().decoderPath)) || "whisper";
      return { text, engine: `${localModel} (local)` };
    },
  };
}
