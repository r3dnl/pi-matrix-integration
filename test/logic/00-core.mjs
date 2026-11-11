/** Split from test-logic.mjs (story 8): assertions preserved verbatim. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "../harness/_harness.mjs";
import { createTestOutbox } from "../harness/fake-outbox.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck();
const { tmp, stateDir, TS, config, fakeOutbox, connOk, fakePi, handler, integrator, evt } = await import("./_setup.mjs");
const { createMessageHandler } = await jiti.import(path.join(EXT_DIR, "src/message-handler.ts"));
const { createSessionIntegrator } = await jiti.import(path.join(EXT_DIR, "src/session-integration.ts"));
const { createTuiFooter } = await jiti.import(path.join(EXT_DIR, "src/tui-footer.ts"));
const { createThreadManager, summaryDue } = await jiti.import(path.join(EXT_DIR, "src/threading.ts"));
// ---- connect ------------------------------------------------------------------
console.log("== connect ==");
check("outbox connect() === true", connOk === true);
// The facade's ConnectionStatus snapshot is gone; the outbox connect
// result maps to this status where downstream code needs one.
check("connect success keeps the status clean", connOk === true && fakeOutbox.available() === true, "");

// ---- send ---------------------------------------------------------------------
console.log("== sendMessage ==");
const sendRes = await fakeOutbox.postMessage("hello world");
check("send success", sendRes.success === true, JSON.stringify(sendRes));
check("send event id", /^\$fake-\d+$/.test(sendRes.eventId ?? ""), sendRes.eventId);

// ---- read ---------------------------------------------------------------------
console.log("== readMessages ==");
// 63bf85b check: the fixture rows model matrix-js-sdk v42 normalized-event
// semantics — plaintext after decryption, the `clearEvent` property shape.
// The fake's readMessages returns the JSON fixture verbatim: the v42-
// normalized shape SdkOutbox.readMessages (sdk-client.ts) emits today. A
// fixture that re-certifies pre-v42 semantics silently re-proves the
// 63bf85b bug class.
const readFixture = path.join(stateDir, "read-fixture.json");
fs.writeFileSync(
  readFixture,
  JSON.stringify(
    [
      { eventId: "$r1", sender: "@vincent:test.example.org", body: "", timestamp: 1700000000000 + 4000, reactionKey: "👍\uFE0F", parentEventId: "$tgt" },
      { eventId: "$m1", sender: config.userId, body: "self message", timestamp: 1700000000000 + 4100, isFromPi: true },
      { eventId: "$t1", sender: "@vincent:test.example.org", body: "root", timestamp: 1700000000000 + 4300, isThreadRoot: true },
      { eventId: "$t2", sender: "@vincent:test.example.org", body: "reply", timestamp: 1700000000000 + 4400, threadRoot: "$t1" },
    ],
    null,
    1,
  ),
);
process.env.FAKE_OUTBOX_READ_FIXTURE = readFixture;
const msgs = await fakeOutbox.readMessages(50);
check(
  "reactions normalize with reactionKey/parentEventId",
  msgs.some((e) => e.eventId === "$r1" && e.reactionKey === "👍\uFE0F" && e.parentEventId === "$tgt"),
  JSON.stringify(msgs.map((e) => [e.eventId, e.reactionKey])),
);
check(
  "self event is isFromPi (Phase-0 single identity)",
  msgs.find((e) => e.eventId === "$m1")?.isFromPi === true,
  "",
);
check(
  "state/membership normalize to nothing (dropped)",
  !msgs.some((e) => e.eventId === "$s1"),
  "",
);
check(
  "thread root is isThreadRoot; reply nests under its root",
  msgs.find((e) => e.eventId === "$t1")?.isThreadRoot === true &&
    msgs.find((e) => e.eventId === "$t2")?.threadRoot === "$t1",
  JSON.stringify(msgs.filter((e) => e.threadRoot || e.isThreadRoot)),
);
check(
  "emittable rows stay oldest\u2192newest",
  JSON.stringify(msgs.map((e) => e.eventId)) === JSON.stringify(["$r1", "$m1", "$t1", "$t2"]),
  JSON.stringify(msgs.map((e) => e.eventId)),
);
delete process.env.FAKE_OUTBOX_READ_FIXTURE;

// ---- connect-failure degrade (salvage from test-matrix-http.mjs) ---------------
console.log("== connect failure (M_UNKNOWN_TOKEN) ==");
// The old whoami 401 block: a dead token degrades the connect. Expressed
// via the fake outbox's connect knob — connect() fails, connect-failure path.
process.env.FAKE_OUTBOX_CONNECT_ERR = "M_UNKNOWN_TOKEN";
const failOutbox = createTestOutbox(config);
const failOk = await failOutbox.connect();
check("connect() === false when the token is unknown", failOk === false);
delete process.env.FAKE_OUTBOX_CONNECT_ERR;

// ---- room ops -------------------------------------------------------------------
console.log("== room ops ==");
const members = await fakeOutbox.roomMembers();
check(
  "room members (fresh room state — the fake logs, it does not seed)",
  Array.isArray(members) && members.length === 0,
  JSON.stringify(members),
);

// ---- delivery dispatch ---------------------------------------------------------
console.log("== delivery ==");
const emitted = [];
const reactions = [];
fakeOutbox.startDelivery({
  // The poller's own-event filter lives here in the fake world: SdkOutbox
  // only delivers user traffic to onMessage, so the test callback mirrors
  // that drop for isFromPi events.
  onMessage: (m) => { if (!m.isFromPi) emitted.push(m); },
  onReaction: (r) => reactions.push(r),
  bumpUnread: () => {},
  onSyncError: () => {},
});
// The facade poller is gone: the test drives delivery through the fake's
// pushRoomEvent hook (events arrive v42-normalized, the shape SdkOutbox
// delivers), so no baseline/dedupe rounds to settle on.

fakeOutbox.pushRoomEvent(evt("$evt-C", { body: "ship it" }));
check(
  "new message emitted once",
  emitted.length === 1 && emitted[0].eventId === "$evt-C" && emitted[0].body === "ship it",
  JSON.stringify(emitted.map((m) => m.eventId)),
);

fakeOutbox.pushRoomEvent(evt("$evt-D", { body: "my own message", sender: config.userId }));
check(
  "own message stays out of onMessage (isFromPi filter)",
  emitted.length === 1 && emitted[0].eventId === "$evt-C",
  JSON.stringify(emitted.map((m) => m.eventId)),
);

// Reaction events (annotation relations): carried with key + parent,
// dispatched to onReaction — never onMessage. The key carries Element's
// U+FE0F suffix exactly as the live room does.
fakeOutbox.pushReaction(evt("$evt-R1", {
  type: "m.reaction",
  reaction: { event_id: "$evt-C", key: "👍\uFE0F" },
}));
fakeOutbox.pushReaction(evt("$evt-R2", {
  type: "m.reaction",
  sender: config.userId,
  reaction: { event_id: "$evt-C", key: "✅" },
}));
fakeOutbox.pushRoomEvent(evt("$evt-G", { body: "after reactions" }));
check(
  "m.reaction parsed (key + parent) → onReaction; Pi's reaction is flagged",
  reactions.length === 2 &&
    reactions[0].eventId === "$evt-R1" &&
    reactions[0].reactionKey === "👍\uFE0F" &&
    reactions[0].parentEventId === "$evt-C" &&
    reactions[0].isFromPi === false &&
    reactions[1].eventId === "$evt-R2" &&
    reactions[1].isFromPi === true &&
    emitted.length === 2 &&
    emitted.every((m) => m.eventId !== "$evt-R1" && m.eventId !== "$evt-R2"),
  JSON.stringify({ reactions: reactions.map((r) => [r.eventId, r.reactionKey]), emitted: emitted.map((m) => m.eventId) }),
);
fakeOutbox.stopDelivery();

// ---- incoming-message injection (post decision-tool removal) -----------------
console.log("== incoming message injection ==");
const tStart = Date.now();
fakeOutbox.startDelivery({
  onMessage: (m) => {
    console.log(`  [emit] ${m.eventId} (${m.body}) isFromPi=${m.isFromPi} at ${Date.now() - tStart}ms`);
    const piMessage = handler.handleIncomingMessage(m);
    if (piMessage) integrator.injectMatrixMessage(m, piMessage);
  },
  onReaction: () => {},
  bumpUnread: () => {},
  onSyncError: () => {},
});

integrator.registerMatrixMessageRenderer(fakePi);
check("message renderer registered", fakePi.renderers.has("matrix-message"));

// A plain user message is consumed (isFromPi false) and injected with
// attribution. The decision-response branch was removed — a body that merely
// looks like an answer no longer short-circuits the normal injection path.
fakeOutbox.pushRoomEvent(evt("$evt-E", { body: "note from mobile" }));
await waitUntil(
  () => fakePi.sentMessages.some((s) => s.message?.customType === "matrix-message"),
  { label: "matrix-message injection" },
);
const injected = fakePi.sentMessages.find((s) => s.message?.customType === "matrix-message");
check(
  "plain message injected with attribution",
  Boolean(injected) && injected.message.content === "[Matrix] vincent: note from mobile",
  JSON.stringify(injected),
);
check(
  "injection options (followUp + triggerTurn)",
  injected &&
    injected.options.deliverAs === "followUp" &&
    injected.options.triggerTurn === true,
  JSON.stringify(injected?.options),
);

// ---- final message broadcast ----------------------------------------------------
console.log("== sendFinalMessage ==");
const fin = await handler.sendFinalMessage("all tests green");
check("sendFinalMessage success", fin.success === true, JSON.stringify(fin));
// The send-log lines the fake outbox appends per postMessage are the
// settled-send signal (the fake-mtx counter's outbox analogue). Multi-line
// bodies are JSON-stringified per log line, so split on physical newlines.
const sendLogPath = path.join(stateDir, "send.log");
const sendEntries = () =>
  fs.existsSync(sendLogPath)
    ? fs.readFileSync(sendLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
const lastSendEntry = () => sendEntries().at(-1);
const sendCount = () => sendEntries().length;
const finSend = lastSendEntry().b;
check(
  "final message carries the 💬 Pi: prefix",
  String(finSend).startsWith("💬 Pi: all tests green"),
  finSend,
);

// ---- dedupe (item 2) ------------------------------------------------------------
console.log("== dedupe ==");
const dedupeHandler = createMessageHandler({ outbox: fakeOutbox, dedupeWindowMs: 200 });
const c0 = sendCount();
const d1 = await dedupeHandler.sendMilestone("Ship it");
check("first send goes through", d1.success === true && !d1.deduped, JSON.stringify(d1));
check("outbox send recorded for first send", sendCount() === c0 + 1, String(sendCount()));

const d2 = await dedupeHandler.sendMilestone("Ship it");
check("identical re-send within window is deduped", d2.deduped === true && d2.success === true && d2.eventId === "", JSON.stringify(d2));
check("deduped send made no outbox call", sendCount() === c0 + 1, String(sendCount()));
const tD2 = Date.now(); // window anchor: deduped sends refresh the window

// Different content still sends
const d3 = await dedupeHandler.sendMilestone("Different content");
check("different content sends", d3.success === true && !d3.deduped, JSON.stringify(d3));

// Marker collision (case b): "🎯 Milestone: X" vs. the same line re-embedded
// in a final broadcast "💬 Pi: Milestone: X" must collide on one key.
const c1 = sendCount();
const d4 = await dedupeHandler.sendMilestone("Analysis done");
const d5 = await dedupeHandler.sendFinalMessage("Milestone: Analysis done");
check("marker + final text containing it → one send", d4.success === true && d5.deduped === true, `${JSON.stringify(d4)} ${JSON.stringify(d5)}`);
check("marker collision made no extra outbox call", sendCount() === c1 + 1, String(sendCount()));

// Window expiry: a repeated send after the window sends again. The window was
// refreshed by the deduped d2, so wait until it has demonstrably expired —
// the condition, not a blind sleep.
await waitUntil(
  () => Date.now() - tD2 > 210,
  { label: "dedupe window (200ms) to expire since d2" },
);
const d6 = await dedupeHandler.sendMilestone("Ship it");
check("repeat after window expiry sends again", d6.success === true && !d6.deduped, JSON.stringify(d6));

// ---- milestone details (the matrix_send_milestone payload path) --------------
// The tool hands the model's `details` object straight to sendMilestone. It
// must read as facts under the milestone line, never as an indented JSON blob
// in a human timeline, and it must never take the milestone down with it.
console.log("== milestone details ==");
const detailHandler = createMessageHandler({ outbox: fakeOutbox, dedupeWindowMs: 1 });

await detailHandler.sendMilestone("Phase done");
check(
  "a payload-free milestone stays one line",
  String(lastSendEntry().b) === "🎯 Milestone: Phase done",
  JSON.stringify(lastSendEntry()),
);

await detailHandler.sendMilestone("Bug fixed", { root_cause: "flag consumed early", files: "2 changed" });
const detailBody = String(lastSendEntry().b);
check(
  "facts render as bullet lines, not a JSON tail",
  !detailBody.includes("Details:") &&
    !detailBody.includes("{") &&
    detailBody.includes("- root_cause: flag consumed early") &&
    detailBody.includes("- files: 2 changed"),
  detailBody,
);
check(
  "the milestone line stays the first line",
  detailBody.startsWith("🎯 Milestone: Bug fixed\n"),
  detailBody,
);

// `flat` used to travel in the same bag as the payload; it is routing and must
// stay out of the room.
await detailHandler.sendMilestone("New session", undefined, { flat: true });
check(
  "flat routing renders nothing in the body",
  String(lastSendEntry().b) === "🎯 Milestone: New session",
  JSON.stringify(lastSendEntry()),
);

await detailHandler.sendMilestone("Capped", { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" });
const cappedBody = String(lastSendEntry().b);
check(
  "at most 4 facts survive a 6-key payload",
  (cappedBody.match(/^- /gm) ?? []).length === 4 && !cappedBody.includes("- e:"),
  cappedBody,
);

await detailHandler.sendMilestone("Long story", { story: "x".repeat(900) });
const longBody = String(lastSendEntry().b);
check(
  "a long value is cut to the character budget",
  // the 400-char budget covers the bullet lines; the milestone line is on top.
  longBody.length <= 430 && longBody.includes("- story: xxx"),
  String(longBody.length),
);

// A value JSON.stringify refuses must degrade to text: formatForMatrix runs
// outside the callers' try/catch, so a throw here used to lose the milestone.
const circular = { note: "kept" };
circular.self = circular;
const circularSend = await detailHandler.sendMilestone("Survives", circular);
check(
  "an unserializable value cannot lose the milestone",
  circularSend.success === true && String(lastSendEntry().b).includes("🎯 Milestone: Survives"),
  JSON.stringify(lastSendEntry()),
);

const fmtDetails = createMessageHandler({ outbox: fakeOutbox, sendFormatted: true, dedupeWindowMs: 1 });
await fmtDetails.sendMilestone("Listed", { files: "2 changed" });
check(
  "the formatted body carries the facts as a list",
  String(lastSendEntry().h ?? "").includes("<ul>") && String(lastSendEntry().h ?? "").includes("2 changed"),
  JSON.stringify(lastSendEntry()),
);

// ---- sendFormatted (item 7b, fake-`mtx` side) ---------------------------------
console.log("== sendFormatted ==");
const fmtHandler = createMessageHandler({ outbox: fakeOutbox, sendFormatted: true });
const f1 = await fmtHandler.sendMilestone("**Bold** result");
check("formatted send succeeds", f1.success === true, JSON.stringify(f1));
check(
  "html payload recorded in the send log",
  String(lastSendEntry().h ?? "").includes("<strong>Bold</strong>"),
  JSON.stringify(lastSendEntry()),
);
check(
  "plain markdown kept as body fallback",
  String(lastSendEntry().b ?? "").startsWith("🎯 Milestone: **Bold** result"),
  JSON.stringify(lastSendEntry()),
);

// raw-HTML passthrough: HTML content ships as-is (no escaping) as
// formatted_body, with a tag-stripped body fallback
const rawHtml = '<h1>Round trip</h1>\n<ul>\n<li><strong>bold</strong></li>\n</ul>\n<pre><code class="language-python">print("x")</code></pre>';
const r1 = await fmtHandler.sendMilestone(rawHtml);
check("raw-HTML send succeeds", r1.success === true, JSON.stringify(r1));
const rawSent = String(lastSendEntry().h ?? "");
check(
  "raw HTML arrives as-is (unescaped)",
  rawSent.includes("<h1>Round trip</h1>") && rawSent.includes('<code class="language-python">') && !rawSent.includes("&lt;"),
  rawSent,
);
check(
  "raw-HTML body fallback is tag-stripped",
  (() => {
    const body = String(lastSendEntry().b ?? "");
    return body.includes("Round trip") && !body.includes("<h1");
  })(),
)

// tablesInSeparateMessage: table block goes out as its own send
const splitHandler = createMessageHandler({
  outbox: fakeOutbox,
  sendFormatted: true,
  tablesInSeparateMessage: true,
  dedupeWindowMs: 1,
});
const c4 = sendCount();
const tblText = "Report:\n\n| task | state |\n| --- | --- |\n| a | done |\n| b | todo |";
const s1 = await splitHandler.sendFinalMessage(tblText);
check("split send succeeds", s1.success === true, JSON.stringify(s1));
check(
  "main text + table = two outbox sends",
  sendCount() === c4 + 2,
  String(sendCount() - c4),
);
check(
  "table send carries the table html",
  String(lastSendEntry().h ?? "").includes("border-collapse"),
);
check(
  "table send body is the plain table source",
  String(lastSendEntry().b ?? "").includes("| task | state |"),
);

// A plain (non-formatted) send with a table stays a single plain send
const c5 = sendCount();
const p1 = await dedupeHandler.sendFinalMessage("plain table: | a | b |\n| --- | --- |\n| 1 | 2 |");
check("plain send with table is one send", p1.success === true && sendCount() === c5 + 1, String(sendCount() - c5));

// ---- markdown → HTML (items 7b/8, pure converter) ------------------------------
console.log("== markdown → HTML ==");
const { convertMarkdown, removeTableBlocks, looksLikeHtml, stripHtmlTags, htmlToMarkdown } = await jiti.import(path.join(EXT_DIR, "src/markdown.ts"));

// looksLikeHtml / stripHtmlTags (raw-HTML passthrough)
check("looksLikeHtml: raw", looksLikeHtml("<h1>x</h1>") === true);
check("looksLikeHtml: label-prefixed", looksLikeHtml("🎯 Milestone: <h1>x</h1>") === true);
check("looksLikeHtml: markdown is not html", looksLikeHtml("## Title\n**bold** text") === false);
check("looksLikeHtml: plain text", looksLikeHtml("plain result") === false);
check(
  "stripHtmlTags restores structure",
  stripHtmlTags("<p>a <b>b</b></p>\n<pre><code>x</code></pre>") === "a b\n\nx",
  stripHtmlTags("<p>a <b>b</b></p>\n<pre><code>x</code></pre>"),
);

const md = [
  "# Heading 1",
  "",
  "Some **bold** and *italic* and `code` and [link](https://example.com).",
  "",
  "- item one",
  "- item two",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted line",
  "",
  "```",
  "line with **stars** and <tag>",
  "```",
].join("\n");
const conv = convertMarkdown(md);
check("heading", conv.html.includes("<h1>Heading 1</h1>"), conv.html);
check(
  "inline formats",
  conv.html.includes("<strong>bold</strong>") &&
    conv.html.includes("<em>italic</em>") &&
    conv.html.includes('<font color="#3385ff"><code>code</code></font>') &&
    conv.html.includes('<a href="https://example.com">link</a>'),
  conv.html,
);
check(
  "lists",
  conv.html.includes("<ul><li>item one</li><li>item two</li></ul>") &&
    conv.html.includes("<ol><li>first</li><li>second</li></ol>"),
);
check("blockquote", conv.html.includes("<blockquote>quoted line</blockquote>"));
check(
  "fenced code escaped, no md inside",
  conv.html.includes("<pre><code>line with **stars** and &lt;tag&gt;</code></pre>"),
);
check(
  "fence language hint becomes class=language-*",
  convertMarkdown("```ts\nconst x = 1\n```").html ===
    '<pre><code class="language-ts">const x = 1</code></pre>',
);
check(
  "fence language is attribute-safe",
  !convertMarkdown('```"onerror"\nx\n```').html.includes("class="),
);
check(
  "c++-style fence language allowed",
  convertMarkdown("```c++\nint x;\n```").html.includes('class="language-c++"'),
);
check("no tables detected", conv.tables.length === 0);

// ---- HTML → markdown (incoming formatted_body re-render) -----------------------
console.log("== HTML → markdown ==");
check(
  "htmlToMarkdown: round-trip of convertMarkdown output",
  (() => {
    const back = htmlToMarkdown(convertMarkdown(md).html);
    return (
      back.includes("# Heading 1") &&
      back.includes("**bold**") &&
      back.includes("*italic*") &&
      back.includes("`code`") &&
      back.includes("[link](https://example.com)") &&
      back.includes("- item one") &&
      back.includes("1. first") &&
      back.includes("> quoted line") &&
      back.includes("```") &&
      back.includes("line with **stars** and <tag>") &&
      !back.includes("<p>")
    );
  })(),
  htmlToMarkdown(convertMarkdown(md).html),
);
check(
  "htmlToMarkdown: fenced block round-trip keeps language hint",
  htmlToMarkdown(convertMarkdown("```ts\nconst x = 1\n```").html) ===
    "```ts\nconst x = 1\n```",
);
check(
  "htmlToMarkdown: table → GFM pipe table with separator",
  htmlToMarkdown(
    '<table border="1"><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
  ) === "| a | b |\n| --- | --- |\n| 1 | 2 |",
);
check(
  "htmlToMarkdown: unknown tags stripped, entities decoded",
  htmlToMarkdown('<div class="x"><span>hi &amp; co</span></div>') === "hi & co",
);
check(
  "inline code span ships blue (outgoing)",
  convertMarkdown("see `x()`").html === '<p>see <font color="#3385ff"><code>x()</code></font></p>',
  convertMarkdown("see `x()`").html,
);

// escaping: injection attempts stay inert
check(
  "escaping <script>, & and quotes",
  convertMarkdown('<script>alert("x")</script> & more').html ===
    "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>",
  convertMarkdown('<script>alert("x")</script> & more').html,
);

// item 8 sample: `a | table | fine` / `--- | --- | ---` / two body rows
const tableMd = [
  "a | table | fine",
  "--- | --- | ---",
  "1 | 2 | 3",
  "4 | 5 | 6",
].join("\n");
const tconv = convertMarkdown(tableMd);
check(
  "sample table → exact md2htmx-styled HTML",
  tconv.html ===
    '<table border="1" style="border-collapse:collapse; width:100%">' +
    '<tr><th style="padding:8px">a</th><th style="padding:8px">table</th><th style="padding:8px">fine</th></tr>' +
    '<tr><td style="padding:8px">1</td><td style="padding:8px">2</td><td style="padding:8px">3</td></tr>' +
    '<tr><td style="padding:8px">4</td><td style="padding:8px">5</td><td style="padding:8px">6</td></tr></table>',
  tconv.html,
);
check(
  "table recorded with source + line range",
  tconv.tables.length === 1 &&
    tconv.tables[0].source === tableMd &&
    tconv.tables[0].lineStart === 0 &&
    tconv.tables[0].lineEnd === 3,
);

// edge cases
check(
  "leading/trailing pipes + empty cells",
  convertMarkdown("| h1 | h2 |\n| --- | --- |\n|  | x |").html.includes(
    '<th style="padding:8px">h1</th>',
  ) &&
    convertMarkdown("| h1 | h2 |\n| --- | --- |\n|  | x |").html.includes(
      '<td style="padding:8px"></td><td style="padding:8px">x</td>',
    ),
);
check(
  "header-only table",
  convertMarkdown("a | b\n--- | ---").html ===
    '<table border="1" style="border-collapse:collapse; width:100%">' +
    '<tr><th style="padding:8px">a</th><th style="padding:8px">b</th></tr></table>',
);

// table inside a longer markdown message (text above + table)
const mixedMd = "Intro line\n\n| t | u |\n| --- | --- |\n| 1 | 2 |\n\nOutro **line**";
const mix = convertMarkdown(mixedMd);
check(
  "text above + table inlines the table",
  mix.html ===
    "<p>Intro line</p>" +
    '<table border="1" style="border-collapse:collapse; width:100%">' +
    '<tr><th style="padding:8px">t</th><th style="padding:8px">u</th></tr>' +
    '<tr><td style="padding:8px">1</td><td style="padding:8px">2</td></tr></table>' +
    "<p>Outro <strong>line</strong></p>",
  mix.html,
);
check(
  "htmlWithoutTables drops the table only",
  mix.htmlWithoutTables === "<p>Intro line</p><p>Outro <strong>line</strong></p>",
  mix.htmlWithoutTables,
);
const mainPart = removeTableBlocks(mixedMd, mix.tables);
check(
  "removeTableBlocks keeps surrounding markdown",
  mainPart.includes("Intro line") && mainPart.includes("Outro **line**") && !mainPart.includes("|"),
  mainPart,
);

// ---- config (items 4/5) ----------------------------------------------------------
console.log("== config ==");
const { loadConfig, getValidConfig, DEFAULT_CONFIG } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
// The repo ships no config file any more (fe0376b); the runtime seeds one from
// DEFAULT_CONFIG. Write a v1-shaped fixture so these checks exercise the real
// load path instead of a file that can drift away from the repo.
const fixtureCred = path.join(stateDir, "fixture-v1-credentials.json");
fs.writeFileSync(
  fixtureCred,
  JSON.stringify({ access_token: "fixture", user_id: "@pi_user:matrix.example.org", device_id: "DEV" }),
);
const liveCfgPath = path.join(stateDir, "fixture-v1.json");
fs.writeFileSync(
  liveCfgPath,
  JSON.stringify({
    homeserver: "matrix.example.org",
    credentialsPath: fixtureCred,
    sendMilestones: true,
    sendFinalMessages: true,
    autoConnect: true,
    dedupeWindowMs: 600000,
    maxFinalMessageLength: 8000,
    sendFormatted: true,
    tablesInSeparateMessage: false,
    logPath: ".pi/matrix/logs/pi-matrix.log",
    slashRelay: true,
  }),
);
const loadedCfg = loadConfig(liveCfgPath);
check(
  "shipped config file loads with all schema keys",
  loadedCfg.sendMilestones === true &&
    loadedCfg.sendFinalMessages === true &&
    loadedCfg.autoConnect === true &&
    loadedCfg.dedupeWindowMs === 600000 &&
    loadedCfg.maxFinalMessageLength === 8000 &&
    loadedCfg.sendFormatted === true && // 7a shipped (CLI `--html` live); raw-HTML passthrough keeps plain sends safe
    loadedCfg.tablesInSeparateMessage === false &&
    loadedCfg.logPath?.includes(".pi/matrix/logs/pi-matrix.log") === true &&
    loadedCfg.slashRelay === true,
  JSON.stringify(loadedCfg),
);

// env overrides: numeric + boolean parsing
process.env.PI_MATRIX_DEDUPE_WINDOW_MS = "123";
process.env.PI_MATRIX_SEND_FORMATTED = "true";
process.env.PI_MATRIX_AUTO_CONNECT = "false";
const overridden = loadConfig(liveCfgPath);
check(
  "numeric env overrides parsed",
  overridden.dedupeWindowMs === 123,
  JSON.stringify({ b: overridden.dedupeWindowMs }),
);
check(
  "boolean env overrides parsed",
  overridden.sendFormatted === true && overridden.autoConnect === false,
  JSON.stringify({ c: overridden.sendFormatted, d: overridden.autoConnect }),
);
delete process.env.PI_MATRIX_DEDUPE_WINDOW_MS;
delete process.env.PI_MATRIX_SEND_FORMATTED;
delete process.env.PI_MATRIX_AUTO_CONNECT;

// unknown-key guard: warn, don't fail (item 4)
const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const tmpCfg = path.join(stateDir, "config-typo.json");
try {
  fs.writeFileSync(tmpCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(liveCfgPath, "utf8")), sendMilestons: true }));
  const withTypo = getValidConfig(tmpCfg);
  check("unknown key warns", warnings.some((w) => w.includes("sendMilestons")), JSON.stringify(warnings));
  check("config with typo still loads + validates", withTypo.valid === true && withTypo.config.userId === loadedCfg.userId, JSON.stringify(withTypo.errors));
} finally {
  console.warn = origWarn;
}

// item 10: fileAttach / attachMaxBytes / pickerLimit in defaults + env map +
// validation (mirrors the slashRelay pattern above)
check(
  "item 10 keys in config defaults",
  DEFAULT_CONFIG.fileAttach === false &&
    DEFAULT_CONFIG.attachMaxBytes === 200_000 &&
    DEFAULT_CONFIG.pickerLimit === 10,
  JSON.stringify({ f: DEFAULT_CONFIG.fileAttach, a: DEFAULT_CONFIG.attachMaxBytes, p: DEFAULT_CONFIG.pickerLimit }),
);

process.env.PI_MATRIX_FILE_ATTACH = "true";
process.env.PI_MATRIX_ATTACH_MAX_BYTES = "12345";
process.env.PI_MATRIX_PICKER_LIMIT = "3";
const item10Cfg = loadConfig(liveCfgPath);
check(
  "item 10 env overrides parsed (bool + two numerics)",
  item10Cfg.fileAttach === true &&
    item10Cfg.attachMaxBytes === 12345 &&
    item10Cfg.pickerLimit === 3,
  JSON.stringify({ f: item10Cfg.fileAttach, a: item10Cfg.attachMaxBytes, p: item10Cfg.pickerLimit }),
);
delete process.env.PI_MATRIX_FILE_ATTACH;
delete process.env.PI_MATRIX_ATTACH_MAX_BYTES;
delete process.env.PI_MATRIX_PICKER_LIMIT;

// validation: the new keys are known schema keys (no unknown-key warning)
const w10 = [];
const origWarn10 = console.warn;
console.warn = (...args) => w10.push(args.join(" "));
const tmp10 = path.join(stateDir, "config-item10.json");
try {
  fs.writeFileSync(
    tmp10,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(liveCfgPath, "utf8")), fileAttach: true, attachMaxBytes: 999, pickerLimit: 4 }),
  );
  const with10 = getValidConfig(tmp10);
  check(
    "item 10 keys pass config validation",
    with10.valid === true &&
      with10.config.fileAttach === true &&
      with10.config.attachMaxBytes === 999 &&
      with10.config.pickerLimit === 4 &&
      !w10.some((w) => /fileAttach|attachMaxBytes|pickerLimit/.test(w)),
    JSON.stringify({ errors: with10.errors, warnings: w10 }),
  );
} finally {
  console.warn = origWarn10;
}

// ---- Phase 0: identity invariant (DESIGN-TRANSPORT-AND-IDENTITY §2) -------
console.log("== Phase 0 identity invariant ==");
const { readCredentialsIdentity } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));

// A hermetic credentials file + minimal config, loaded through loadConfig so
// the derivation path (absent userId/homeserver → credentials owner) is
// exercised end to end.
const credDir = path.join(stateDir, "phase0-cred");
fs.mkdirSync(credDir, { recursive: true });
const credPath = path.join(credDir, "pi_user--matrix.example.org", "credentials.json");
fs.mkdirSync(path.dirname(credPath), { recursive: true });
fs.writeFileSync(
  credPath,
  JSON.stringify({ user_id: "@pi_user:matrix.example.org", homeserver: "https://matrix.example.org", access_token: "tok" }),
);
const phase0CfgPath = path.join(stateDir, "phase0-cfg.json");
const basePhase0 = {
  roomId: "#pi-updates:matrix.example.org",
  credentialsPath: credPath,
};
const writePhase0 = (obj) => {
  fs.writeFileSync(phase0CfgPath, JSON.stringify({ ...basePhase0, ...obj }));
  return phase0CfgPath;
};

// 1) credentials owner == userId → valid, userId retained
{
  const p = writePhase0({ userId: "@pi_user:matrix.example.org" });
  const v = getValidConfig(p);
  check(
    "owner == userId → valid, userId retained",
    v.valid === true && v.config.userId === "@pi_user:matrix.example.org",
    JSON.stringify(v.errors),
  );
}

// 2) userId absent (real state now that the R3 strip removed it from defaults)
//    → derived from the credentials owner; homeserver likewise.
{
  const p = writePhase0({});
  const v = getValidConfig(p);
  check(
    "userId + homeserver absent → derived from credentials",
    v.valid === true &&
      v.config.userId === "@pi_user:matrix.example.org" &&
      v.config.homeserver === "matrix.example.org",
    JSON.stringify({ userId: v.config.userId, homeserver: v.config.homeserver, errors: v.errors }),
  );
}

// 3) mismatch → invalid, error names both values
{
  const p = writePhase0({ userId: "@pi_agent:matrix.example.org" });
  const v = getValidConfig(p);
  check(
    "mismatch → invalid, error names both values",
    v.valid === false &&
      v.errors.join(" ").includes("@pi_agent:matrix.example.org") &&
      v.errors.join(" ").includes("@pi_user:matrix.example.org"),
    JSON.stringify(v.errors),
  );
}

// 4) missing file + explicit userId → valid (R4: warn + allow). The explicit
//    userId is honored and the invariant simply cannot be checked.
{
  const p = writePhase0({ userId: "@pi_user:matrix.example.org", homeserver: "matrix.example.org", credentialsPath: path.join(credDir, "no-such.json") });
  const v = getValidConfig(p);
  check(
    "missing credentials + explicit userId → valid (R4)",
    v.valid === true && v.config.userId === "@pi_user:matrix.example.org",
    JSON.stringify(v.errors),
  );
}

// 5) missing file + no userId → error (nothing to derive from, no default)
{
  const p = writePhase0({ credentialsPath: path.join(credDir, "no-such.json") });
  const v = getValidConfig(p);
  check(
    "missing credentials + no userId → invalid",
    v.valid === false && v.errors.join(" ").toLowerCase().includes("userid"),
    JSON.stringify(v.errors),
  );
}

// 6) homeserver absent + credentials file lacks the field + no explicit value
//    → error (no default fallback — R3).
{
  const credNoHost = path.join(credDir, "nohost", "pi_user--matrix.example.org", "credentials.json");
  fs.mkdirSync(path.dirname(credNoHost), { recursive: true });
  fs.writeFileSync(credNoHost, JSON.stringify({ user_id: "@pi_user:matrix.example.org", access_token: "t" }));
  const p = writePhase0({ credentialsPath: credNoHost });
  const v = getValidConfig(p);
  check(
    "no homeserver anywhere → invalid (no default fallback, R3)",
    v.valid === false && v.errors.join(" ").includes("homeserver"),
    JSON.stringify(v.errors),
  );
}

// 7) unknown-key guard still catches csSelfUserId (never in the schema), and
//    the production-shaped config no longer carries it.
{
  const p = writePhase0({ userId: "@pi_user:matrix.example.org", homeserver: "matrix.example.org", csSelfUserId: "@pi_user:matrix.example.org" });
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let v;
  try {
    v = getValidConfig(p);
  } finally {
    console.warn = ow;
  }
  check(
    "csSelfUserId is an unknown key (warns)",
    warns.some((w) => w.includes("csSelfUserId")) && v.valid === true,
    JSON.stringify({ warns, errors: v.errors }),
  );
}

// 8) owner extraction: user_id field preferred, filename convention as fallback.
{
  const withField = readCredentialsIdentity(credPath);
  check(
    "readCredentialsIdentity: user_id field wins",
    withField?.owner === "@pi_user:matrix.example.org" && withField?.homeserver === "matrix.example.org",
    JSON.stringify(withField),
  );
  const noFieldDir = path.join(credDir, "fallback", "pi_user--matrix.example.org", "credentials.json");
  fs.mkdirSync(path.dirname(noFieldDir), { recursive: true });
  fs.writeFileSync(noFieldDir, JSON.stringify({ access_token: "t" }));
  const fallback = readCredentialsIdentity(noFieldDir);
  check(
    "readCredentialsIdentity: filename fallback yields owner",
    fallback?.owner === "@pi_user:matrix.example.org",
    JSON.stringify(fallback),
  );
  check("readCredentialsIdentity: missing path → undefined", readCredentialsIdentity(path.join(credDir, "nope.json")) === undefined, "");
}


// ---- command relay (item 9) ------------------------------------------------------
console.log("== command relay ==");
const {
  parseCommandLine,
  findCommand,
  fuzzyCommandCandidates,
  formatCommandSuggestion,
} = await jiti.import(path.join(EXT_DIR, "src/command-relay.ts"));
check(
  "parseCommandLine: exact + args",
  JSON.stringify(parseCommandLine("/matrix-status --full")) ===
    JSON.stringify({ name: "matrix-status", args: "--full" }),
  JSON.stringify(parseCommandLine("/matrix-status --full")),
);
check(
  "parseCommandLine: scoped (skill:x)",
  parseCommandLine("/skill:discover foo")?.name === "skill:discover",
);
check(
  "parseCommandLine: non-command text is null",
  parseCommandLine("how to /etc hosts") === null,
);
const cmds = [
  { name: "matrix-status" },
  { name: "matrix-connect" },
  { name: "skill:discover" },
];
check(
  "findCommand: case-insensitive exact",
  findCommand("Matrix-Status", cmds)?.name === "matrix-status",
);
check(
  "fuzzy: typo 'matrci-status' suggests matrix-status",
  fuzzyCommandCandidates("matrci-status", cmds).includes("matrix-status"),
  JSON.stringify(fuzzyCommandCandidates("matrci-status", cmds)),
);
check(
  "fuzzy: prefix 'skil' suggests skill:discover",
  JSON.stringify(fuzzyCommandCandidates("skil", cmds)) === JSON.stringify(["skill:discover"]),
  JSON.stringify(fuzzyCommandCandidates("skil", cmds)),
);
check(
  "fuzzy: unrelated input yields no candidates",
  fuzzyCommandCandidates("zzz", cmds).length === 0,
);
check(
  "fuzzy: bare scoped prefix 'skill' lists the skill:* menu",
  JSON.stringify(fuzzyCommandCandidates("skill", cmds)) === JSON.stringify(["skill:discover"]),
  JSON.stringify(fuzzyCommandCandidates("skill", cmds)),
);
check(
  "suggestion text names the candidates",
  formatCommandSuggestion("matrci-status", ["matrix-status"]).includes("/matrix-status"),
);

// ---- file attach (item 10) --------------------------------------------------------
console.log("== file attach ==");
const {
  extractFileTokens,
  resolveFileToken,
  expandBody,
  matchCandidates,
  formatCandidateList,
  formatNoMatches,
  formatNumberedMatches,
  fragmentMatcher,
  CandidateListTracker,
  isLoneToken,
  pickFiles,
  nodeFsAttach,
} = await jiti.import(path.join(EXT_DIR, "src/file-attach.ts"));
const {
  isLoneArtifactToken,
  extractArtifactToken,
  isArtifactPath,
  isMediaPath,
  mimeFor,
  formatArtifactCaption,
  pickArtifactFiles,
  rankArtifactWithFzf,
  ATTACH_EXTENSIONS,
} = await jiti.import(path.join(EXT_DIR, "src/artifact-attach.ts"));

// 1. extractFileTokens
check(
  "extract: lone token",
  JSON.stringify(extractFileTokens("@src/matrix-client.ts")) ===
    JSON.stringify(["src/matrix-client.ts"]),
  JSON.stringify(extractFileTokens("@src/matrix-client.ts")),
);
check(
  "extract: token after space",
  JSON.stringify(extractFileTokens("review @src/matrix-client.ts now")) ===
    JSON.stringify(["src/matrix-client.ts"]),
);
check(
  "extract: multiple tokens",
  JSON.stringify(extractFileTokens("@a.ts and @b.ts")) === JSON.stringify(["a.ts", "b.ts"]),
  JSON.stringify(extractFileTokens("@a.ts and @b.ts")),
);
check("extract: 'word@x' is not a token", extractFileTokens("user@host").length === 0, JSON.stringify(extractFileTokens("user@host")));
check("extract: '@@' is not a token", extractFileTokens("@@").length === 0, JSON.stringify(extractFileTokens("@@")));
check(
  "extract: token keeps its path part",
  extractFileTokens("@src/matrix-client.ts")[0] === "src/matrix-client.ts",
);

// 2. resolveFileToken with an injected fake fs
const mkFs = (files, resolve) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
  size: (p) => files[p]?.size ?? 0,
  read: (p) => files[p]?.content ?? "",
  resolve: resolve ?? ((p) => p),
});
const fOpts = (fs, extra = {}) => ({ cwd: "/proj", attachMaxBytes: 100, fs, ...extra });

const rOk = resolveFileToken(
  "src/foo.ts",
  fOpts(mkFs({ "src/foo.ts": { size: 10, content: "FOO" } }, (p) => `/proj/${p}`)),
);
check("resolve: known in-cwd file → expanded + content", rOk.kind === "expanded" && rOk.content === "FOO", JSON.stringify(rOk));

const rMissing = resolveFileToken("nope.ts", fOpts(mkFs({}, (p) => `/proj/${p}`)));
check("resolve: missing file → missing + note", rMissing.kind === "missing" && typeof rMissing.note === "string", JSON.stringify(rMissing));

const rBig = resolveFileToken("big.ts", fOpts(mkFs({ "big.ts": { size: 500, content: "x".repeat(500) } }, (p) => `/proj/${p}`)));
check("resolve: oversized file → too-large + note", rBig.kind === "too-large" && typeof rBig.note === "string", JSON.stringify(rBig));

const rOut = resolveFileToken("../evil.ts", fOpts(mkFs({ "../evil.ts": { size: 5, content: "E" } }, () => "/etc/evil.ts")));
check("resolve: resolved path outside cwd → outside + note", rOut.kind === "outside", JSON.stringify(rOut));

const rSym = resolveFileToken("link.ts", fOpts(mkFs({ "link.ts": { size: 5, content: "E" } }, () => "/outside/link.ts")));
check(
  "resolve: symlink escape (inside-looking token, outside resolve) → outside",
  rSym.kind === "outside",
  JSON.stringify(rSym),
);

// 3. expandBody
const eOpts = fOpts(mkFs({ "src/foo.ts": { size: 10, content: "FOO" } }, (p) => `/proj/${p}`));
const e1 = expandBody("see @src/foo.ts", eOpts);
check("expand: known token → '@@ file:' block", e1.includes("@@ file: src/foo.ts\nFOO"), e1);

const e2 = expandBody("see @missing.txt", eOpts);
check(
  "expand: missing token kept verbatim + note",
  e2.includes("@missing.txt") && /note:/.test(e2) && !e2.includes("@@ file:"),
  e2,
);

const e3 = expandBody("see @big.ts", fOpts(mkFs({ "big.ts": { size: 999, content: "x".repeat(999) } }, (p) => `/proj/${p}`)));
check(
  "expand: oversized token → verbatim + one-line note",
  e3.includes("@big.ts") && /note:/.test(e3) && !e3.includes("@@ file:") && !e3.includes("\n"),
  e3,
);

// F2 regression: the configured prefix must drive inline expansion too —
// with "~" the ~token expands and the @token stays literal chat.
const ePref = expandBody("read ~src/foo.ts not @src/foo.ts", eOpts, "~");
check(
  "expand: configured prefix expands, default prefix stays literal",
  ePref.includes("@@ file: src/foo.ts\nFOO") && ePref.includes("@src/foo.ts") &&
    !ePref.includes("~src/foo.ts") && !/note:/.test(ePref),
  ePref,
);
check(
  "candidate list header uses the configured prefix",
  formatCandidateList("mar", ["a.ts"], 1, "~").includes("Matches for ~mar") &&
    formatNoMatches("zzz", "~").includes("~zzz"),
  formatCandidateList("mar", ["a.ts"], 1, "~"),
);

// 4. matchCandidates (case-sensitive substring, ranked by path length, no dupes)
check(
  "candidates: 'mar' hits markdown only ('Mars.txt' is case-miss; matrix/message have no 'mar')",
  JSON.stringify(matchCandidates("mar", ["src/matrix-client.ts", "src/message-handler.ts", "Mars.txt", "src/markdown.ts"])) ===
    JSON.stringify(["src/markdown.ts"]),
  JSON.stringify(matchCandidates("mar", ["src/matrix-client.ts", "src/message-handler.ts", "Mars.txt", "src/markdown.ts"])),
);
check(
  "candidates: 'src' hits both src/ files; 'SRC' hits none",
  JSON.stringify(matchCandidates("src", ["src/matrix-client.ts", "src/message-handler.ts", "Mars.txt"])) ===
    JSON.stringify(["src/matrix-client.ts", "src/message-handler.ts"]) &&
    matchCandidates("SRC", ["src/matrix-client.ts"]).length === 0,
);
check(
  "candidates: ranked by path length (shortest first)",
  JSON.stringify(matchCandidates("x", ["toolong/xxfile.txt", "short.txt"])) ===
    JSON.stringify(["short.txt", "toolong/xxfile.txt"]),
  JSON.stringify(matchCandidates("x", ["toolong/xxfile.txt", "short.txt"])),
);
check(
  "candidates: no dupes",
  JSON.stringify(matchCandidates("a", ["a.ts", "a.ts", "ba.ts"])) === JSON.stringify(["a.ts", "ba.ts"]),
);

// 5. plain-text formatters
const list10 = formatCandidateList("mar", ["src/matrix-client.ts", "src/markdown.ts"]);
check(
  "candidate list: fragment + 1-based numbering + both paths",
  list10.includes("@mar") && /\n\s*1\./.test(list10) && /\n\s*2\./.test(list10) &&
    list10.includes("src/matrix-client.ts") && list10.includes("src/markdown.ts"),
  list10,
);
check(
  "candidate list: reply instruction, plain text (no html / markdown)",
  /Reply with the exact path/i.test(list10) && !/<[^>]*>/.test(list10) && !list10.includes("**"),
  list10,
);
const none10 = formatNoMatches("zzz");
check(
  "no-matches text is non-empty plain text",
  typeof none10 === "string" && none10.length > 0 && !none10.includes("<"),
  none10,
);
// 5b. glob fragments. `*` spans `/` on purpose: `@src/*.ts` means "the .ts
// files under src", not the shell's one directory level — the picker ranks
// shortest-first and shows at most pickerLimit, so the breadth is what makes
// the wide reading usable.
const GLOB_FILES = [
  "src/config.ts", "src/config-utils.ts", "docs/designs/DESIGN.md", "src/README.md", "other/config.ts",
];
check("glob: '@src/*.ts' → the .ts files under src/",
  JSON.stringify(matchCandidates("src/*.ts", GLOB_FILES)) === JSON.stringify(["src/config.ts", "src/config-utils.ts"]),
  JSON.stringify(matchCandidates("src/*.ts", GLOB_FILES)));
check("glob: '@src/**.ts' is the same search",
  JSON.stringify(matchCandidates("src/**.ts", GLOB_FILES)) === JSON.stringify(matchCandidates("src/*.ts", GLOB_FILES)),
  JSON.stringify(matchCandidates("src/**.ts", GLOB_FILES)));
check("glob: '*.md' reaches every directory (breadth is the point)",
  JSON.stringify(matchCandidates("*.md", GLOB_FILES)) === JSON.stringify(["src/README.md", "docs/designs/DESIGN.md"]),
  JSON.stringify(matchCandidates("*.md", GLOB_FILES)));
check("glob: './*' still needs the literal '/'",
  matchCandidates("./*", GLOB_FILES).length === 5 && matchCandidates("src/*", GLOB_FILES).length === 3,
  `${matchCandidates("./*", GLOB_FILES).length} / ${matchCandidates("src/*", GLOB_FILES).length}`);
check("glob: '.' stays literal (no regex leak)",
  matchCandidates("src/config.ts", ["srcXconfigXts"]).length === 0 && matchCandidates("a.c", ["aXc"]).length === 0,
  "regex metacharacters must not match anything they did not match as text");
check("glob: '*' between literals spans anything, so 'a*bc' does match 'aXbc'",
  matchCandidates("a*bc", ["aXbc"]).length === 1, "documents how wide the glob reading is");
check("glob: a fragment without '*' is still a plain substring",
  JSON.stringify(matchCandidates("config", GLOB_FILES)) === JSON.stringify(["src/config.ts", "other/config.ts", "src/config-utils.ts"]),
  JSON.stringify(matchCandidates("config", GLOB_FILES)));
check("fragmentMatcher: returns a reusable predicate", fragmentMatcher("*.ts")("a/b.ts") === true);
check("glob: a leading './' is dropped (the file list never carries it)",
  JSON.stringify(matchCandidates("./src/*.ts", GLOB_FILES)) === JSON.stringify(matchCandidates("src/*.ts", GLOB_FILES)) &&
    matchCandidates("./config", GLOB_FILES).length === 3,
  JSON.stringify(matchCandidates("./src/*.ts", GLOB_FILES)));

// The glob charset belongs to the pickers only. In an ordinary message a glob
// is text: there is no file named `src/*.ts` to expand, and treating it as a
// token would post a "not found" note for a sentence the user meant literally.
check("lone: a glob is a picker token", isLoneToken("@src/*.ts", "@", true) === true);
check("lone: '@src/**.ts' too", isLoneToken("@src/**.ts", "@", true) === true);
check("lone: the same body is NOT a token without globs (ordinary-message path)",
  isLoneToken("@src/*.ts") === false, "expansion must keep `*` out of the charset");
check("lone: '?' stays out of the charset even with globs (reads as punctuation)",
  isLoneToken("@src/?.ts", "@", true) === false);
check("@@ lone: a glob is an artifact picker token", isLoneArtifactToken("@@docs/*.md", "@@", true) === true);
check("@@ lone: not one without globs", isLoneArtifactToken("@@docs/*.md") === false);

const truncated = formatCandidateList("src/", ["src/a.ts", "src/b.ts"], 47);
check(
  "over-limit: the list is what was shown, and it says so",
  truncated.includes("1. src/a.ts") && truncated.includes("2. src/b.ts") &&
    /first 2 of 47/.test(truncated) && !truncated.includes("3."),
  truncated,
);
check(
  "over-limit: the truncation line is plain text and still explains the reply",
  !/<[^>]*>/.test(truncated) && /Reply with a number/i.test(truncated) && /longer fragment/i.test(truncated),
  truncated,
);
check(
  "a list that fit does NOT claim to be partial",
  !/Showing the first/.test(formatCandidateList("src/", ["src/a.ts", "src/b.ts"], 2)),
  formatCandidateList("src/", ["src/a.ts", "src/b.ts"], 2),
);
check(
  "@@ picker shares one formatter (the truncation line cannot drift)",
  /first 1 of 30/.test(formatNumberedMatches("Artifact matches for @@docs/:", ["docs/a.md"], 30)),
  formatNumberedMatches("Artifact matches for @@docs/:", ["docs/a.md"], 30),
);
check("no-matches nudge points at the glob option", /@src\/\*\.ts/.test(none10), none10);

// 6. CandidateListTracker (session-scoped last list)
const fresh10 = new CandidateListTracker();
check("tracker: no list posted yet → null", fresh10.resolveReply("2") === null, String(fresh10.resolveReply("2")));
const t10 = new CandidateListTracker();
t10.post(["a.ts", "b.ts"]);
check("tracker: number '2' → 2nd match (1-indexed)", t10.resolveReply("2") === "b.ts", String(t10.resolveReply("2")));
check("tracker: trimmed body ' 2 ' resolves", t10.resolveReply(" 2 ") === "b.ts", String(t10.resolveReply(" 2 ")));
check("tracker: exact path from the last list", t10.resolveReply("a.ts") === "a.ts", String(t10.resolveReply("a.ts")));
check("tracker: out-of-range number → null", t10.resolveReply("3") === null && t10.resolveReply("0") === null);
check("tracker: unrelated body → null", t10.resolveReply("z") === null, String(t10.resolveReply("z")));
t10.post(["c.ts", "d.ts"]);
check(
  "tracker: re-post replaces the list",
  t10.resolveReply("1") === "c.ts" && t10.resolveReply("a.ts") === null,
  `${t10.resolveReply("1")} / ${t10.resolveReply("a.ts")}`,
);

// 7. isLoneToken
check("lone: '@mar'", isLoneToken("@mar") === true);
check("lone: '@mar review' is false", isLoneToken("@mar review") === false);
check("lone: 'hi @mar' is false", isLoneToken("hi @mar") === false);
check("lone: '' is false", isLoneToken("") === false);
check("lone: whitespace-padded token", isLoneToken("  @src/ ") === true);
check("lone: two tokens is false", isLoneToken("@a.ts @b.ts") === false);

// 7b. R2 artifact attach (@@ upload) — pure fns
check("@@ lone: '@@DESIGN-R16'", isLoneArtifactToken("@@DESIGN-R16") === true);
check("@@ lone: whitespace-padded", isLoneArtifactToken("  @@docs/d.md  ") === true);
check("@@ lone: 'a b' after the token is false", isLoneArtifactToken("@@DESIGN-R16 review") === false);
check("@@ lone: 'hi @@x' is false", isLoneArtifactToken("hi @@x") === false);
check("@@ lone: single '@mar' is false", isLoneArtifactToken("@mar") === false);
check("@@ lone: bare '@@' is false", isLoneArtifactToken("@@") === false);
check("@@ extract: fragment after @@", extractArtifactToken("@@DESIGN-R16") === "DESIGN-R16", extractArtifactToken("@@DESIGN-R16"));
check("@@ extract: keeps path part", extractArtifactToken("@@docs/design/D.md") === "docs/design/D.md", extractArtifactToken("@@docs/design/D.md"));
check("@@ extract: non-artifact token → empty", extractArtifactToken("@mar") === "");
check("@@ isArtifactPath: .md", isArtifactPath("docs/design/DESIGN-R16.md") === true);
check("@@ isArtifactPath: .feature", isArtifactPath("features/auth.feature") === true);
check("@@ isArtifactPath: .MD case-insensitive", isArtifactPath("docs/README.MD") === true);
check("@@ isArtifactPath: .ts is not an artifact", isArtifactPath("src/main.ts") === false);
check("@@ isArtifactPath: bare name (no ext) is false", isArtifactPath("README") === false);
check("@@ mime: .md → text/markdown", mimeFor("DESIGN-R16.md") === "text/markdown", mimeFor("DESIGN-R16.md"));
check("@@ mime: .feature → text/plain", mimeFor("auth.feature") === "text/plain", mimeFor("auth.feature"));
check("@@ mime: unknown → application/octet-stream", mimeFor("x.bin") === "application/octet-stream");
// media attach: the outbox sendFile path carries any content type — the
// picker extension filter and the MIME table used to exclude media.
check("@@ isMediaPath: .png", isMediaPath("shots/index.png") === true);
check("@@ isMediaPath: .MP4 case-insensitive", isMediaPath("clips/a.MP4") === true);
check("@@ isMediaPath: .mp3", isMediaPath("audio/b.mp3") === true);
check("@@ isMediaPath: .ts is not media", isMediaPath("src/main.ts") === false);
check("@@ mime: .png → image/png", mimeFor("shots/index.png") === "image/png", mimeFor("shots/index.png"));
check("@@ mime: .mp4 → video/mp4", mimeFor("clips/a.mp4") === "video/mp4", mimeFor("clips/a.mp4"));
check("@@ mime: .mp3 → audio/mpeg", mimeFor("audio/b.mp3") === "audio/mpeg", mimeFor("audio/b.mp3"));
check("@@ mime: .svg → image/svg+xml", mimeFor("icon.svg") === "image/svg+xml", mimeFor("icon.svg"));
check("@@ default picker includes media", ATTACH_EXTENSIONS.includes(".png") && ATTACH_EXTENSIONS.includes(".mp4") && ATTACH_EXTENSIONS.includes(".md"), JSON.stringify(ATTACH_EXTENSIONS));
check("@@ decision: media file now matches the default picker", JSON.stringify(matchCandidates("index", ["shots/index.png", "docs/design/DESIGN.md"])) === JSON.stringify(["shots/index.png"]));
check(
  "@@ caption: name — relPath · commit",
  formatArtifactCaption("DESIGN-R16.md", "docs/design/DESIGN-R16.md", "69d73e9") ===
    "DESIGN-R16.md — docs/design/DESIGN-R16.md · 69d73e9",
  formatArtifactCaption("DESIGN-R16.md", "docs/design/DESIGN-R16.md", "69d73e9"),
);
check(
  "@@ caption: empty commit → uncommitted",
  formatArtifactCaption("a.md", "a.md", "") === "a.md — a.md · uncommitted",
  formatArtifactCaption("a.md", "a.md", ""),
);
// Decision table — the pure core of pickArtifactFiles (extension-filter the
// tree, then item-10's substring matcher). 1 → upload, 0 → nudge, many → list.
const artTree = ["docs/design/DESIGN-R16.md", "docs/design/DESIGN-R15.md", "src/matrix-client.ts", "features/auth.feature", "README.md"];
const artFiles = artTree.filter((f) => isArtifactPath(f));
check("@@ decision: 'DESIGN-R16' → exactly 1", JSON.stringify(matchCandidates("DESIGN-R16", artFiles)) === JSON.stringify(["docs/design/DESIGN-R16.md"]));
check("@@ decision: 'DESIGN' → many (ranked short-first)", matchCandidates("DESIGN", artFiles).length === 2, JSON.stringify(matchCandidates("DESIGN", artFiles)));
check("@@ decision: '.feature' → 1 (the gherkin file)", JSON.stringify(matchCandidates(".feature", artFiles)) === JSON.stringify(["features/auth.feature"]));
check("@@ decision: 'zzz' → 0", matchCandidates("zzz", artFiles).length === 0);
check("@@ decision: 'ts' non-artifact extension excluded", matchCandidates("matrix", artFiles).length === 0, JSON.stringify(matchCandidates("matrix", artFiles)));
// R2 fzf backend — rankArtifactWithFzf is the only impure boundary (one exec);
// a missing/failing binary returns null so the caller keeps the builtin rank.
check("@@ fzf: empty candidate list → [] without invoking fzf", JSON.stringify(rankArtifactWithFzf([], "x")) === "[]");
check(
  "@@ fzf: missing binary → null (caller falls back to builtin)",
  rankArtifactWithFzf(artFiles, "DESIGN", "/definitely/not/a/bin") === null,
);
{
  let haveFzf = false;
  try {
    execFileSync("fzf", ["--version"], { stdio: "ignore" });
    haveFzf = true;
  } catch {}
  if (haveFzf) {
    const ranked = rankArtifactWithFzf(artFiles, "readme");
    check(
      "@@ fzf: 'readme' ranks the README candidate (live fzf)",
      Array.isArray(ranked) && ranked.includes("README.md"),
      JSON.stringify(ranked),
    );
  } else {
    check("@@ fzf: live fzf check skipped (fzf not on PATH)", true);
  }
}
// pickArtifactFiles fzf mode soft-fallback: fzf missing → builtin result,
// onFzfFallback fires exactly once (verified via a non-git tmp dir and a
// shim PATH that still resolves git/find but not fzf).
{
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-art-fzf-")));
  fs.writeFileSync(path.join(dir, "notes.md"), "x");
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-art-fzf-bin-")));
  for (const cmd of ["git", "find"]) {
    fs.symlinkSync(
      execFileSync("which", [cmd], { encoding: "utf8" }).trim(),
      path.join(binDir, cmd),
    );
  }
  let fellBack = 0;
  const origPath = process.env.PATH;
  process.env.PATH = binDir; // git/find resolve, fzf does not → ENOENT
  let got;
  try {
    got = pickArtifactFiles("zzz", dir, undefined, "fzf", () => {
      fellBack += 1;
    });
  } finally {
    process.env.PATH = origPath;
  }
  check("@@ fzf-fallback: missing fzf → builtin match (0 hits) + fallback fired", JSON.stringify(got) === "[]" && fellBack === 1, JSON.stringify({ got, fellBack }));
}

// 8. nodeFsAttach against the REAL filesystem (symlink guard + robustness)
{
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-proj-")));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside-")));
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "SECRET");
  fs.writeFileSync(path.join(proj, "inside.txt"), "INSIDE");
  fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(proj, "link.txt"));
  fs.mkdirSync(path.join(proj, "subdir"));

  const rOpts = { cwd: proj, attachMaxBytes: 100, fs: nodeFsAttach(proj) };
  const rLink = resolveFileToken("link.txt", rOpts);
  check(
    "real fs: symlink escaping the cwd → outside + note (realpath guard)",
    rLink.kind === "outside",
    JSON.stringify(rLink),
  );
  const rIn = resolveFileToken("inside.txt", rOpts);
  check(
    "real fs: in-cwd regular file → expanded",
    rIn.kind === "expanded" && rIn.content === "INSIDE",
    JSON.stringify(rIn),
  );
  let dirThrew = false;
  let dirOut;
  try {
    dirOut = expandBody("@subdir", rOpts);
  } catch {
    dirThrew = true;
  }
  check(
    "real fs: directory token → kept verbatim + note, never throws",
    !dirThrew && dirOut.includes("@subdir") && /note:/.test(dirOut) && !dirOut.includes("@@ file:"),
    dirThrew ? "threw" : String(dirOut),
  );
}

// 9. pickFiles: find-fallback outside a git repo (real process, temp cwd)
{
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nogit-"));
  fs.writeFileSync(path.join(noGit, "alpha-x.txt"), "a");
  fs.writeFileSync(path.join(noGit, "beta-x.txt"), "b");
  const origCwd = process.cwd();
  process.chdir(noGit);
  let found;
  try {
    found = pickFiles("x");
  } finally {
    process.chdir(origCwd);
  }
  check(
    "pickFiles: non-git cwd falls back to find (lists files, case-sensitive substring)",
    JSON.stringify([...found].sort()) === JSON.stringify(["alpha-x.txt", "beta-x.txt"]),
    JSON.stringify(found),
  );
  fs.rmSync(noGit, { recursive: true, force: true });
}

// ---- matrix-help (end-user guide) ------------------------------------------------
console.log("== matrix-help ==");
const { buildMatrixHelp, isAgentHelp } = await jiti.import(path.join(EXT_DIR, "src/matrix-help.ts"));
const baseHelpCfg = { ...DEFAULT_CONFIG };
const helpOn = buildMatrixHelp({ ...baseHelpCfg, remoteFilePicker: true });
const helpOff = buildMatrixHelp({ ...baseHelpCfg, remoteFilePicker: false });
check(
  "buildMatrixHelp returns a non-empty guide",
  typeof helpOn === "string" && helpOn.trim().length > 100,
  `len=${helpOn.length}`,
);
check(
  "guide covers the room's actions, not a re-run of the tour",
  ["plain text", "`/name …`", "`@src/`", "`@@readme`", "voice note", "`confirm`", "`help`"]
    .every((needle) => helpOn.includes(needle)),
  JSON.stringify(helpOn.slice(0, 80)),
);
// The room could not discover which commands answer where, and could not
// find settings without reading the source: both are now first-class sections.
const HELP_COMMANDS = [
  "matrix-connect", "matrix-login", "matrix-introduction-tour", "matrix-disconnect",
  "matrix-toggle", "matrix-status", "matrix-switch", "matrix-thread-toggle",
  "matrix-send", "matrix-messages", "matrix-subagents", "matrix-help", "pi-help",
  "matrix-thread-summarize", "matrix-summarize-thread",
];
check(
  "guide lists every registered command",
  HELP_COMMANDS.every((c) => helpOn.includes(`/${c}`)),
  JSON.stringify(HELP_COMMANDS.filter((c) => !helpOn.includes(`/${c}`))),
);
check(
  "guide names the three sections and the tour it defers to",
  helpOn.includes("**Actions**") && helpOn.includes("**Commands**") &&
    helpOn.includes("**What the agent posts here, on its own**") &&
    helpOn.includes("**Settings live in the config, not in commands**") &&
    helpOn.includes("`/matrix-introduction-tour`"),
  JSON.stringify(helpOn.match(/\*\*[^*]+\*\*/g)),
);
check(
  "guide marks where each command's answer shows (room vs terminal)",
  helpOn.includes("| Command | Does | Answer shows |") &&
    helpOn.includes("| `/matrix-messages [n]` | reads back the last n room messages | terminal |") &&
    helpOn.includes("| `/matrix-send TEXT` | posts TEXT into the room | room |"),
  "the split the room cannot guess must be in the table",
);
check(
  "guide points at the config tiers that survive an npm install, the env overrides and the linked reference",
  helpOn.includes(".pi/matrix/") && helpOn.includes("`matrix-config.json`") &&
    helpOn.includes("~/.config/pi-matrix-integration/config.json") &&
    !helpOn.includes("~/.pi/agent/extensions/pi-matrix-integration/config/") && helpOn.includes("PI_MATRIX_") &&
    helpOn.includes("](https://github.com/r3dnl/pi-matrix-integration/blob/main/docs/user/configuration.md)") &&
    !helpOn.includes("piMatrixMessageFormatting"),
  "settings are config; the linked doc stays the single source for the key list",
);
check(
  "guide formats as markdown the pipeline can render",
  helpOn.includes("| --- | --- |") && helpOn.includes("`@src/*.ts`") &&
    helpOn.includes("🎯 milestones"),
  "tables + code spans, no hand-built HTML",
);
check(
  "guide is plain text (no HTML tags)",
  !/<\w[\w:]*[\s>]/.test(helpOn),
  "guide must be portable plain text",
);
check(
  "actions table marks the @ picker live when remoteFilePicker is on",
  !/\| `@src\/`[^\n]*\(off here\)/.test(helpOn),
  JSON.stringify(helpOn.split("\n").find((l) => l.startsWith("| `@src/`")) ?? ""),
);
check(
  "actions table marks the @ picker off when remoteFilePicker is off",
  /\| `@src\/`[^\n]*\(off here\)/.test(helpOff) && !/\| `@src\/`[^\n]*\(off here\)/.test(helpOn),
  JSON.stringify(helpOff.split("\n").find((l) => l.startsWith("| `@src/`")) ?? ""),
);

