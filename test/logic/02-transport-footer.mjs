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
const { createSessionIntegrator } = await jiti.import(path.join(EXT_DIR, "src/session-integration.ts"));
const { createTuiFooter } = await jiti.import(path.join(EXT_DIR, "src/tui-footer.ts"));
// ============================================================================
// matrix-http transport gate (DESIGN-TRANSPORT-AND-IDENTITY steps 3/4)
// ============================================================================
const { UnreadModel: UnreadModelM } = await jiti.import(path.join(EXT_DIR, "src/unread-model.ts"));
const { extractThreadMeta, parseMatrixEvent } = await jiti.import(path.join(EXT_DIR, "src/thread-meta.ts"));

console.log("== thread-meta (shared helper, §3.3) ==");
{
  const c = { body: "hi" };
  check("flat: no thread fields", extractThreadMeta(c).isThreadRoot === false && extractThreadMeta(c).threadRoot === undefined, "");
  check(
    "root: content[m.thread] → isThreadRoot",
    extractThreadMeta({ body: "x", "m.thread": { "m.topological_ordering": 1 } }).isThreadRoot === true,
    "",
  );
  check(
    "reply (spec m.relates_to m.thread) nests under its root",
    extractThreadMeta({ body: "x", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } }).threadRoot === "$root",
    "",
  );
  check(
    "legacy MSC1767 thread_root nests under its root",
    extractThreadMeta({ body: "x", "org.matrix.msc1767.thread_root": "$root" }).threadRoot === "$root",
    "",
  );
  const flat = parseMatrixEvent(
    { event_id: "$f", sender: "@u:x", type: "m.room.message", origin_server_ts: 1, content: { body: "flat" } },
    "@self:x", "!room:x",
  );
  check("parseMatrixEvent: flat message", flat?.body === "flat" && flat?.isFromPi === false && flat?.threadRoot === undefined, JSON.stringify(flat));
  const rx = parseMatrixEvent(
    { event_id: "$r", sender: "@u:x", type: "m.reaction", origin_server_ts: 2,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t", key: "👍" } } },
    "@self:x", "!room:x",
  );
  check("parseMatrixEvent: reaction carries reactionKey/parentEventId", rx?.reactionKey === "👍" && rx?.parentEventId === "$t", JSON.stringify(rx));
  check("parseMatrixEvent: self event is isFromPi",
    parseMatrixEvent({ event_id: "$s", sender: "@self:x", type: "m.room.message", origin_server_ts: 3, content: { body: "me" } }, "@self:x", "!room:x")?.isFromPi === true, "");
  check("parseMatrixEvent: state/membership → null", parseMatrixEvent({ event_id: "$m", sender: "@u:x", type: "m.room.member", content: { membership: "join" } }, "@self:x") === null, "");
  // Edit placeholder (m.replace: body "edited" + m.new_content) is NOT a
  // message: a sibling pi session sharing the login account would otherwise
  // have its edits injected as a literal "edited" chat line (shared-account
  // semantics force isFromPi=false on every surviving event).
  check(
    "parseMatrixEvent: edit placeholder (m.new_content) → null",
    parseMatrixEvent(
      { event_id: "$e", sender: "@self:x", type: "m.room.message", origin_server_ts: 4,
        content: { body: "edited", "m.new_content": { msgtype: "m.text", body: "hi (edited)" } } },
      "@self:x", "!room:x",
    ) === null,
    "",
  );
  check(
    "parseMatrixEvent: a genuine message whose body IS 'edited' survives",
    parseMatrixEvent(
      { event_id: "$g", sender: "@u:x", type: "m.room.message", origin_server_ts: 5, content: { body: "edited" } },
      "@self:x", "!room:x",
    )?.body === "edited",
    "",
  );
}

console.log("== machine-traffic guard (sibling session broadcasts) ==");
{
  const { isPiMachineTraffic } = await jiti.import(path.join(EXT_DIR, "src/classify.ts"));
  check("final broadcast prefix drops", isPiMachineTraffic("💬 Pi: hello") === true, "");
  check("milestone prefix drops", isPiMachineTraffic("🎯 Milestone: Pi session started") === true, "");
  check("user broadcast prefix drops", isPiMachineTraffic("🧑 User: how was it fixed?") === true, "");
  check("thread root marker drops", isPiMachineTraffic("🧵 New Conversation: some topic") === true, "");
  check("decision post drops", isPiMachineTraffic("🤖 Pi decision (RPIV) — 1 question.") === true, "");
  check("genuine human chat passes", isPiMachineTraffic("how was it fixed?") === false, "");
  check("empty body passes", isPiMachineTraffic("") === false, "");
  // A configured icon must not disarm the guard (finding 7): the operator
  // sends "✅ Milestone: …", the sibling's body opens with it, and a miss
  // would inject it as a prompt.
  const icons = { milestoneIcon: "✅", userMessageIcon: "🙋", threadIcon: "🧶" };
  check("custom milestone icon drops", isPiMachineTraffic("✅ Milestone: done", icons) === true, "");
  check("custom user icon drops", isPiMachineTraffic("🙋 User: hello", icons) === true, "");
  check("custom thread icon drops", isPiMachineTraffic("🧶 New Conversation: t", icons) === true, "");
  check("default icon still drops with custom config", isPiMachineTraffic("🎯 Milestone: done", icons) === true, "");
}

// The matrix-http poll gate region (watermark / D1 / degrade / shadow-diff-
// dry) is deleted: the facade poller and its transport-selection / shadow-
// diff config keys die with the facade transport, and the single SdkOutbox
// has no outbox analogue for those keys (recorded in the Slice-6 Design
// History).

