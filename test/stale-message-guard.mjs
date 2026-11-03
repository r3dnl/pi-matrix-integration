/**
 * Stale-message guard — the runnable check.
 *
 * A fresh client's first /sync and every limited-timeline backfill after a
 * disconnect arrive flagged live (matrix-js-sdk: liveEvent means "landed on
 * the live timeline"), so hours-old room history used to be injected as if it
 * had just been said. Proves the inbound funnel's age leg:
 *   1. a message older than maxMessageAgeMinutes is NOT injected;
 *   2. a fresh message still is;
 *   3. the burst is reported to the room ONCE, naming the timestamps and the
 *      thread root;
 *   4. the guard is configurable (0 disables it).
 *
 * Run: node test/stale-message-guard.mjs
 */
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck("stale-message-guard");

const { createInbound } = await jiti.import(`${EXT_DIR}/src/inbound.ts`);

const MIN = 60_000;

function build(cfgOverrides) {
  const injected = [];
  const posted = [];
  const warned = [];
  const inbound = createInbound({
    cfg: {
      slashRelay: false,
      mirrorAskUser: false,
      voiceTranscription: false,
      userId: "@pi_agent:example.org",
      maxMessageAgeMinutes: 30,
      ...cfgOverrides,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m) => warned.push(String(m)),
      error: () => {},
    },
    pi: { sendUserMessage: () => {}, getCommands: () => [] },
    threadManager: { enabled: () => false, activeRoot: () => undefined, adoptRoot: () => {} },
    mirror: { tryConsumeReply: () => false },
    roomUx: { handleArtifactAttach: () => false, handleFileAttach: () => false },
    messageHandler: {
      handleIncomingMessage: (m) => ({ type: "user", content: m.body, timestamp: 0 }),
      post: async (text, kind, opts) => {
        posted.push({ text, kind, html: opts?.html });
        return { success: true };
      },
    },
    sessionIntegrator: { injectMatrixMessage: (m) => injected.push(m.body) },
    voiceTranscriber: { transcribe: async () => ({ text: "" }) },
  });
  return { inbound, injected, posted, warned };
}

const msg = (eventId, ageMinutes, extra = {}) => ({
  eventId,
  sender: "@vincent:example.org",
  body: `body ${eventId}`,
  timestamp: Date.now() - ageMinutes * MIN,
  roomId: "!room:example.org",
  isFromPi: false,
  ...extra,
});

// 1 + 2 + 3: two stale messages (one threaded), one fresh.
const a = build({});
a.inbound.dispatch(msg("$old1", 200));
a.inbound.dispatch(msg("$old2", 275, { threadRoot: "$root9" }));
a.inbound.dispatch(msg("$fresh", 2));

check("stale: fresh message injected", a.injected.length === 1 && a.injected[0] === "body $fresh", JSON.stringify(a.injected));
check("stale: one warn line per dropped message", a.warned.length === 2, JSON.stringify(a.warned));
check("stale: warn names the age and the limit", /200 min old \(limit 30 min\)/.test(a.warned[0]), a.warned[0]);

await waitUntil(() => a.posted.length === 1, { timeoutMs: 6_000, label: "stale-drop notice" }).catch(() => {});
check("report: exactly one room notice for the burst", a.posted.length === 1, JSON.stringify(a.posted));
const notice = a.posted[0]?.text ?? "";
check("report: notice is a status post", a.posted[0]?.kind === "status", a.posted[0]?.kind);
check("report: counts both drops", /Dropped 2 message\(s\)/.test(notice), notice);
check("report: quotes the age limit", /older than 30 min/.test(notice), notice);
check("report: names the threaded drop with its thread root", notice.includes("(thread $root9)"), notice);
check("report: preview shows the dropped body", notice.includes("body $old1"), notice);
check("report: plain notice carries matrix.to links", notice.includes("[$old2](https://matrix.to/#/!room:example.org/$old2)"), notice);
const html = a.posted[0]?.html ?? "";
check("report: html carries clickable matrix.to event permalinks",
  html.includes('<a href="https://matrix.to/#/!room%3Aexample.org/%24old1">$old1</a>'), html);
check("report: html preview escapes nothing it shouldn't / includes body", html.includes("body $old2"), html);
check("report: no stale body leaked into the session", a.injected.length === 1, JSON.stringify(a.injected));

// 4: configurable — the threshold moves, and 0 turns the guard off.
const tight = build({ maxMessageAgeMinutes: 5 });
tight.inbound.dispatch(msg("$mid", 10));
check("config: tighter threshold drops a 10-minute-old message", tight.injected.length === 0, JSON.stringify(tight.injected));

const off = build({ maxMessageAgeMinutes: 0 });
off.inbound.dispatch(msg("$ancient", 10_000));
check("config: 0 disables the guard", off.injected.length === 1 && off.warned.length === 0, JSON.stringify(off.injected));

finish();