// isAgentHelp: agent-directed "help" detection
const AGENT = ["pi_agent"];
check(
  "isAgentHelp: bare 'help' and its variants are agent-directed",
  isAgentHelp("help", AGENT) &&
    isAgentHelp("HELP", AGENT) &&
    isAgentHelp("help!", AGENT) &&
    isAgentHelp("  help  ", AGENT),
  "bare help (any case, with punctuation/whitespace) -> true",
);
check(
  "isAgentHelp: mention of the agent + help is agent-directed",
  isAgentHelp("@pi_agent help", AGENT) &&
    isAgentHelp("@pi_agent: help", AGENT) &&
    isAgentHelp("@pi_agent:test.example.org help", AGENT) &&
    isAgentHelp("@pi_agent:test.example.org: help", AGENT),
  "@pi_agent[...] help variants -> true",
);
check(
  "isAgentHelp: a mention of a DIFFERENT user is NOT agent-directed",
  !isAgentHelp("@robbie help", AGENT) && !isAgentHelp("@robbie: help", AGENT),
  "@robbie help -> false (not our agent)",
);
check(
  "isAgentHelp: unrelated sentences / 'helpful' / empty do not trigger",
  !isAgentHelp("help me with the build", AGENT) &&
    !isAgentHelp("what does help do", AGENT) &&
    !isAgentHelp("helpful", AGENT) &&
    !isAgentHelp("", AGENT),
  "'help ...' sentences, 'helpful', and empty body must not trigger",
);