// ---- footer: matrix URI + thread indicator --------------------------------
console.log("== footer: matrix URI + thread indicator ==");
{
  const baseStatus = {
    connected: true, connecting: false,
    roomId: "#pi-updates:matrix.r3d.nl", lastError: undefined,
  };
  const plain = (s) => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const footer = (status, threadStatus) => {
    let out;
    const integrator = createSessionIntegrator({}, () => status, {
      showInFooter: true,
      getThreadStatus: threadStatus,
    });
    integrator.updateFooterStatus({ ui: { setStatus: (_k, text) => { out = text; } } });
    return out;
  };

  // Matrix URI convention: user:domain/#room, each part in its own color.
  const withUser = footer(
    { ...baseStatus, userId: "@pi_agent:matrix.r3d.nl" },
    () => ({ icon: "🧵", enabled: true }),
  );
  check(
    "matrix URI convention → [💬 user:domain/#room 🧵 on]",
    plain(withUser) === "[💬 pi_agent:matrix.r3d.nl/#pi-updates 🧵 on]",
    JSON.stringify(withUser),
  );
  check(
    "user/domain/room each carry their own ANSI color",
    withUser?.includes("\u001b[36mpi_agent\u001b[39m") === true &&
      withUser?.includes("\u001b[38;5;208mmatrix.r3d.nl\u001b[39m") === true &&
      withUser?.includes("\u001b[32m#pi-updates\u001b[39m") === true,
    JSON.stringify(withUser),
  );
  const noUser = footer(baseStatus, () => ({ icon: "🧵", enabled: true }));
  check(
    "no user identity → plain room URI fallback (uncolored)",
    plain(noUser) === "[💬 #pi-updates:matrix.r3d.nl 🧵 on]" && !noUser?.includes("\u001b[36m"),
    JSON.stringify(noUser),
  );
  const roomId = footer(
    { ...baseStatus, roomId: "!abcdefgh1234567:matrix.r3d.nl", userId: "@pi_agent:matrix.r3d.nl" },
    undefined,
  );
  check(
    "!room id → local part kept, domain dropped",
    plain(roomId) === "[💬 pi_agent:matrix.r3d.nl/!abcdefgh1234567]",
    JSON.stringify(roomId),
  );

  const off = footer(
    { ...baseStatus, userId: "@pi_agent:matrix.r3d.nl" },
    () => ({ icon: "🧵", enabled: false }),
  );
  check(
    "disabled threads → faded (dim-ANSI) '🧵 off' segment in the footer",
    off?.includes(`\u001b[2m🧵 off\u001b[22m`) === true,
    JSON.stringify(off),
  );
  const bare = footer(baseStatus, undefined);
  check("no getThreadStatus supplier → no thread icon segment", bare?.includes("🧵") !== true, JSON.stringify(bare));
}

// TuiFooter module (src/tui-footer.ts) — direct format check.
{
  const f = createTuiFooter({ getThreadStatus: () => ({ icon: "🧵", enabled: true }) });
  const status = {
    connected: true, connecting: false,
    roomId: "#pi-updates:matrix.r3d.nl", userId: "@pi_agent:matrix.r3d.nl",
  };
  check(
    "TuiFooter.formatStatus → [💬 user:domain/#room 🧵 on]",
    f.formatStatus(status).replace(/\u001b\[[0-9;]*m/g, "") === "[💬 pi_agent:matrix.r3d.nl/#pi-updates 🧵 on]",
    JSON.stringify(f.formatStatus(status)),
  );
  const f2 = createTuiFooter({ footerIcon: "M" });
  check(
    "TuiFooter custom footerIcon → [M …] (down state stays ✗)",
    f2.formatStatus(status).replace(/\u001b\[[0-9;]*m/g, "").startsWith("[M ") &&
      f2.formatStatus({ ...status, connected: false, lastError: "x" }).replace(/\u001b\[[0-9;]*m/g, "").startsWith("[✗ "),
    JSON.stringify(f2.formatStatus(status)),
  );

  // Lock segment (FINDING-012): green 🔒 when the room is encrypted, red 🔓
  // when plaintext, hidden when unknown or not connected.
  const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
  const fOn = createTuiFooter({ getRoomEncryption: () => true });
  const fOff = createTuiFooter({ getRoomEncryption: () => false });
  const fUnknown = createTuiFooter({ getRoomEncryption: () => undefined });
  check(
    "TuiFooter lock: encrypted -> 🔒 encrypted (green)",
    strip(fOn.formatStatus(status)).includes("\ud83d\udd12 encrypted") &&
      fOn.formatStatus(status).includes("\u001b[32m"),
    JSON.stringify(fOn.formatStatus(status)),
  );
  check(
    "TuiFooter lock: plaintext -> \ud83d\udd13 not encrypted (red)",
    strip(fOff.formatStatus(status)).includes("\ud83d\udd13 not encrypted") &&
      fOff.formatStatus(status).includes("\u001b[31m"),
    JSON.stringify(fOff.formatStatus(status)),
  );
  check(
    "TuiFooter lock: unknown state -> no lock segment",
    strip(fUnknown.formatStatus(status)).includes("\ud83d\udd12") === false &&
      strip(fUnknown.formatStatus(status)).includes("\ud83d\udd13") === false,
    JSON.stringify(fUnknown.formatStatus(status)),
  );
  check(
    "TuiFooter lock: not connected -> no lock segment even when encrypted",
    strip(fOn.formatStatus({ ...status, connected: false, connecting: true })).includes("\ud83d\udd12") === false,
    JSON.stringify(fOn.formatStatus({ ...status, connected: false, connecting: true })),
  );
}

finish();