// ---- logger (item 12) -----------------------------------------------------------
console.log("== logger ==");
const { createMatrixLogger } = await jiti.import(path.join(EXT_DIR, "src/logger.ts"));
const logPath = path.join(tmp, "pi-matrix.log");
const lg = createMatrixLogger(logPath);
lg.warn("offline: homeserver unreachable");
lg.error("send failed: timeout");
const logged = fs.readFileSync(logPath, "utf8");
check(
  "logger appends timestamped lines",
  logged.includes("[warn] offline: homeserver unreachable") && logged.includes("[error] send failed: timeout"),
  logged,
);
check(
  "log lines are ISO-timestamped",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[warn\]/.test(logged),
  logged.slice(0, 80),
);
// The severity gate: the configured level is case-insensitive and drops
// anything LESS severe than itself (the pre-fix gate was inverted + looked up
// an uppercased level against lowercase keys, which silently killed every
// warn/error line whenever logLevel was set — the default is INFO).
const gate = (lv) => {
  const p = path.join(tmp, `gate-${lv ?? "unset"}.log`);
  const g = createMatrixLogger(p, lv);
  g.error("E");
  g.warn("W");
  g.debug("D");
  return [...fs.readFileSync(p, "utf8").matchAll(/\[(\w+)\]/g)].map((m) => m[1][0].toUpperCase()).join("");
};
check(
  "logLevel gate keeps severity >= min (case-insensitive)",
  gate("INFO") === "EW" && gate("info") === "EW" && gate("DEBUG") === "EWD" && gate("ERROR") === "E" && gate(undefined) === "EWD",
  `INFO=${gate("INFO")} DEBUG=${gate("DEBUG")} ERROR=${gate("ERROR")} unset=${gate(undefined)}`,
);
fs.writeFileSync(logPath, "x".repeat(1_000_001));
lg.error("after rotation");
check(
  "logger rotates past 1MB (one generation kept)",
  fs.existsSync(logPath + ".old") &&
    fs.readFileSync(logPath + ".old", "utf8").length === 1_000_001 &&
    fs.readFileSync(logPath, "utf8").includes("[error] after rotation") &&
    fs.readFileSync(logPath, "utf8").length < 100,
);
const dirAsTarget = path.join(tmp, "log-is-a-dir");
fs.mkdirSync(dirAsTarget, { recursive: true });
let logThrew = false;
try {
  createMatrixLogger(dirAsTarget).error("fallback case");
} catch {
  logThrew = true;
}
check("log write failure falls back to console, never throws", logThrew === false);

finish();
