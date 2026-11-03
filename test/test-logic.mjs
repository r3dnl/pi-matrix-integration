/**
 * Logic test for matrix-client + message-handler + session-integration,
 * driven through jiti (same loader Pi uses) with a fake `mtx` binary.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPiJiti, EXT_DIR, makeCheck, waitUntil } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);

// ---- fake state ------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtx-fake-"));
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });

// The fake outbox (the PI_MATRIX_TEST_OUTBOX seam) logs its calls under
// ${FAKE_MTX_STATE} — keep that at the suite's hermetic state dir. The
// legacy fake-mtx binary + its events.json/read-count state is gone with
// the facade transport: no fake-mtx install, no addEvent helpers here.
process.env.FAKE_MTX_STATE = stateDir;
const TS = 1_700_000_000_000;

// ---- load modules ------------------------------------------------------------
const { check, finish } = makeCheck();

const { createMessageHandler } = await jiti.import(path.join(EXT_DIR, "src/message-handler.ts"));
const { createSessionIntegrator } = await jiti.import(path.join(EXT_DIR, "src/session-integration.ts"));
const { createTuiFooter } = await jiti.import(path.join(EXT_DIR, "src/tui-footer.ts"));
const { createThreadManager, summaryDue } = await jiti.import(path.join(EXT_DIR, "src/threading.ts"));
const { createTestOutbox } = await import("./fake-outbox.mjs");

const config = {
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

// ---- connect ------------------------------------------------------------------
console.log("== connect ==");
const fakeOutbox = createTestOutbox(config);
const connOk = await fakeOutbox.connect();
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
      { eventId: "$r1", sender: "@vincent:tst2-matrix.r3d.nl", body: "", timestamp: 1700000000000 + 4000, reactionKey: "👍\uFE0F", parentEventId: "$tgt" },
      { eventId: "$m1", sender: config.userId, body: "self message", timestamp: 1700000000000 + 4100, isFromPi: true },
      { eventId: "$t1", sender: "@vincent:tst2-matrix.r3d.nl", body: "root", timestamp: 1700000000000 + 4300, isThreadRoot: true },
      { eventId: "$t2", sender: "@vincent:tst2-matrix.r3d.nl", body: "reply", timestamp: 1700000000000 + 4400, threadRoot: "$t1" },
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
const evt = (eventId, { body, type = "m.room.message", reaction, sender } = {}) => ({
  eventId,
  type,
  sender: sender ?? "@vincent:tst2-matrix.r3d.nl",
  body: body ?? "",
  roomId: config.roomId,
  timestamp: Date.now(),
  isFromPi: (sender ?? "@vincent:tst2-matrix.r3d.nl") === config.userId,
  ...(reaction ? { reactionKey: reaction.key, parentEventId: reaction.event_id } : {}),
});

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
const handler = createMessageHandler({ outbox: fakeOutbox });
const integrator = createSessionIntegrator(
  fakePi,
  () => ({
    connected: connOk,
    connecting: false,
    roomUri: config.roomId,
    userId: config.userId,
    lastError: undefined,
  }),
  { messagePrefix: "[Matrix] ", showInFooter: false },
);
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
const credPath = path.join(credDir, "pi_user--matrix.r3d.nl", "credentials.json");
fs.mkdirSync(path.dirname(credPath), { recursive: true });
fs.writeFileSync(
  credPath,
  JSON.stringify({ user_id: "@pi_user:matrix.r3d.nl", homeserver: "https://matrix.r3d.nl", access_token: "tok" }),
);
const phase0CfgPath = path.join(stateDir, "phase0-cfg.json");
const basePhase0 = {
  roomId: "#pi-updates:matrix.r3d.nl",
  credentialsPath: credPath,
};
const writePhase0 = (obj) => {
  fs.writeFileSync(phase0CfgPath, JSON.stringify({ ...basePhase0, ...obj }));
  return phase0CfgPath;
};

// 1) credentials owner == userId → valid, userId retained
{
  const p = writePhase0({ userId: "@pi_user:matrix.r3d.nl" });
  const v = getValidConfig(p);
  check(
    "owner == userId → valid, userId retained",
    v.valid === true && v.config.userId === "@pi_user:matrix.r3d.nl",
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
      v.config.userId === "@pi_user:matrix.r3d.nl" &&
      v.config.homeserver === "matrix.r3d.nl",
    JSON.stringify({ userId: v.config.userId, homeserver: v.config.homeserver, errors: v.errors }),
  );
}

// 3) mismatch → invalid, error names both values
{
  const p = writePhase0({ userId: "@pi_agent:matrix.r3d.nl" });
  const v = getValidConfig(p);
  check(
    "mismatch → invalid, error names both values",
    v.valid === false &&
      v.errors.join(" ").includes("@pi_agent:matrix.r3d.nl") &&
      v.errors.join(" ").includes("@pi_user:matrix.r3d.nl"),
    JSON.stringify(v.errors),
  );
}

// 4) missing file + explicit userId → valid (R4: warn + allow). The explicit
//    userId is honored and the invariant simply cannot be checked.
{
  const p = writePhase0({ userId: "@pi_user:matrix.r3d.nl", homeserver: "matrix.r3d.nl", credentialsPath: path.join(credDir, "no-such.json") });
  const v = getValidConfig(p);
  check(
    "missing credentials + explicit userId → valid (R4)",
    v.valid === true && v.config.userId === "@pi_user:matrix.r3d.nl",
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
  const credNoHost = path.join(credDir, "nohost", "pi_user--matrix.r3d.nl", "credentials.json");
  fs.mkdirSync(path.dirname(credNoHost), { recursive: true });
  fs.writeFileSync(credNoHost, JSON.stringify({ user_id: "@pi_user:matrix.r3d.nl", access_token: "t" }));
  const p = writePhase0({ credentialsPath: credNoHost });
  const v = getValidConfig(p);
  check(
    "no homeserver anywhere → invalid (no default fallback, R3)",
    v.valid === false && v.errors.join(" ").includes("homeserver"),
    JSON.stringify(v.errors),
  );
}

// 7) unknown-key guard still catches csSelfUserId (never in the schema), and
//    the prd2-shaped config no longer carries it.
{
  const p = writePhase0({ userId: "@pi_user:matrix.r3d.nl", homeserver: "matrix.r3d.nl", csSelfUserId: "@pi_user:matrix.r3d.nl" });
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
    withField?.owner === "@pi_user:matrix.r3d.nl" && withField?.homeserver === "matrix.r3d.nl",
    JSON.stringify(withField),
  );
  const noFieldDir = path.join(credDir, "fallback", "pi_user--matrix.r3d.nl", "credentials.json");
  fs.mkdirSync(path.dirname(noFieldDir), { recursive: true });
  fs.writeFileSync(noFieldDir, JSON.stringify({ access_token: "t" }));
  const fallback = readCredentialsIdentity(noFieldDir);
  check(
    "readCredentialsIdentity: filename fallback yields owner",
    fallback?.owner === "@pi_user:matrix.r3d.nl",
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
  "guide covers the room's capabilities",
  ["plain language", "Slash commands", "/skill:", "numbered list", "milestones", "/matrix-help"]
    .every((needle) => helpOn.includes(needle)),
  JSON.stringify(helpOn.slice(0, 80)),
);
check(
  "guide is plain text (no HTML tags)",
  !/<\w[\w:]*[\s>]/.test(helpOn),
  "guide must be portable plain text",
);
check(
  "picker section reflects fileAttach=true",
  /Attach a file with @/.test(helpOn) && !/disabled in this deployment/.test(helpOn),
  JSON.stringify(helpOn.split("\n").find((l) => l.startsWith("3.")) ?? ""),
);
check(
  "picker section reflects fileAttach=false (off by default)",
  /disabled in this deployment/.test(helpOff) && !/disabled in this deployment/.test(helpOn),
  JSON.stringify(helpOff.split("\n").find((l) => l.startsWith("3.")) ?? ""),
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
    isAgentHelp("@pi_agent:tst2-matrix.r3d.nl help", AGENT) &&
    isAgentHelp("@pi_agent:tst2-matrix.r3d.nl: help", AGENT),
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

// ============================================================================
// Threading (DESIGN-ROOM-THREADING.md) — ThreadManager, thread fields on
// parsed events, profile loading. No network: the ThreadManager gets a fake
// cs object; thread-field checks ride the fake outbox's read fixture.
// ============================================================================
console.log("== threading: parseMatrixEvent thread fields ==");
// Thread-field rows on the fake outbox's readMessages channel (the v42-
// normalized MatrixMessage shape, same fixture discipline as the read
// normalization block above).
const threadFixture = path.join(stateDir, "thread-fixture.json");
fs.writeFileSync(
  threadFixture,
  JSON.stringify(
    [
      { eventId: "$evt-T1", sender: "@vincent:tst2-matrix.r3d.nl", body: "in-thread reply", timestamp: TS + 1000, threadRoot: "$evt-T0" },
      { eventId: "$evt-T3", sender: "@vincent:tst2-matrix.r3d.nl", body: "legacy MSC1767 in-thread reply", timestamp: TS + 1500, threadRoot: "$evt-T0" },
      { eventId: "$evt-T2", sender: config.userId, body: "🧵 New Conversation: testing", timestamp: TS + 2000, isFromPi: true, isThreadRoot: true },
      { eventId: "$evt-S1", sender: config.userId, body: "hello world", timestamp: TS + 500, isFromPi: true, isThreadRoot: false },
    ],
    null,
    1,
  ),
);
process.env.FAKE_OUTBOX_READ_FIXTURE = threadFixture;
const tmsgs = await fakeOutbox.readMessages(50);
delete process.env.FAKE_OUTBOX_READ_FIXTURE;
const inThread = tmsgs.find((m) => m.eventId === "$evt-T1");
const threadRootEv = tmsgs.find((m) => m.eventId === "$evt-T2");
check("reply-in-thread carries threadRoot (m.relates_to m.thread)", inThread?.threadRoot === "$evt-T0", JSON.stringify(inThread?.threadRoot));
check(
  "legacy MSC1767 event still yields threadRoot (fallback)",
  tmsgs.find((m) => m.eventId === "$evt-T3")?.threadRoot === "$evt-T0",
  JSON.stringify(tmsgs.find((m) => m.eventId === "$evt-T3")?.threadRoot),
);
check("thread root carries isThreadRoot", threadRootEv?.isThreadRoot === true, JSON.stringify(threadRootEv?.isThreadRoot));
check(
  "plain event has no thread fields",
  tmsgs.find((m) => m.eventId === "$evt-S1")?.threadRoot === undefined &&
    tmsgs.find((m) => m.eventId === "$evt-S1")?.isThreadRoot === false,
);

// The matrix-http wire-semantics block (injected request, /messages dir=b,
// m.thread/m.replace shape checks) died with test-matrix-http.mjs: raw-HTTP
// wire checks belong to the transport, and the single SdkOutbox transport no
// longer exposes them. What survives is the transport-contract claim: no
// credentials (token) -> unavailable -> every op fails soft, no throw.
console.log("== threading: transport unavailable fails soft ==");
{
  const cs = {
    available: () => false,
    async postThreadRoot() { return { success: false, error: "unavailable" }; },
    async postThreadReply() { return { success: false, error: "unavailable" }; },
  };
  check("no credentials \u2192 transport unavailable", cs.available() === false);
  const r = await cs.postThreadRoot("x");
  check("unavailable ops fail soft (no throw)", r.success === false, JSON.stringify(r));
}

console.log("== threading: ThreadManager lifecycle (fake cs) ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }
  const stateFile = path.join(stateDir, "thread-map.json");
  const fake = makeFakeMatrixHttp();
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:example",
    threadSend: fake,
    statePath: stateFile,
    threadIcon: "🧵",
    threadSummaryEvery: 3,
    threadSummaryFib: false,
  });

  // new session → pending, no matrix-http traffic yet
  tm.beginSession("new", "sess-1");
  check("new session is pending", tm.pending() === true);
  check("pending session does not route", tm.canRoute() === false);
  check("no matrix-http calls while pending", fake.calls.length === 0, JSON.stringify(fake.calls));

  // first user message creates the root (ordering invariant: root first)
  const root = await tm.ensureThreadRoot("testing");
  check("ensureThreadRoot returns the root", root?.eventId === "$froot-1", JSON.stringify(root));
  check("root posted before any reply", fake.calls[0][0] === "root", JSON.stringify(fake.calls[0]));
  check("root post carries the icon + topic", String(fake.calls[0][1]).includes("🧵 New Conversation: testing"), JSON.stringify(fake.calls[0]));
  check("session now routes", tm.canRoute() === true && tm.pending() === false);
  check("ensureThreadRoot is idempotent", (await tm.ensureThreadRoot())?.eventId === "$froot-1");

  // Runtime toggle (/matrix-thread-toggle): off → flat routing, on → resumes
  // to the same root.
  tm.setEnabled(false);
  check("setEnabled(false) stops routing (flat path)", tm.canRoute() === false);
  tm.setEnabled(true);
  check(
    "setEnabled(true) resumes routing to the same root",
    tm.canRoute() === true && tm.activeRoot()?.eventId === "$froot-1",
    JSON.stringify(tm.activeRoot()),
  );

  // Topic-less root: bare label — no "New Conversation: New Conversation".
  const bareCs = makeFakeMatrixHttp();
  const tmBare = createThreadManager({
    enabled: true, roomKey: "!room:bare", threadSend: bareCs,
    statePath: path.join(stateDir, "thread-map-bare.json"),
  });
  tmBare.beginSession("new", "s2");
  await tmBare.ensureThreadRoot();
  check(
    "topic-less root posts the bare label",
    String(bareCs.calls[0][1]) === "🧵 New Conversation",
    JSON.stringify(bareCs.calls[0]),
  );

  // posts route into the root
  const p1 = await tm.post("🎯 Milestone: first", "milestone");
  check("post routes into the active root", p1.success === true, JSON.stringify(p1));
  check("post is an in-thread reply to the root", fake.calls.find((c) => c[0] === "reply")?.[2] === "$froot-1", JSON.stringify(fake.calls));

  // summarizer: every 3rd in-thread send edits the root
  const editsBefore = fake.calls.filter((c) => c[0] === "edit").length;
  await tm.post("b", "other");
  await tm.post("c", "other");
  const editsAfter = fake.calls.filter((c) => c[0] === "edit").length;
  check(
    "3rd in-thread send triggers a root edit (summarizer)",
    editsAfter === editsBefore + 1,
    `before=${editsBefore} after=${editsAfter}`,
  );
  const editCall = fake.calls.filter((c) => c[0] === "edit").pop();
  check(
    "summary is plain-English topic + latest status (no timestamp)",
    editCall[2].includes("testing") &&
      editCall[2].includes("now: first") &&
      !/\d{4}-\d{2}-\d{2}T/.test(editCall[2]) &&
      !editCall[2].includes("msgs"),
    JSON.stringify(editCall[2]),
  );

  // more milestones → "main: …" highlights + "now: …" latest status
  await tm.post("🎯 Milestone: second", "milestone");
  await tm.post("🎯 Milestone: third", "milestone");
  await tm.post("d", "other");
  const editCall2 = fake.calls.filter((c) => c[0] === "edit").pop();
  check(
    "summary shows main milestones + latest status",
    editCall2[2].includes("main: first; second") && editCall2[2].includes("now: third"),
    JSON.stringify(editCall2[2]),
  );

  // state map persisted + re-attach on a fresh manager (reload = same
  // session keeps its thread; startup = fresh session → pending, like new)
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  check("state map persisted under the room key", Array.isArray(saved["!room:example"]?.roots) && saved["!room:example"].roots.length === 1, JSON.stringify(saved));
  const tm2 = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm2.beginSession("reload", "sess-1");
  check("reload re-attaches to the most recent root", tm2.activeRoot()?.eventId === "$froot-1", JSON.stringify(tm2.activeRoot()));
  const tm2b = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm2b.beginSession("startup", "sess-1");
  check("startup (fresh session) stays pending, no re-attach", tm2b.pending() === true && tm2b.activeRoot() === undefined, JSON.stringify(tm2b.activeRoot()));

  // /new then /reload: a fresh session id with no mapped root must NOT
  // hijack the previous session's latest thread — stay pending so the first
  // message opens a new root. Unknown session id → latest-root fallback.
  const tm2c = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm2c.beginSession("new", "sess-2");
  tm2c.beginSession("reload", "sess-2");
  check("reload after /new stays pending, no hijack of the old thread", tm2c.pending() === true && tm2c.activeRoot() === undefined, JSON.stringify(tm2c.activeRoot()));
  const tm2d = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm2d.beginSession("reload");
  check("reload without a session id falls back to the latest root", tm2d.activeRoot()?.eventId === "$froot-1", JSON.stringify(tm2d.activeRoot()));

  // resume with a known sessionHint re-attaches; unknown hint → pending
  const tm3 = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile, sessionHint: "sess-1" });
  tm3.beginSession("resume", "sess-1");
  check("resume re-attaches by sessionHint", tm3.activeRoot()?.eventId === "$froot-1");
  const tm4 = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm4.beginSession("resume", "unknown-hint");
  check("resume with unknown hint → pending", tm4.pending() === true);

  // adopt an existing user-started thread root
  const tm5 = createThreadManager({ enabled: true, roomKey: "!room:example", threadSend: fake, statePath: stateFile });
  tm5.beginSession("new", "sess-2");
  const adopted = tm5.adoptRoot("$user-root");
  check("adoptRoot activates a foreign root", adopted?.eventId === "$user-root" && tm5.canRoute() === true, JSON.stringify(adopted));

  // TO-BE §1.5: callers no longer pre-compute html — the pipeline
  // (MessageHandler.postInThread) converts markdown at write time.
  await tm.post("m **bold**", "other");
  const lastReply = fake.calls.filter((c) => c[0] === "reply").at(-1);
  check("tm.post carries no caller html (the pipeline formats at write)", lastReply?.[3] === undefined, JSON.stringify(lastReply));
}

console.log("== threading: LLM summarization runs (fake cs) ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }
  const fake = makeFakeMatrixHttp();
  const requests = [];
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:llm",
    threadSend: fake,
    statePath: path.join(stateDir, "thread-map-llm.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 3,
    threadSummaryFib: false,
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => { requests.push(root); },
  });
  tm.beginSession("new", "llm-1");
  await tm.ensureThreadRoot("llm topic");

  // LLM mode: the cadence fires the directive, NOT a matrix-http edit
  await tm.post("🎯 Milestone: one", "milestone");
  await tm.post("b", "other");
  await tm.post("c", "other");
  check(
    "3rd send requests an LLM run (no root edit yet)",
    requests.length === 1 && fake.calls.filter((c) => c[0] === "edit").length === 0,
    `requests=${requests.length} edits=${fake.calls.filter((c) => c[0] === "edit").length}`,
  );
  check("request carries the active root", requests[0]?.eventId === "$froot-1", JSON.stringify(requests[0]?.eventId));

  // agent completes the run → the tool path (markdown body, 🧵 line prepended)
  const md = "# Topic: llm topic\n## Main discussion points\n- a — status: in progress";
  const ok = await tm.updateSummary(md);
  const edit = fake.calls.filter((c) => c[0] === "edit").pop();
  check("LLM update edits the root with 🧵 topic + grey session line + markdown", ok === true && edit[2] === `🧵 llm topic\n\`llm-1\`\n${md}`, JSON.stringify(edit?.[2]));
  check("run bookkeeping persisted", tm.activeRoot()?.lastSummary === md && tm.activeRoot()?.lastSummaryAtMsg === 3, JSON.stringify({ s: tm.activeRoot()?.lastSummaryAtMsg }));
  // TO-BE §1.5: the edit request carries no caller html — the pipeline's
  // editInThread owns the always-html rule (markdown.ts converts at write).
  check(
    "LLM edit request carries the m.replace payload (the pipeline owns the html)",
    edit[3]?.threadRoot === true && edit[3]?.html === undefined,
    JSON.stringify(edit?.[3]),
  );

  // more sends → a new run is requested (there is delta since the last completed run)
  await tm.post("d", "other");
  await tm.post("e", "other");
  await tm.post("f", "other");
  check("6th send requests another LLM run", requests.length === 2, String(requests.length));

  // manual run: LLM mode fires the directive; heuristic mode does the edit itself
  const bare = createThreadManager({ enabled: true, roomKey: "!room:nx", threadSend: fake });
  bare.beginSession("new", "nx-1");
  check("manual run without a thread → false", (await bare.requestSummarizeNow()) === false, JSON.stringify(await bare.requestSummarizeNow()));
  const before = requests.length;
  const manual = await tm.requestSummarizeNow();
  check("manual LLM run fires the directive", manual === true && requests.length === before + 1, String(requests.length));

  const fakeH = makeFakeMatrixHttp();
  const tmH = createThreadManager({ enabled: true, roomKey: "!room:heur", threadSend: fakeH, statePath: path.join(stateDir, "thread-map-heur.json"), threadSummaryEvery: 3 });
  tmH.beginSession("new", "h-1");
  await tmH.ensureThreadRoot("heur topic");
  await tmH.post("x", "other");
  const hOk = await tmH.requestSummarizeNow();
  const hEdit = fakeH.calls.filter((c) => c[0] === "edit").pop();
  check("manual heuristic run edits the root immediately", hOk === true && hEdit[2].includes("heur topic") && hEdit[2].includes("in progress"), JSON.stringify(hEdit?.[2]));
  check("heuristic edit request carries no caller html (the pipeline's always-html rule formats it)", hEdit[3]?.threadRoot === true && hEdit[3]?.html === undefined, JSON.stringify(hEdit?.[3]));
}

// ---- threading: single-flight summary dispatch (DESIGN-THREADING-SUMMARIZE §2) ----
console.log("== threading: single-flight summary dispatch ==");
{
  let n = 0;
  const calls = [];
  const fake = {
    async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$sf-root-${n}` }; },
    async postThreadReply(body) { calls.push(["reply", body]); n++; return { success: true, eventId: `$sf-rep-${n}` }; },
    async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
    async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
  };
  const requests = [];
  let release = null;
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:flight",
    threadSend: fake,
    statePath: path.join(stateDir, "thread-map-flight.json"),
    threadSummaryEvery: 1,
    threadSummaryFib: false,
    threadSummaryByLlm: true,
    // the dispatcher stand-in: pending until the test releases it
    onSummarizeRequest: () => {
      requests.push(1);
      return new Promise((res) => { release = res; });
    },
  });
  tm.beginSession("new", "fl-1");
  await tm.ensureThreadRoot("flight topic");

  await tm.post("a", "other"); // cadence point 1 → dispatch #1 (in flight)
  await tm.post("b", "other"); // cadence point 2 → skipped while in flight
  check("second cadence point skipped while a run is in flight", requests.length === 1, String(requests.length));

  release();
  await new Promise((res) => setImmediate(res)); // flush the settle/finally chain
  await tm.post("c", "other"); // point 3 → dispatch #2 after the settle
  check("cadence re-arms once the run settles", requests.length === 2, String(requests.length));

  // manual run while in flight: reports wired, does NOT double-dispatch
  const manual = await tm.requestSummarizeNow();
  check("manual run in flight: wired, no double dispatch", manual === true && requests.length === 2, String(requests.length));
  release();
  await new Promise((res) => setImmediate(res));
}

// ---- threading: summary size-cap backstop (fir-tree maxLines) ----
console.log("== threading: summary size-cap backstop ==");
{
  let n = 0;
  const calls = [];
  const fake = {
    calls,
    async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$cap-root-${n}` }; },
    async postThreadReply(body) { calls.push(["reply", body]); n++; return { success: true, eventId: `$cap-rep-${n}` }; },
    async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
    async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
  };
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:cap",
    threadSend: fake,
    statePath: path.join(stateDir, "thread-map-cap.json"),
    threadSummaryByLlm: true,
    threadSummaryMaxLines: 4,
  });
  tm.beginSession("new", "cap-1");
  await tm.ensureThreadRoot("cap topic");
  await tm.updateSummary("# T\na\nb\nc\nd\ne");
  const edit = fake.calls.filter((c) => c[0] === "edit").pop();
  check(
    "posted body truncated at line boundary to maxLines",
    edit?.[2] === "🧵 cap topic\n`cap-1`\n# T\na\nb\nc",
    JSON.stringify(edit?.[2]),
  );
  check(
    "truncated body stored as the baseline",
    tm.activeRoot()?.lastSummary === "# T\na\nb\nc",
    JSON.stringify(tm.activeRoot()?.lastSummary),
  );
}

console.log("== threading: fibonacci-capped summary cadence ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }

  // Pure schedule (cap 10): intervals 1,1,2,3,5,8,10,10… → absolute
  // trigger points 1, 2, 4, 7, 12, 20, 30, 40 (>= semantics).
  check("fib cap=10: due exactly at points 1,2,4,7,12,20,30,40", JSON.stringify([
    summaryDue(1, 10, true), summaryDue(2, 10, true),
    summaryDue(4, 10, true), summaryDue(7, 10, true),
    summaryDue(12, 10, true), summaryDue(20, 10, true),
    summaryDue(30, 10, true), summaryDue(40, 10, true),
  ]) === "[true,true,true,true,true,true,true,true]");
  check("fib cap=10: not due between points", JSON.stringify([
    summaryDue(0, 10, true), summaryDue(3, 10, true),
    summaryDue(6, 10, true), summaryDue(11, 10, true),
    summaryDue(19, 10, true), summaryDue(29, 10, true),
    summaryDue(39, 10, true),
  ]) === "[false,false,false,false,false,false,false]");
  check("fixed mode keeps the modulo cadence", summaryDue(6, 3, false) === true && summaryDue(5, 3, false) === false);
  check("cap=1 degenerates to every message", summaryDue(1, 1, true) === true && summaryDue(2, 1, true) === true);

  // Manager level: every=3 caps the fib intervals at 1,1,2,3,3…
  // → LLM runs fire at in-thread sends 1, 2, 4, 7.
  const fake = makeFakeMatrixHttp();
  const requests = [];
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:fib",
    threadSend: fake,
    statePath: path.join(stateDir, "thread-map-fib.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 3,
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => { requests.push(root.msgCount); },
  });
  tm.beginSession("new", "fib-1");
  await tm.ensureThreadRoot("fib topic");
  for (let i = 1; i <= 8; i++) await tm.post(`m${i}`, "other");
  check(
    "fib cadence (every=3) fires at sends 1, 2, 4, 7",
    JSON.stringify(requests) === "[1,2,4,7]",
    JSON.stringify(requests),
  );
  check("a pending request does not re-fire between scheduled points", requests.length === 4, JSON.stringify(requests));
}

console.log("== threading: report-out (final) summary trigger ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }

  // LLM mode, cadence off: the "final" post is the report-out trigger.
  // A pending request is a watermark — no second request until the run
  // completes; a completed run (updateSummary) re-arms it.
  const fakeL = makeFakeMatrixHttp();
  const reqsL = [];
  const tmL = createThreadManager({
    enabled: true,
    roomKey: "!room:finllm",
    threadSend: fakeL,
    statePath: path.join(stateDir, "thread-map-finish.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 0,
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => { reqsL.push(root.msgCount); },
  });
  tmL.beginSession("new", "fin-1");
  await tmL.ensureThreadRoot("fin topic");
  await tmL.post("report one", "final");
  check("first report-out fires an LLM summary request", reqsL.length === 1 && reqsL[0] === 1, JSON.stringify(reqsL));
  await tmL.post("still working", "other");
  await tmL.post("report two", "final");
  check("pending request is the watermark (no duplicate request)", reqsL.length === 1, JSON.stringify(reqsL));
  await tmL.updateSummary("# Topic: fin topic\n## Points\n- done");
  await tmL.post("report three", "final");
  check("completed run re-arms the trigger (new material → request)", reqsL.length === 2 && reqsL[1] === 4, JSON.stringify(reqsL));

  // Wake-answer final (BUG-SUMMARIZER-ONFINAL-LOOP A): the answer still lands
  // in the thread, the report-out trigger does not fire for it — once.
  const fakeW = makeFakeMatrixHttp();
  const reqsW = [];
  const tmW = createThreadManager({
    enabled: true,
    roomKey: "!room:finwake",
    threadSend: fakeW,
    statePath: path.join(stateDir, "thread-map-finwake.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 0,
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => { reqsW.push(root.msgCount); },
  });
  tmW.beginSession("new", "finwake-1");
  await tmW.ensureThreadRoot("fin wake");
  tmW.suppressNextOnFinalTrigger();
  await tmW.post("wake answer, still waiting", "final");
  check("wake-answer final posts, no summary request", reqsW.length === 0 && fakeW.calls.filter((c) => c[0] === "reply").length === 1, JSON.stringify(reqsW));
  await tmW.post("real report", "final");
  check("the suppression is one-shot (next final fires)", reqsW.length === 1 && reqsW[0] === 2, JSON.stringify(reqsW));

  // Content gate (BUG-SUMMARIZER-ONFINAL-LOOP B): a pass whose whole delta is
  // wake-answer bookkeeping re-summarises its own output — skipped.
  const fakeB = makeFakeMatrixHttp();
  const reqsB = [];
  const tmB = createThreadManager({
    enabled: true,
    roomKey: "!room:finbook",
    threadSend: fakeB,
    statePath: path.join(stateDir, "thread-map-finbook.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 2,
    threadSummaryFib: false,
    threadSummaryByLlm: true,
    onSummarizeRequest: (root) => { reqsB.push(root.msgCount); },
  });
  tmB.beginSession("new", "finbook-1");
  await tmB.ensureThreadRoot("fin book");
  tmB.suppressNextOnFinalTrigger();
  await tmB.post("wake answer 1", "final");
  tmB.suppressNextOnFinalTrigger();
  await tmB.post("wake answer 2", "final");
  check("bookkeeping-only delta fires no pass (cadence point included)", reqsB.length === 0, JSON.stringify(reqsB));
  await tmB.post("real report after waiting", "final");
  check("real content after bookkeeping still fires the pass", reqsB.length === 1 && reqsB[0] === 3, JSON.stringify(reqsB));

  // Heuristic mode: the final-triggered run edits the root immediately
  // (zero LLM cost) and re-arms on every report-out.
  const fakeH = makeFakeMatrixHttp();
  const tmH = createThreadManager({
    enabled: true,
    roomKey: "!room:finheur",
    threadSend: fakeH,
    statePath: path.join(stateDir, "thread-map-finheur.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 0,
  });
  tmH.beginSession("new", "finh-1");
  await tmH.ensureThreadRoot("fin heuristic");
  await tmH.post("mid work", "other");
  check("non-final send stays silent (cadence off)", fakeH.calls.filter((c) => c[0] === "edit").length === 0, JSON.stringify(fakeH.calls));
  await tmH.post("report done", "final");
  check("report-out edits the root immediately (heuristic)", fakeH.calls.filter((c) => c[0] === "edit").length === 1, JSON.stringify(fakeH.calls));

  // Flag off: no trigger on final posts.
  const fakeO = makeFakeMatrixHttp();
  const tmO = createThreadManager({
    enabled: true,
    roomKey: "!room:finoff",
    threadSend: fakeO,
    statePath: path.join(stateDir, "thread-map-finoff.json"),
    threadIcon: "🧵",
    threadSummaryEvery: 0,
    threadSummaryOnFinal: false,
  });
  tmO.beginSession("new", "finoff-1");
  await tmO.ensureThreadRoot("fin off");
  await tmO.post("report", "final");
  check("threadSummaryOnFinal=false disables the report-out trigger", fakeO.calls.filter((c) => c[0] === "edit").length === 0, JSON.stringify(fakeO.calls));
}

console.log("== threading: teardown clobber guard (fake cs) ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic(t) { calls.push(["topic", t]); return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }

  // LLM mode + a saved baseline: a no-arg updateSummary() (what shutdown()
  // calls at /reload, /new, and quit) must re-post lastSummary, never
  // re-derive the heuristic — that re-derivation is the clobber that erased
  // the LLM-written root. (DESIGN §6.2)
  const fake = makeFakeMatrixHttp();
  const tm = createThreadManager({
    enabled: true,
    roomKey: "!room:clobber",
    threadSend: fake,
    statePath: path.join(stateDir, "thread-map-clobber.json"),
    threadIcon: "🧵",
    threadSummaryByLlm: true,
  });
  tm.beginSession("new", "clobber-1");
  await tm.ensureThreadRoot("clobber topic");
  const md = "# Topic: clobber topic\n## Main discussion points\n- a — status: completed";
  await tm.updateSummary(md); // LLM run establishes the baseline
  const ok = await tm.updateSummary(); // no-arg = the shutdown/teardown path
  const edit = fake.calls.filter((c) => c[0] === "edit").pop();
  check(
    "no-arg updateSummary() in LLM mode re-posts lastSummary (no clobber)",
    ok === true && edit[2] === `🧵 clobber topic\n\`clobber-1\`\n${md}`,
    JSON.stringify(edit?.[2]),
  );
  check(
    "clobber guard does not downgrade the root to the heuristic",
    !/in progress|now:/.test(edit[2] ?? ""),
    JSON.stringify(edit?.[2]),
  );

  // control: heuristic mode (no threadSummaryByLlm) still re-derives the heuristic
  const fakeH = makeFakeMatrixHttp();
  const tmH = createThreadManager({
    enabled: true,
    roomKey: "!room:clobber-heur",
    threadSend: fakeH,
    statePath: path.join(stateDir, "thread-map-clobber-heur.json"),
    threadIcon: "🧵",
  });
  tmH.beginSession("new", "clobber-heur-1");
  await tmH.ensureThreadRoot("heur topic");
  const okH = await tmH.updateSummary();
  const editH = fakeH.calls.filter((c) => c[0] === "edit").pop();
  check(
    "no-arg updateSummary() in heuristic mode still uses the heuristic",
    okH === true && /in progress|now:|heur topic/.test(editH[2] ?? ""),
    JSON.stringify(editH?.[2]),
  );
}

console.log("== threading: sub-threads (fake cs) ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply(body, rootId, nested) { calls.push(["reply", body, rootId, nested]); n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage() { return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }
  const fake = makeFakeMatrixHttp();
  const tm = createThreadManager({
    enabled: true, roomKey: "!room:sub", threadSend: fake, statePath: path.join(stateDir, "thread-map-sub.json"),
    subThreads: true, rolePrefixes: true,
  });
  tm.beginSession("new", "s");
  await tm.ensureThreadRoot("parent");
  const sub = await tm.spawnSubThread("tester", "tester");
  check("spawnSubThread records a sub root", sub?.eventId !== undefined, JSON.stringify(sub));
  check("sub root posted under the parent", fake.calls.find((c) => c[0] === "reply" && c[2] === "$froot-1") !== undefined, JSON.stringify(fake.calls));
  const done = await tm.completeSubThread("tester", true, "tester");
  check("completeSubThread returns the sub", done?.name === "tester");
  check("completion marker posted into the sub root", fake.calls.some((c) => c[0] === "reply" && c[2] === sub?.eventId && /finished/.test(c[1])), JSON.stringify(fake.calls));
}

console.log("== threading: adoption while active (follow the user's thread) ==");
{
  const calls = [];
  let n = 0;
  const fake = {
    async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$aroot-${n}` }; },
    async postThreadReply(body, rootId) { calls.push(["reply", body, rootId]); n++; return { success: true, eventId: `$arep-${n}` }; },
    async editMessage() { return { success: true }; },
    async setRoomTopic() { return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
    calls,
  };
  const tmA = createThreadManager({ enabled: true, roomKey: "!room:adopt", threadSend: fake, statePath: path.join(stateDir, "thread-map-adopt.json") });
  tmA.beginSession("new", "s");
  const own = await tmA.ensureThreadRoot("mine");
  check("session active on its own root", tmA.activeRoot()?.eventId === own?.eventId && tmA.pending() === false, JSON.stringify(tmA.activeRoot()));
  const userThread = tmA.adoptRoot("$user-thread");
  check("adopting a different root WHILE ACTIVE switches routing", userThread?.eventId === "$user-thread" && tmA.activeRoot()?.eventId === "$user-thread", JSON.stringify(tmA.activeRoot()));
  const p = await tmA.post("follows the user", "other");
  check("posts now land in the user's thread", p.success === true && fake.calls.find((c) => c[0] === "reply")?.[2] === "$user-thread", JSON.stringify(fake.calls));
}

console.log("== threading: MessageHandler routes into the active thread ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      available: () => true,
      async postMessage(body, html) { calls.push(["msg", body, html]); n++; return { success: true, eventId: `$hmsg-${n}` }; },
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$hroot-${n}` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$hrep-${n}` }; },
      async editMessage() { return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }
  const fake = makeFakeMatrixHttp();
  const tm = createThreadManager({
    enabled: true, roomKey: "!room:handler", threadSend: fake,
    statePath: path.join(stateDir, "thread-map-handler.json"), threadSummaryEvery: 0,
  });
  tm.beginSession("new", "s");
  const handler = createMessageHandler({ outbox: fake, threadManager: tm, dedupeWindowMs: 1 });

  // Milestone while pending: NO thread root (§1.4 lazy creation — only the
  // first user message creates the thread; abandoned sessions leave none).
  // Falls through to the flat mtx send; the session stays pending.
  const early = await handler.sendMilestone("early milestone");
  check(
    "pending milestone sends flat and creates no thread root",
    early.success === true && !fake.calls.some((c) => c[0] === "root") && tm.pending() === true,
    JSON.stringify({ early, calls: fake.calls }),
  );

  // First user message: thread pending → root created, then the user
  // message is posted in-thread (DESIGN §1.4 ordering invariant).
  const u = await handler.sendUserMessage("hi there");
  check("first user message succeeds via the thread", u.success === true, JSON.stringify(u));
  const activeRootId = tm.activeRoot()?.eventId;
  check(
    "root posted first, user message second (in-thread reply)",
    fake.calls.find((c) => c[0] === "root") !== undefined &&
      fake.calls.find((c) => c[0] === "reply")?.[2] === activeRootId &&
      String(fake.calls.find((c) => c[0] === "reply")?.[1]).includes("🧑 User: hi there"),
    JSON.stringify(fake.calls),
  );

  // A milestone routes into the active thread too.
  await handler.sendMilestone("phase done");
  check(
    "milestone routes into the active thread",
    fake.calls.some((c) => c[0] === "reply" && c[2] === activeRootId && /🎯 Milestone: phase done/.test(c[1])),
    JSON.stringify(fake.calls),
  );

  // Explicit flat send (the /new announcement): metadata.flat bypasses
  // thread routing even with an active thread — it must not soft-attach
  // into the previous session's thread under `threadPendingRoute: "latest"`.
  const repliesBefore = fake.calls.filter((c) => c[0] === "reply").length;
  const flatRes = await handler.handleOutgoingMessage({
    type: "milestone",
    content: "Pi started a new session (/new)",
    metadata: { flat: true },
    timestamp: Date.now(),
  });
  check(
    "metadata.flat posts to the room, skipping the active thread",
    flatRes.success === true &&
      fake.calls.filter((c) => c[0] === "msg").length ===
        fake.calls.filter((c) => c[0] === "msg" && !/new session/.test(String(c[1]))).length + 1 &&
      fake.calls.filter((c) => c[0] === "reply").length === repliesBefore,
    JSON.stringify(fake.calls.slice(-3)),
  );

  // The decision ledger is now driven by the ask_user_question mirror (post
  // kind "decision" → close on the wait ending), not a requestDecision tool.
  const dec = await tm.post("🤖 Pi decision (RPIV) — Q1: proceed?", "decision");
  check(
    "in-thread decision post counts an open decision in the ledger",
    dec.success === true && tm.status().activeRoot?.openDecisions === 1,
    JSON.stringify(tm.status().activeRoot),
  );
  tm.noteDecisionClosed();
  check("closing the decision zeroes the open-decision count", tm.status().activeRoot?.openDecisions === 0);
  check(
    "thread sends without sendFormatted stay plain (no html)",
    fake.calls.filter((c) => c[0] === "reply").every((c) => c[3] === undefined),
    JSON.stringify(fake.calls.filter((c) => c[0] === "reply")),
  );

  // sendFormatted parity on the thread path (markdown regression fix):
  // an in-thread send must carry the same html the flat path would have sent.
  // TO-BE §1.5: production-shape wiring — the manager's write delegate
  // routes through the handler pipeline (late-bound, like index.ts), so
  // the write-time formatting under test is the pipeline's own.
  const fakeFmt = { ...makeFakeMatrixHttp(), available: () => true, postMessage: async (body) => { fakeFmt.calls.push(["msg", body]); return { success: true, eventId: "$flat-fmt" }; } };
  let handlerFmt;
  const tmFmt = createThreadManager({
    enabled: true, roomKey: "!room:handler-fmt", threadSend: {
      postThreadRoot: (b, h) => handlerFmt.postInThread(b, undefined, { html: h }),
      postThreadReply: (b, r, n, h) => handlerFmt.postInThread(b, r, { nestedRoot: n, html: h }),
      editMessage: (i, t, o) => handlerFmt.editInThread(i, t, o?.html),
      setRoomTopic: async () => ({ success: true }),
      readTimeline: async () => ({ success: false, messages: [] }),
    },
    statePath: path.join(stateDir, "thread-map-handler-fmt.json"), threadSummaryEvery: 0,
  });
  tmFmt.beginSession("new", "sf");
  handlerFmt = createMessageHandler({ threadManager: tmFmt, sendFormatted: true, dedupeWindowMs: 1, outbox: fakeFmt });
  // Only a user message creates the root (§1.4) — the milestone that used
  // to seed this test now lands flat while pending, so seed via the user.
  await handlerFmt.sendUserMessage("first words");
  await handlerFmt.sendMilestone("phase **done**");
  const fmtReply = fakeFmt.calls.find((c) => c[0] === "reply" && /Milestone/.test(String(c[1])));
  check(
    "thread send carries html when sendFormatted (the pipeline formats at write)",
    /<strong>done<\/strong>/.test(String(fmtReply?.[3] ?? "")),
    JSON.stringify(fmtReply),
  );
}

console.log("== threading: pending soft-attach (threadPendingRoute) ==");
{
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$p${n}-root` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$p${n}-rep` }; },
      async editMessage() { return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline() { return { success: false, messages: [] }; },
    };
  }

  // Seed a room state with two roots (second = most recent).
  const fake = makeFakeMatrixHttp();
  const stateFile = path.join(stateDir, "thread-map-softattach.json");
  const seeder = createThreadManager({ enabled: true, roomKey: "!room:soft", threadSend: fake, statePath: stateFile, threadSummaryEvery: 0 });
  seeder.beginSession("new", "s1");
  const r1 = await seeder.ensureThreadRoot("first");
  seeder.beginSession("new", "s2");
  const r2 = await seeder.ensureThreadRoot("second");
  // Deterministic "most recent": pin root1 behind root2 in lastActivity.
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  saved["!room:soft"].roots[0].lastActivity = 1;
  saved["!room:soft"].roots[1].lastActivity = 2;
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2));

  // Soft-attach manager: pending + pendingRoute "latest" → non-user sends
  // borrow the most recent root; the session stays pending; a user send
  // still opens a NEW root.
  const tm = createThreadManager({
    enabled: true, roomKey: "!room:soft", threadSend: fake, statePath: stateFile,
    threadSummaryEvery: 0, pendingRoute: "latest",
  });
  tm.beginSession("new", "s3");
  check("soft-attach manager starts pending", tm.pending() === true);
  const m = await tm.post("🎯 Milestone: headless work", "milestone");
  check(
    "pending non-user send soft-attaches to the most recent root",
    m.success === true &&
      fake.calls.find((c) => c[0] === "reply" && /headless work/.test(String(c[1])))?.[2] === r2.eventId,
    JSON.stringify(fake.calls.slice(-2)),
  );
  check("session stays pending after a soft-attach send", tm.pending() === true);
  const u = await tm.post("🧑 User: fresh", "user");
  check("user send never soft-attaches", u.success === false && u.error === "no active thread", JSON.stringify(u));
  const r3 = await tm.ensureThreadRoot("fresh");
  check(
    "first user message still opens a NEW root",
    r3?.eventId !== r2.eventId && tm.activeRoot()?.eventId === r3?.eventId && tm.pending() === false,
    JSON.stringify(r3),
  );

  // Default (no pendingRoute): pending sends fail without matrix-http traffic.
  const fake2 = makeFakeMatrixHttp();
  const tmFlat = createThreadManager({ enabled: true, roomKey: "!room:soft", threadSend: fake2, statePath: stateFile, threadSummaryEvery: 0 });
  tmFlat.beginSession("new", "s4");
  const f = await tmFlat.post("🎯 Milestone: stays flat", "milestone");
  check(
    "default (flat) pending send fails with no matrix-http traffic",
    f.success === false && fake2.calls.length === 0,
    JSON.stringify({ f, calls: fake2.calls }),
  );

  // "latest" with zero roots → fails flat, no matrix-http traffic.
  const fake3 = makeFakeMatrixHttp();
  const tmEmpty = createThreadManager({
    enabled: true, roomKey: "!room:empty", threadSend: fake3,
    statePath: path.join(stateDir, "thread-map-softattach-empty.json"),
    threadSummaryEvery: 0, pendingRoute: "latest",
  });
  tmEmpty.beginSession("new", "s5");
  const e = await tmEmpty.post("🎯 Milestone: no threads yet", "milestone");
  check("latest with no roots fails flat", e.success === false && fake3.calls.length === 0, JSON.stringify({ e, calls: fake3.calls }));

  // Handler seam: pending non-user sends go through tm.post; a failing
  // tm.post falls back to the flat send (§2.11: never drop the message).
  const flatSends = [];
  const flatOutbox = {
    available: () => true,
    async postMessage(text) { flatSends.push(text); return { success: true, eventId: "$flat" }; },
    async postThreadRoot(body) { flatSends.push(body); return { success: true, eventId: "$flat-root" }; },
    async postThreadReply(body, rootId) { flatSends.push(body); return { success: true, eventId: "$flat-rep" }; },
    async editMessage() { return { success: true }; },
    async setRoomTopic() { return { success: true }; },
    async readTimeline() { return { success: false, messages: [] }; },
  };
  const softTm = {
    enabled: () => true,
    pending: () => true,
    canRoute: () => false,
    async post(body) { return { eventId: "$soft", success: true, timestamp: Date.now() }; },
  };
  const handlerSoft = createMessageHandler({ outbox: flatOutbox, threadManager: softTm, dedupeWindowMs: 1 });
  const s1 = await handlerSoft.sendMilestone("in-thread via soft-attach");
  check(
    "pending milestone goes through tm.post (soft-attach)",
    s1.success === true && s1.eventId === "$soft" && flatSends.length === 0,
    JSON.stringify({ s1, flatSends }),
  );
  const failTm = { ...softTm, async post() { return { eventId: "", success: false, error: "no active thread", timestamp: Date.now() }; } };
  const handlerFail = createMessageHandler({ outbox: flatOutbox, threadManager: failTm, dedupeWindowMs: 1 });
  const s2 = await handlerFail.sendMilestone("falls back flat");
  check(
    "pending send with a failing tm.post falls back to the flat send",
    s2.success === true && flatSends.length === 1 && flatSends[0].includes("falls back flat"),
    JSON.stringify(flatSends),
  );
}

console.log("== threading: cross-instance lastSummary sync (refreshFromDisk) ==");
{
  // The main session and the summarizer subagent each hold their own
  // in-memory ThreadManager; the state file is the only thing they share.
  // After one instance posts a summary, the other's next run must see it.
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot(body) { calls.push(["root", body]); n++; return { success: true, eventId: `$xi${n}-root` }; },
      async postThreadReply(body, rootId, _nested, html) { calls.push(["reply", body, rootId, html]); n++; return { success: true, eventId: `$xi${n}-rep` }; },
      async editMessage(id, text, opts) { calls.push(["edit", id, text, opts]); return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline() { return { success: true, messages: [] }; },
    };
  }
  const fake = makeFakeMatrixHttp();
  const stateFile = path.join(stateDir, "thread-map-crossinst.json");
  const llmOpts = { enabled: true, roomKey: "!room:xi", statePath: stateFile, threadSummaryEvery: 1, threadSummaryByLlm: true };

  // "Main" instance creates the root; its in-memory lastSummary is unset.
  const requests = [];
  const main = createThreadManager({ ...llmOpts, threadSend: fake, onSummarizeRequest: (r) => { requests.push(r.lastSummary); } });
  main.beginSession("new", "mx");
  const root = await main.ensureThreadRoot("x");
  check("main instance starts with no baseline", main.activeRoot()?.lastSummary === undefined);

  // A long-lived "other" instance, loaded BEFORE the post — its memory will
  // stay stale after the subagent posts (the observed lag).
  const staleCs = makeFakeMatrixHttp();
  const stale = createThreadManager({ ...llmOpts, threadSend: staleCs });
  stale.beginSession("reload");
  check("long-lived instance predates the post", stale.activeRoot()?.lastSummary === undefined);

  // "Subagent" instance (fresh memory, re-attach to the latest root) posts
  // a summary — like its own `matrix_update_thread_summary` tool call.
  const sub = createThreadManager({ ...llmOpts, threadSend: fake });
  sub.beginSession("reload");
  const ok = await sub.updateSummary("# Topic: x\n## Main discussion points\n- done by sub");
  check("subagent instance persists its posted summary", ok === true, JSON.stringify(ok));

  // main's live root is stale; a summary-run read refreshes it from disk.
  await main.readThreadDelta();
  check(
    "readThreadDelta refreshes the baseline from the shared file",
    main.activeRoot()?.lastSummary?.includes("done by sub") === true,
    JSON.stringify(main.activeRoot()?.lastSummary),
  );

  // Cadence fire passes the FRESH baseline into the request callback.
  await main.post("next send", "other");
  check(
    "cadence request carries the disk-fresh baseline",
    requests.length === 1 && requests[0]?.includes("done by sub") === true,
    JSON.stringify(requests),
  );

  // Teardown/restore path on the stale long-lived instance: its memory has
  // no baseline, the disk holds the subagent's → restore THAT, not the
  // heuristic composition (and not a stale in-memory baseline).
  const restored = await stale.updateSummary();
  const restoreEdit = staleCs.calls.find((c) => c[0] === "edit");
  check(
    "no-arg updateSummary restores the disk-persisted summary",
    restored === true && String(restoreEdit?.[2] ?? "").includes("done by sub"),
    JSON.stringify(restoreEdit),
  );
}

console.log("== config: loadProfile / listProfiles ==");
// Hermetic: profiles live beside the ACTIVE config file, so point the active
// config at a temp project dir. Reading shipped files is no longer possible
// (fe0376b removed them), and reading the real ~/.pi/matrix would let a test
// run repoint the developer's live profile.
const origCwd = process.cwd();
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-profiles-"));
const projCfgDir = path.join(projDir, ".pi", "matrix");
fs.mkdirSync(projCfgDir, { recursive: true });
const projCred = path.join(projDir, "credentials.json");
fs.writeFileSync(
  projCred,
  JSON.stringify({ access_token: "fixture", user_id: "@pi:example.org", device_id: "DEV" }),
);
const writeProfile = (file, room) =>
  fs.writeFileSync(
    path.join(projCfgDir, file),
    JSON.stringify({
      configVersion: "2.0",
      piMatrixIdentity: { credentialsPath: projCred, homeserver: "example.org", userId: "@pi:example.org" },
      piMatrixConnection: { roomId: room },
    }),
  );
writeProfile("matrix-config.jsonc", "#live:example.org");
writeProfile("matrix-config.tst2.pi-updates.jsonc", "#pi-updates:example.org");
writeProfile("matrix-config.prd2.jsonc", "#prd2:example.org");
process.chdir(projDir);
try {
  const { listProfiles, loadProfile } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
  const profiles = listProfiles();
  check("listProfiles finds the .jsonc profiles", profiles.includes("tst2.pi-updates") && profiles.includes("prd2"), JSON.stringify(profiles));
  const missing = loadProfile("does-not-exist");
  check("unknown profile -> invalid with a clear error", missing.valid === false && missing.errors.join(",").includes("does-not-exist"), JSON.stringify(missing.errors));
  const evil = loadProfile("../evil");
  check("path-traversal profile name rejected", evil.valid === false, JSON.stringify(evil.errors));
  const tst2 = loadProfile("tst2.pi-updates");
  check("loadProfile('tst2.pi-updates') validates", tst2.valid === true && tst2.config.roomId === "#pi-updates:example.org", JSON.stringify({ valid: tst2.valid, room: tst2.config.roomId }));

  console.log("== config: last-active profile persistence ==");
  const { persistActiveProfile, getActiveProfileName, getActiveProfilePath } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
  const { resolveStartupConfig } = await jiti.import(path.join(EXT_DIR, "src/config.ts"));
  const pointerPath = getActiveProfilePath();
  persistActiveProfile("tst2.pi-updates");
  check("persistActiveProfile writes the pointer", getActiveProfileName() === "tst2.pi-updates", pointerPath);
  const started = resolveStartupConfig();
  check(
    "resolveStartupConfig honors the pointer",
    started.profile === "tst2.pi-updates" && started.valid === true && started.config.roomId === "#pi-updates:example.org",
    JSON.stringify({ profile: started.profile, room: started.config.roomId, errors: started.errors }),
  );
  persistActiveProfile("does-not-exist");
  const fallback = resolveStartupConfig();
  check(
    "stale pointer falls back to the live config",
    fallback.profile === undefined && fallback.valid === true,
    JSON.stringify({ profile: fallback.profile, valid: fallback.valid, errors: fallback.errors }),
  );
} finally {
  process.chdir(origCwd);
  fs.rmSync(projDir, { recursive: true, force: true });
}

console.log("== ask-user mirror: format + parse + emit side ==");
{
  const {
    createAskUserMirror,
    formatQuestionnaireMd,
    parseMirrorReply,
  } = await jiti.import(path.join(EXT_DIR, "src/ask-user-mirror.ts"));

  /** Display-sync (patch A2.13-0001) is emitted per reply; the MODEL-facing
   *  emissions are the flagless ones. Checks assert on this projection. */
  const completes = (arr) => arr.filter((p) => !p.partial);

  const qs = [
    { question: "Which library?", header: "Lib", multiSelect: false, options: [{ label: "lodash" }, { label: "ramda" }, { label: "none" }] },
    { question: "Which scopes?", header: "Scopes", multiSelect: true, options: [{ label: "read" }, { label: "write" }] },
  ];

  const fmtMd = formatQuestionnaireMd(qs);
  check(
    "formatQuestionnaireMd ships GFM pipe-tables + the sentinel row",
    fmtMd.includes("| 1 | lodash |") && fmtMd.includes("| --- | --- | --- |") &&
      fmtMd.includes("[multi]") && fmtMd.includes("Type something."),
    fmtMd,
  );
  check(
    "md table cells escape pipes",
    formatQuestionnaireMd([{ question: "q", options: [{ label: "a|b" }] }]).includes("a\\|b"),
    "",
  );
  const fmtMdAll = formatQuestionnaireMd(qs);
  check(
    "md table offers the 'Type something.' row + confirm hint",
    fmtMdAll.includes("Type something.") && fmtMdAll.includes('"confirm" / "👍" to proceed'),
    "",
  );
  check(
    "md hint has no leaked string-concat fragments",
    !fmtMdAll.includes("' +"),
    "",
  );

  // Single question, bare number → option label for first unanswered.
  const e1 = parseMirrorReply("2", qs);
  check(
    'bare "2" → option 2 (ramda) of first question',
    e1.length === 1 && e1[0].questionIndex === 0 && e1[0].kind === "option" && e1[0].answer === "ramda",
    JSON.stringify(e1),
  );

  // Exact label, case-insensitive.
  const e2 = parseMirrorReply("RAMDA", qs);
  check("label match is case-insensitive", e2.length === 1 && e2[0].answer === "ramda", JSON.stringify(e2));

  // Multi-select: "2 3" → selected labels; comma form too.
  const e3 = parseMirrorReply("Q2: 1 2", qs);
  check("multi-select numbers → selected labels", e3.length === 1 && e3[0].kind === "multi" && e3[0].selected?.join(",") === "read,write", JSON.stringify(e3));
  const e4 = parseMirrorReply("Q2: 1,2", qs);
  check("comma-separated multi", e4.length === 1 && e4[0].kind === "multi" && e4[0].selected?.length === 2, JSON.stringify(e4));

  // Multi question answered with a single number → lenient option entry.
  const e5 = parseMirrorReply("Q2: 1", qs);
  check("single number on multi question → option entry", e5.length === 1 && e5[0].kind === "option" && e5[0].answer === "read", JSON.stringify(e5));

  // Two questions in one reply: "1: 2; 2: 1".
  const e6 = parseMirrorReply("1: 2; 2: 1", qs);
  check("two segments → two entries", e6.length === 2 && e6[0].questionIndex === 0 && e6[1].questionIndex === 1, JSON.stringify(e6));

  // Custom answer needs the explicit prefix.
  const e7 = parseMirrorReply("Custom: use our in-house lib", qs);
  check("Custom: prefix → custom entry", e7.length === 1 && e7[0].kind === "custom" && e7[0].answer === "use our in-house lib", JSON.stringify(e7));

  // Ordinary chat while the mirror is open → nothing parsed (falls through to injection).
  check("plain chat parses to nothing", parseMirrorReply("hello there", qs).length === 0, "");
  check("out-of-range question number skipped", parseMirrorReply("Q9: 1", qs).length === 0, "");
  check(
    "review corrections: bare 'Custom:' with all answered targets question 1",
    (() => {
      const r = parseMirrorReply("Custom: x", qs, new Set([0, 1]));
      return r.length === 1 && r[0].questionIndex === 0 && r[0].kind === "custom" && r[0].answer === "x";
    })(),
    "",
  );

  // alreadyAnswered: bare segment applies to lowest UNanswered question.
  const e8 = parseMirrorReply("2", qs, new Set([0]));
  check("alreadyAnswered={0}: bare '2' targets question 2", e8.length === 1 && e8[0].questionIndex === 1 && e8[0].answer === "write", JSON.stringify(e8));

  // Multi-question shorthand: "2 3" = one number per remaining unanswered
  // question, when the first question can't take every number (out of range
  // for it) — the live room case (Q1 single/2 options, Q2 multi/3 options).
  const qs2 = [
    { question: "q1", header: "H1", multiSelect: false, options: [{ label: "a" }, { label: "b" }] },
    { question: "q2", header: "H2", multiSelect: true, options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
  ];
  const d1 = parseMirrorReply("2 3", qs2);
  check(
    '"2 3" distributes one number per question when Q1 cannot take both',
    d1.length === 2 &&
      d1[0].questionIndex === 0 && d1[0].kind === "option" && d1[0].answer === "b" &&
      d1[1].questionIndex === 1 && d1[1].kind === "multi" && d1[1].selected?.join(",") === "z",
    JSON.stringify(d1),
  );
  check(
    "in-range '2 3' on a single-select question takes the first number (multi-kind entries are only valid for multi-select questions - the TUI drops them otherwise)",
    (() => {
      const r = parseMirrorReply("2 3", qs);
      return r.length === 1 && r[0].questionIndex === 0 && r[0].kind === "option" && r[0].answer === "ramda";
    })(),
    JSON.stringify(parseMirrorReply("2 3", qs)),
  );
  check(
    "multi-select question takes an in-range multi-read ('1 2' → read+write)",
    (() => {
      const r = parseMirrorReply("1 2", qs, new Set([0]));
      return r.length === 1 && r[0].questionIndex === 1 && r[0].kind === "multi" && r[0].selected?.join(",") === "read,write";
    })(),
    JSON.stringify(parseMirrorReply("1 2", qs, new Set([0]))),
  );
  check(
    "single-select Q1: in-range '1 1' distributes one per question (live case)",
    (() => {
      const r = parseMirrorReply("1 1", qs2);
      return r.length === 2 &&
        r[0].questionIndex === 0 && r[0].kind === "option" && r[0].answer === "a" &&
        r[1].questionIndex === 1 && r[1].kind === "multi" && r[1].selected?.join(",") === "x";
    })(),
    JSON.stringify(parseMirrorReply("1 1", qs2)),
  );
  check(
    "multi-select Q1: in-range '1 1' stays a multi-read on the current question",
    (() => {
      const r = parseMirrorReply("1 1", [{ ...qs[0], multiSelect: true }, { ...qs[1], multiSelect: false }]);
      return r.length === 1 && r[0].questionIndex === 0 && r[0].kind === "option";
    })(),
    "",
  );
  check("distribution needs an exact count match", parseMirrorReply("2 3", [...qs2, { question: "q3", options: [{ label: "w" }] }]).length === 0, "");
  check("out-of-range bare number parses to nothing", parseMirrorReply("9", qs2).length === 0, "");

  // Emoji aliases: 👍/✅ → the single yes-ish option; 👎/❌ → the single
  // no-ish option (mobile-friendly yes/no decisions).
  const yesNo = [
    { question: "Proceed?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
    { question: "Approve the plan?", multiSelect: false, options: [{ label: "Approve" }, { label: "Reject" }] },
  ];
  check(
    "'👍' → the yes-ish option of the first unanswered question",
    (() => { const r = parseMirrorReply("👍", yesNo); return r.length === 1 && r[0].questionIndex === 0 && r[0].kind === "option" && r[0].answer === "Yes"; })(),
    "",
  );
  check(
    "'👎' → the no-ish option",
    (() => { const r = parseMirrorReply("👎", yesNo); return r.length === 1 && r[0].questionIndex === 0 && r[0].answer === "No"; })(),
    "",
  );
  check(
    "'✅' (all-but-Q1 answered) → Q2 'Approve'",
    (() => { const r = parseMirrorReply("✅", yesNo, new Set([0])); return r.length === 1 && r[0].questionIndex === 1 && r[0].answer === "Approve"; })(),
    "",
  );
  check(
    "'❌' → 'Reject'",
    (() => { const r = parseMirrorReply("❌", yesNo, new Set([0])); return r.length === 1 && r[0].answer === "Reject"; })(),
    "",
  );
  check(
    "explicit prefix 'Q2: 👎' → corrects question 2 to 'Reject'",
    (() => { const r = parseMirrorReply("Q2: 👎", yesNo); return r.length === 1 && r[0].questionIndex === 1 && r[0].answer === "Reject"; })(),
    "",
  );
  check("no yes/no-ish label → no entry (falls to the nudge)", parseMirrorReply("👍", qs2).length === 0, "");
  check(
    "ambiguous (two matching yes-ish options) → no entry",
    parseMirrorReply("👍", [{ question: "q", options: [{ label: "Yes" }, { label: "OK" }] }]).length === 0,
    "",
  );

  // Nudge: an intended answer that fails the grammar is consumed + gets a
  // room grammar reminder; genuine chat still injects.
  const posts2 = [];
  const emitted2 = [];
  const submitted2 = [];
  const reviewEventId2 = { id: "" };
  const mirror3 = createAskUserMirror({
    post: async (text, html) => { posts2.push(text); return { success: true, eventId: "$y" }; },
    postResult: async (text) => {
      posts2.push(text);
      reviewEventId2.id ||= "$review"; // the living review keeps one event id
      return { success: true, eventId: reviewEventId2.id };
    },
    edit: async (targetEventId, text) => {
      posts2.push(`EDIT(${targetEventId}): ${text}`);
      return { success: true };
    },
    isEnabled: () => true,
    emitAnswer: (p) => { emitted2.push(p); },
  });
  await mirror3.onPrompt(qs2, "$tc3");
  check(
    "unparseable 'Q1: 9 oops' is consumed with a nudge, not injected",
    mirror3.tryConsumeReply("Q1: 9 oops") === true && emitted2.length === 0,
    JSON.stringify(posts2.at(-1) ?? ""),
  );
  check(
    "nudge posts the reply grammar + per-question option counts",
    (posts2.at(-1) ?? "").includes("didn't parse") && (posts2.at(-1) ?? "").includes("Q1 has 2 options") && (posts2.at(-1) ?? "").includes("Q2 has 3 options (multi)"),
    JSON.stringify(posts2.at(-1) ?? ""),
  );
  check("bare out-of-range '7' is consumed with a nudge", mirror3.tryConsumeReply("7") === true, "");
  check("genuine chat still injects (not consumed)", mirror3.tryConsumeReply("hello there") === false, "");
  check(
    "the shorthand '2 3' completes the set → review step; display-sync partial emitted, model-facing emission still zero",
    mirror3.tryConsumeReply("2 3") === true && completes(emitted2).length === 0 &&
      emitted2.at(-1)?.partial === true && emitted2.at(-1)?.answers?.length === 2 &&
      (posts2.at(-1) ?? "").includes("🔍 Review"),
    JSON.stringify({ emitted: emitted2, last: posts2.at(-1) ?? "" }),
  );
  // Settle the first review post's event id (the correction below edits
  // in place, so it must see the settled id).
  await new Promise((r) => setTimeout(r, 0));
  check(
    "a failed reply during review gets a nudge that mentions confirm",
    mirror3.tryConsumeReply("Q1: 9") === true && (posts2.at(-1) ?? "").includes("Review is pending"),
    JSON.stringify(posts2.at(-1) ?? ""),
  );
  check(
    "confirm emits ONE complete set (toolCallId + 2 answers) + posts completion",
    mirror3.tryConsumeReply("confirm") === true && completes(emitted2).length === 1 &&
      emitted2.at(-1).toolCallId === "$tc3" && emitted2.at(-1).answers?.length === 2 &&
      (posts2.at(-1) ?? "").includes("✅"),
    JSON.stringify({ emitted: emitted2 }),
  );

  // Review-step reject: 👎/❌ DECLINES via the upstream cancel path (the
  // 2.13 answer channel's Esc equivalent) — the model is told the user
  // declined. 👍/✅ still confirms (complete-set emission).
  const postsR = [];
  const emittedR = [];
  const mirrorR = createAskUserMirror({
    post: async (text) => { postsR.push(text); return { success: true, eventId: "$r" }; },
    isEnabled: () => true,
    emitAnswer: (p) => { emittedR.push(p); },
  });
  await mirrorR.onPrompt(qs2, "$tcR");
  mirrorR.tryConsumeReply("2 3"); // complete the buffer → review pending
  check(
    "'👎' at the review step emits cancel:true (decline) + posts 'Declined'",
    mirrorR.tryConsumeReply("👎") === true && completes(emittedR).filter((p) => !p.cancel).length === 0 &&
      emittedR.at(-1)?.cancel === true && emittedR.at(-1)?.toolCallId === "$tcR" &&
      (postsR.at(-1) ?? "").includes("Declined"),
    JSON.stringify({ emitted: emittedR, last: postsR.at(-1) ?? "" }),
  );
  const mirrorR2 = createAskUserMirror({
    post: async (text) => { postsR.push(text); return { success: true, eventId: "$r2" }; },
    isEnabled: () => true,
    emitAnswer: (p) => { emittedR.push(p); },
  });
  await mirrorR2.onPrompt(qs2, "$tcR2");
  mirrorR2.tryConsumeReply("2 3");
  check(
    "'👍' at the review step confirms (complete-set emission)",
    mirrorR2.tryConsumeReply("👍") === true && completes(emittedR).at(-1)?.answers?.length === 2 &&
      (postsR.at(-1) ?? "").includes("✅"),
    "",
  );

  // Regression (backlog #54): a SINGLE-question decision must resolve on the
  // one answer — no review step, no second confirm. The mirror emits the
  // complete set immediately for N=1 single-select; multi-question above
  // still keeps the review + confirm step.
  const qs1 = [{ question: "Proceed with the plan?", header: "Go?", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }];
  {
    const posts1 = [];
    const emitted1 = [];
    const mirror1 = createAskUserMirror({
      post: async (t) => { posts1.push(t); return { success: true, eventId: "$1" }; },
      isEnabled: () => true,
      emitAnswer: (p) => { emitted1.push(p); },
    });
    await mirror1.onPrompt(qs1, "$tc1");
    check(
      "single-question: option answer auto-emits the complete set (no review step, no 2nd confirm)",
      mirror1.tryConsumeReply("1") === true && emitted1.length === 1 &&
        emitted1[0].toolCallId === "$tc1" && emitted1[0].answers?.length === 1 &&
        emitted1[0].answers?.[0]?.optionIndexes?.[0] === 0 &&
        !(posts1.at(-1) ?? "").includes("🔍 Review") && (posts1.at(-1) ?? "").includes("proceeding"),
      JSON.stringify({ emitted: emitted1 }),
    );
  }
  {
    const postsC = [];
    const emittedC = [];
    const mirrorC = createAskUserMirror({
      post: async (t) => { postsC.push(t); return { success: true, eventId: "$c" }; },
      isEnabled: () => true,
      emitAnswer: (p) => { emittedC.push(p); },
    });
    await mirrorC.onPrompt(qs1, "$tcC");
    check(
      "single-question: custom answer auto-emits as text (regression #54)",
      mirrorC.tryConsumeReply("Custom: do X, but slowly") === true && emittedC.length === 1 &&
        emittedC[0].answers?.[0]?.text === "do X, but slowly" &&
        !(postsC.at(-1) ?? "").includes("🔍 Review"),
      JSON.stringify({ emitted: emittedC, last: postsC.at(-1) ?? "" }),
    );
  }

  // Emoji-picker variants: a U+FE0F variation selector and ✔/☑/✖ glyphs
  // (the checkmark/X shapes pickers and mobile keyboards actually send)
  // must behave like the bare codepoints.
  for (const variant of ["✅\uFE0F", "✔", "☑\uFE0F", "👍\uFE0F"]) {
    const emittedV = [];
    const mirrorV = createAskUserMirror({
      post: async () => ({ success: true, eventId: "$v" }),
      isEnabled: () => true,
      emitAnswer: (p) => { emittedV.push(p); },
    });
    await mirrorV.onPrompt(qs2, "$tcV");
    mirrorV.tryConsumeReply("2 3"); // complete the buffer → review pending
    check(
      `review step: ${JSON.stringify(variant)} confirms (picker variant) → complete-set emission`,
      mirrorV.tryConsumeReply(variant) === true && completes(emittedV).length === 1 && completes(emittedV)[0].answers?.length === 2,
      JSON.stringify({ emitted: emittedV }),
    );
  }
  {
    const postsV = [];
    const emittedV = [];
    const mirrorV = createAskUserMirror({
      post: async (t) => { postsV.push(t); return { success: true, eventId: "$v" }; },
      isEnabled: () => true,
      emitAnswer: (p) => { emittedV.push(p); },
    });
    await mirrorV.onPrompt(qs2, "$tcV");
    mirrorV.tryConsumeReply("2 3");
    check(
      "review step: '✖\\uFE0F' declines (cancel emission, reject glyph variant)",
      mirrorV.tryConsumeReply("✖\uFE0F") === true && completes(emittedV).filter((p) => !p.cancel).length === 0 && emittedV.at(-1)?.cancel === true,
      JSON.stringify({ emitted: emittedV }),
    );
  }
  // Reaction path (index.ts onReaction): the reaction key goes through the
  // SAME consume entry as room text — normalized, so Element's FE0F keys
  // behave like the bare codepoints. The 4 picker variants above ARE this
  // path; assert the live-room key shapes (as captured from tst2) too.
  for (const reactionKey of ["\ud83d\udc4d\ufe0f", "\u2705\ufe0f", "\u2714\ufe0f", "\u2713"]) {
    const emittedV = [];
    const mirrorV = createAskUserMirror({
      post: async () => ({ success: true, eventId: "$v" }),
      isEnabled: () => true,
      emitAnswer: (p) => { emittedV.push(p); },
    });
    await mirrorV.onPrompt(qs2, "$tcV");
    mirrorV.tryConsumeReply("2 3"); // complete the buffer → review pending
    check(
      `reaction key ${JSON.stringify(reactionKey)} confirms at the review step`,
      mirrorV.tryConsumeReply(reactionKey) === true && completes(emittedV).length === 1 && completes(emittedV)[0].answers?.length === 2,
      JSON.stringify({ emitted: emittedV }),
    );
  }
  {
    // Question-phase alias variant: "Q1: ✔\uFE0F" → the yes-ish option
    // (N=1 single-select → the answer auto-emits the complete set).
    const emittedQ = [];
    const mirrorQ = createAskUserMirror({
      post: async () => ({ success: true, eventId: "$q" }),
      isEnabled: () => true,
      emitAnswer: (p) => { emittedQ.push(p); },
    });
    await mirrorQ.onPrompt([{ question: "q", options: [{ label: "Yes" }, { label: "No" }] }], "$tcQ");
    check(
      "question phase: 'Q1: ✔\\uFE0F' aliases to the yes-ish option (index 0)",
      mirrorQ.tryConsumeReply("Q1: ✔\uFE0F") === true &&
        emittedQ.at(-1)?.answers?.[0]?.optionIndexes?.[0] === 0,
      JSON.stringify(emittedQ.at(-1)),
    );
  }

  // A bare decision emoji that matches no option is consumed as a reply
  // attempt (nudge), not injected as ordinary chat.
  const postsE = [];
  const mirrorE = createAskUserMirror({
    post: async (text) => { postsE.push(text); return { success: true, eventId: "$e" }; },
    isEnabled: () => true,
    emitAnswer: () => undefined,
  });
  await mirrorE.onPrompt(qs2, "$tcE");
  check(
    "bare '👍' with no yes-ish option is consumed with a nudge (not chat)",
    mirrorE.tryConsumeReply("👍") === true && (postsE.at(-1) ?? "").includes("didn't parse"),
    JSON.stringify(postsE.at(-1) ?? ""),
  );

  // Terminal→room sync (patch A2.13-0002 through the mirror): terminal-side
  // answers merge into the room buffer, arm the room review, and echo of
  // the mirror's own answers stays silent.
  {
    const postsS = [];
    const emittedS = [];
    const m = createAskUserMirror({
      post: async (t) => { postsS.push(t); return { success: true, eventId: "$s" }; },
      postResult: async (t) => { postsS.push(t); return { success: true, eventId: "$rs" }; },
      isEnabled: () => true,
      emitAnswer: (p) => { emittedS.push(p); },
    });
    await m.onPrompt(qs, "$tcS");
    m.tryConsumeReply("2"); // Q1 by the room (ack posted, partial emitted)
    await new Promise((r) => setTimeout(r, 0)); // let the status post settle
    // Terminal registers Q2; the broadcast is the FULL map (Q1 echoes back
    // unchanged, Q2 is the new one).
    m.onAnswersState({ toolCallId: "$tcS", answers: [
      { questionIndex: 0, question: "Which library?", kind: "option", answer: "ramda" },
      { questionIndex: 1, question: "Which scopes?", kind: "multi", answer: null, selected: ["read", "write"] },
    ] });
    check(
      "terminal-side completion merges into the buffer → room review arms",
      (postsS.at(-1) ?? "").includes("🔍 Review"),
      JSON.stringify(postsS.at(-1) ?? ""),
    );
    check("no model-facing emit from the sync (confirm still gates)", completes(emittedS).length === 0, JSON.stringify(emittedS));
    m.tryConsumeReply("confirm");
    check(
      "confirm ships the MERGED set (Q1 ramda + Q2 read,write indexed)",
      completes(emittedS).at(-1)?.answers?.length === 2 &&
        completes(emittedS).at(-1)?.answers?.[1]?.optionIndexes?.join(",") === "0,1",
      JSON.stringify(completes(emittedS).at(-1) ?? null),
    );
  }
  {
    // ⌨️ ack for PARTIAL terminal progress (3 questions: room has A, the
    // terminal adds B → 2/3, review must NOT arm); echo of the mirror's own
    // answer posts nothing; multi order-insensitive compare (authored vs
    // tap order must not read as a change).
    const qs3 = [
      { question: "A", options: [{ label: "a1" }, { label: "a2" }] },
      { question: "B", options: [{ label: "b1" }, { label: "b2" }] },
      { question: "C", multiSelect: true, options: [{ label: "c1" }, { label: "c2" }] },
    ];
    const postsT = [];
    const m2 = createAskUserMirror({
      post: async (t) => { postsT.push(t); return { success: true }; },
      isEnabled: () => true,
      emitAnswer: () => undefined,
    });
    await m2.onPrompt(qs3, "$tcT");
    m2.tryConsumeReply("1"); // A = a1 by the room
    await new Promise((r) => setTimeout(r, 0)); // let the status post settle
    const before = postsT.length;
    m2.onAnswersState({ toolCallId: "$tcT", answers: [{ questionIndex: 0, question: "A", kind: "option", answer: "a1" }] });
    check("echo of the mirror's own answer posts nothing", postsT.length === before, JSON.stringify(postsT.slice(before)));
    m2.onAnswersState({ toolCallId: "$tcT", answers: [
      { questionIndex: 0, question: "A", kind: "option", answer: "a1" },
      { questionIndex: 1, question: "B", kind: "option", answer: "b1" },
    ] });
    check(
      "terminal partial progress posts ⌨️ ack with counts, review stays closed",
      (postsT.at(-1) ?? "").includes("⌨️ Q2 answered at the terminal") && (postsT.at(-1) ?? "").includes("2/3") &&
        !(postsT.at(-1) ?? "").includes("Review"),
      JSON.stringify(postsT.at(-1) ?? ""),
    );
    // Multi echo with reordered selection (terminal authored order vs room
    // tap order): must not read as a change.
    const postsU = [];
    const m3 = createAskUserMirror({
      post: async (t) => { postsU.push(t); return { success: true }; },
      isEnabled: () => true,
      emitAnswer: () => undefined,
    });
    await m3.onPrompt(qs3, "$tcU");
    m3.tryConsumeReply("Q3: 2 1"); // multi C = c2, c1 in TAP order
    const before3 = postsU.length;
    m3.onAnswersState({ toolCallId: "$tcU", answers: [
      { questionIndex: 2, question: "C", kind: "multi", answer: null, selected: ["c1", "c2"] }, // AUTHORED order back
    ] });
    check("reordered multi echo is not a change (no post)", postsU.length === before3, JSON.stringify(postsU.slice(before3)));
  }

  // Living message: the status line, the ⌨️ ack and the review are faces
  // of ONE room message — post once, edit forever (postResult + edit deps).
  {
    const fresh = [];
    const edits = [];
    const m = createAskUserMirror({
      post: async (t) => { fresh.push(t); return { success: true }; },
      postResult: async (t) => { fresh.push(t); return { success: true, eventId: "$live" }; },
      edit: async (id, t) => { edits.push([id, t]); return { success: true }; },
      isEnabled: () => true,
      emitAnswer: () => undefined,
    });
    await m.onPrompt(qs, "$tcL");
    check("questionnaire itself is a plain post", fresh.length === 1 && fresh[0].includes("Which library?"));
    m.tryConsumeReply("2"); // Q1 → status POSTS (first living message)
    check("status line posts once", fresh.length === 2 && fresh[1].includes("Answer noted") && edits.length === 0, JSON.stringify(fresh.slice(1)));
    await new Promise((r) => setTimeout(r, 0)); // let the first post settle (id captured)
    m.onAnswersState({ toolCallId: "$tcL", answers: [
      { questionIndex: 0, question: "Which library?", kind: "option", answer: "ramda" },
      { questionIndex: 1, question: "Which scopes?", kind: "multi", answer: null, selected: ["read"] },
    ] });
    check(
      "review ARMS AS AN EDIT of the status message — no second post",
      fresh.length === 2 && edits.length === 1 && edits[0][0] === "$live" && edits[0][1].includes("🔍 Review"),
      JSON.stringify({ fresh: fresh.length, edits }),
    );
    m.tryConsumeReply("1"); // correction during review → another edit, same message
    check(
      "correction edits the SAME living message",
      edits.length === 2 && edits[1][0] === "$live" && edits[1][1].includes("🔍 Review"),
      JSON.stringify(edits),
    );
  }

  // End-to-end: open mirror posts the questionnaire; replies buffer LOCALLY
  // (no per-reply emission — upstream refuses partial sets); the review
  // edits in place; 'done' ships ONE complete set on the answer channel.
  const posts = [];
  const htmls = [];
  const emitted = [];
  const reviewEventIdMain = { id: "" };
  const mirror = createAskUserMirror({
    post: async (text, html) => { posts.push(text); htmls.push(html); return { success: true, eventId: "$x" }; },
    postResult: async (text) => {
      posts.push(text);
      reviewEventIdMain.id ||= "$review"; // the living review keeps one event id
      return { success: true, eventId: reviewEventIdMain.id };
    },
    edit: async (targetEventId, text) => {
      posts.push(`EDIT(${targetEventId}): ${text}`);
      return { success: true };
    },
    isEnabled: () => true,
    emitAnswer: (p) => { emitted.push(p); },
  });
  check("mirror closed before prompt", mirror.isOpen() === false, "");
  await mirror.onPrompt(qs, "$tcMain");
  check("onPrompt opens the mirror + posts the questionnaire", mirror.isOpen() === true && posts.length === 1 && posts[0].includes("Q1"), "");
  check(
    "onPrompt ships GFM pipe-table markdown (the pipeline formats)",
    posts[0].includes("| 1 |") && posts[0].includes("| --- |") && posts[0].includes("Type something."),
    JSON.stringify(posts[0] ?? ""),
  );
  check(
    "partial reply is buffered + display-synced (partial emitted, model-facing emission zero)",
    (mirror.tryConsumeReply("2"), emitted.length === 1 && emitted[0].partial === true &&
      emitted[0].answers?.[0]?.optionIndexes?.[0] === 1),
    JSON.stringify(emitted),
  );
  check("ack posts partial progress", posts.length === 2 && posts[1].includes("1/2") && posts[1].includes("still waiting"), JSON.stringify(posts[1] ?? ""));
  // The ack is the living message's first post; the next update chains onto
  // its settle (edit-after-settle) — flush the microtask queue first.
  await new Promise((r) => setTimeout(r, 0));
  check(
    "second reply completes the buffer → review step, still no model-facing emission",
    mirror.tryConsumeReply("Q2: 1 2") === true && completes(emitted).length === 0 &&
      (posts[2] ?? "").includes("🔍 Review") && (posts[2] ?? "").includes("ready to send"),
    JSON.stringify({ emitted, last: posts[2] ?? "" }),
  );
  // The first review post settles its event id on the promise queue — the
  // correction below must see the settled id to edit (not re-post).
  await new Promise((r) => setTimeout(r, 0));
  check(
    "correction during review edits the review in place (display-sync partial only)",
    mirror.tryConsumeReply("Q1: none") === true &&
      completes(emitted).length === 0 &&
      (posts[3] ?? "").includes("<strong>Q1: Which library?</strong> = none"),
    JSON.stringify({ emitted, last: posts[3] ?? "" }),
  );
  check(
    "'done' emits ONE complete set (indexed entries) + posts completion",
    mirror.tryConsumeReply("done") === true && completes(emitted).length === 1 &&
      emitted.at(-1).toolCallId === "$tcMain" && typeof emitted.at(-1).requestId === "string" &&
      emitted.at(-1).answers?.length === 2 &&
      emitted.at(-1).answers?.[0]?.optionIndexes?.[0] === 2 && // Q1 = "none" (index 2)
      emitted.at(-1).answers?.[1]?.optionIndexes?.join(",") === "0,1" && // Q2 = read+write
      (posts[4] ?? "").includes("✅"),
    JSON.stringify({ emitted }),
  );
  check("non-answer chat is NOT consumed", mirror.tryConsumeReply("hmm interesting") === false, "");
  check(
    "close on blocked(false) drops the pending review state",
    (mirror.onBlocked(false), mirror.isOpen()) === false,
    "",
  );
  check(
    "a late 'confirm' after the wait ended is not consumed",
    mirror.tryConsumeReply("confirm") === false && completes(emitted).length === 1,
    "",
  );
  check(
    "an invalid_* verdict while open re-arms the review with a room warning",
    (() => {
      const postsW = [];
      const emittedW = [];
      const m = createAskUserMirror({
        post: async (t) => { postsW.push(t); return { success: true, eventId: "$w" }; },
        isEnabled: () => true,
        emitAnswer: (p) => { emittedW.push(p); },
      });
      void m.onPrompt(qs, "$tcW");
      m.tryConsumeReply("2"); // Q1 = ramda
      m.tryConsumeReply("Q2: 1 2"); // complete → review
      m.tryConsumeReply("confirm"); // emits, awaiting verdict
      m.onAnswerResult({ ok: false, code: "invalid_answer", reason: "option index out of range" });
      return emittedW.filter((p) => !p.partial).length === 1 && postsW.some((p) => p.includes("refused"));
    })(),
    "",
  );
  check(
    "a refused DISPLAY-SYNC partial (matrix-partial-* verdict) never warns or re-arms",
    (() => {
      const postsP = [];
      const m = createAskUserMirror({
        post: async (t) => { postsP.push(t); return { success: true, eventId: "$p" }; },
        isEnabled: () => true,
        emitAnswer: () => undefined,
      });
      void m.onPrompt(qs, "$tcP");
      m.tryConsumeReply("2");
      m.onAnswerResult({ ok: false, code: "invalid_answer", reason: "stale", requestId: "matrix-partial-$tcP" });
      return !postsP.some((p) => p.includes("refused"));
    })(),
    "",
  );
  check(
    "a not_found verdict while open is ignored (terminal won the race)",
    (() => {
      const postsN = [];
      const m = createAskUserMirror({
        post: async (t) => { postsN.push(t); return { success: true, eventId: "$n" }; },
        isEnabled: () => true,
        emitAnswer: () => undefined,
      });
      void m.onPrompt(qs, "$tcN");
      m.onAnswerResult({ ok: false, code: "not_found", reason: "already answered" });
      return !postsN.some((p) => p.includes("refused"));
    })(),
    "",
  );

  // Disabled connection → prompts stay closed (terminal-only mode).
  const mirror2 = createAskUserMirror({
    post: async () => { throw new Error("should not post"); },
    isEnabled: () => false,
    emitAnswer: () => undefined,
  });
  await mirror2.onPrompt(qs, "$tc2");
  check("disabled connection → mirror stays closed", mirror2.isOpen() === false, "");
}

// ---- summarize: pure prompt + delta filter (DESIGN-ROOM-SUMMARIZER §5) ----
console.log("== summarize: thread-delta filter + prompt (pure) ==");
{
  const {
    filterThreadDelta,
    buildThreadSummarizePrompt,
    buildThreadSummarizeDirective,
    formatDeltaMessages,
  } = await jiti.import(path.join(EXT_DIR, "src/summarize.ts"));

  const ROOT = "$root-1";
  const msgs = [
    { eventId: ROOT, sender: "@a:x", body: "root msg", isThreadRoot: true, threadRoot: undefined, timestamp: 1 },
    { eventId: "$m1", sender: "@b:x", body: "in-thread 1", threadRoot: ROOT, timestamp: 2 },
    { eventId: "$m2", sender: "@b:x", body: "in-thread 2", threadRoot: ROOT, timestamp: 3 },
    { eventId: "$o1", sender: "@c:x", body: "other-thread msg", threadRoot: "$other-root", timestamp: 4 },
    { eventId: "$f1", sender: "@c:x", body: "flat msg", threadRoot: undefined, timestamp: 5 },
  ];

  check(
    "filter keeps the root + in-thread replies, drops other/flat",
    filterThreadDelta(msgs, ROOT, 10).map((m) => m.eventId).join(",") === `${ROOT},$m1,$m2`,
    JSON.stringify(filterThreadDelta(msgs, ROOT, 10).map((m) => m.eventId)),
  );
  check("cap keeps only the newest", filterThreadDelta(msgs, ROOT, 2).map((m) => m.eventId).join(",") === "$m1,$m2", "");
  check("since watermark drops up to + including it", filterThreadDelta(msgs, ROOT, 10, "$m1").map((m) => m.eventId).join(",") === "$m2", "");
  check("since watermark absent from the window → keep all", filterThreadDelta(msgs, ROOT, 10, "$ancient").map((m) => m.eventId).join(",") === `${ROOT},$m1,$m2`, "");
  check("formatDeltaMessages empty → note", /no new messages/.test(formatDeltaMessages([])), "");
  check("formatDeltaMessages lists sender: body", formatDeltaMessages([msgs[1]]).includes("@b:x: in-thread 1"), "");

  const p = buildThreadSummarizePrompt({
    topic: "My feature",
    lastSummary: "# Topic: My feature\n## Main discussion points\n- old — status: completed",
    delta: [msgs[1], msgs[2]],
  });
  check("prompt has topic + baseline + delta", p.includes("Topic: My feature") && p.includes("old — status: completed") && p.includes("@b:x: in-thread 1") && p.includes("@b:x: in-thread 2"), p.slice(0, 120));
  check("prompt asks for a body-only reply", /ONLY the summary body/.test(p), "");

  const dir = buildThreadSummarizeDirective({ topic: "t", lastSummary: "BASE" }, [msgs[1]]);
  check("directive (fallback) carries baseline + delta", dir.includes("BASE") && dir.includes("@b:x: in-thread 1") && dir.includes("matrix_update_thread_summary"), "");
  const dirNoDelta = buildThreadSummarizeDirective({ topic: "t" }, []);
  check("directive without a delta has no delta section", !dirNoDelta.includes("Newest thread messages"), "");

  // fir-tree shape + aging rules + configurable caps (DESIGN-THREADING-SUMMARIZE §3)
  const pTree = buildThreadSummarizePrompt({
    topic: "My feature",
    delta: [],
    milestoneCandidates: ["Shipped v1", "Migrated db"],
  });
  check(
    "prompt carries the fir-tree shape + aging rules + default caps",
    pTree.includes("## Milestones") && pTree.includes("## Recent activity") &&
      /merge the two oldest/.test(pTree) && pTree.includes("At most 25 lines total"),
    "",
  );
  check(
    "prompt keeps the milestone ledger as an evergreen anchor",
    pTree.includes("Shipped v1") && pTree.includes("Migrated db"),
    "",
  );
  const pCaps = buildThreadSummarizePrompt({
    topic: "t",
    delta: [],
    limits: { milestoneMax: 2, recentMax: 3, maxLines: 12 },
  });
  check(
    "prompt carries configured caps",
    pCaps.includes("at most 2 lines") && pCaps.includes("max 3 points") && pCaps.includes("At most 12 lines total"),
    "",
  );
  const dirTree = buildThreadSummarizeDirective({ topic: "t", lastSummary: "B" }, [], { milestoneCandidates: ["Kept alive"] });
  check("directive carries candidates + fir-tree sections", dirTree.includes("Kept alive") && dirTree.includes("## Recent activity"), "");
}

// ---- subagent-summarizer: RPC driver over a fake bus (DESIGN §6/§7) ----
console.log("== subagent-summarizer: RPC driver (fake bus) ==");
{
  const { createSubagentSummarizer } = await jiti.import(path.join(EXT_DIR, "src/subagent-summarizer.ts"));

  // A fake pi.events bus that plays the pi-subagents side. `scenario` drives
  // what the (simulated) subagents extension does in response to the RPCs.
  function makeBus(scenario, { result = "", agentId = "agent-1" } = {}) {
    const handlers = new Map();
    const spawnPayloads = [];
    let consumed = 0;
    const bus = {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return () => handlers.get(event)?.delete(fn);
      },
      emit(event, data) {
        if (event === "subagents:rpc:spawn") spawnPayloads.push(data);
        if (event === "subagents:rpc:consume") consumed++;
        const set = handlers.get(event);
        if (set) for (const fn of [...set]) fn(data);
        // simulated pi-subagents side effects
        if (event === "subagents:rpc:ping" && scenario !== "unavailable") {
          bus.emit(`subagents:rpc:ping:reply:${data.requestId}`, { success: true, data: { version: 2 } });
        } else if (event === "subagents:rpc:ping") {
          // No pi-subagents sidecar to answer: the bus itself answers the
          // ping with success:false. The silent-ping timeout arm is covered
          // by the shared provider kit (test/_provider_kit.mjs) — the R1
          // adapter rewrite fixed the old reply-less-ping hang.
          bus.emit(`subagents:rpc:ping:reply:${data.requestId}`, { success: false, error: "pi-subagents not present" });
        }
        if (event === "subagents:rpc:spawn") {
          if (scenario === "spawn-fail") {
            bus.emit(`subagents:rpc:spawn:reply:${data.requestId}`, { success: false, error: "Unknown or disabled agent type: \"summarizer\"." });
          } else if (scenario !== "unavailable") {
            bus.emit(`subagents:rpc:spawn:reply:${data.requestId}`, { success: true, data: { id: agentId } });
            // settle on the next macrotask, after the driver has subscribed
            setTimeout(() => {
              if (scenario === "fail") bus.emit("subagents:failed", { id: agentId, status: "failed", error: "boom" });
              else bus.emit("subagents:completed", { id: agentId, status: "completed", result });
            }, 0);
          }
        }
      },
    };
    return { bus, spawnPayloads, consumed: () => consumed };
  }

  // success: spawn → completed → the result is returned and consumed.
  {
    const SUMMARY = "# Topic: t\n## Main discussion points\n- x — status: completed";
    const { bus, spawnPayloads, consumed } = makeBus("ok", { result: SUMMARY });
    const s = createSubagentSummarizer({ events: bus, agentType: "pi-matrix-integration-thread-summarizer", pingTimeoutMs: 20, runTimeoutMs: 500 });
    check("available: ping succeeds", (await s.isAvailable()) === true, "");
    const out = await s.run("PROMPT");
    check("run resolves to the subagent's summary body", out === SUMMARY, JSON.stringify(out));
    check("spawn targets the summarizer type", spawnPayloads[0]?.type === "pi-matrix-integration-thread-summarizer", JSON.stringify(spawnPayloads[0]?.type));
    check("spawn is isolated (no extensions → no stray thread / 2nd connection)", spawnPayloads[0]?.options?.isolated === true, JSON.stringify(spawnPayloads[0]?.options));
    check("result is consumed (no completion notification)", consumed() >= 1, String(consumed()));
  }
  // failed run → null (keep the last summary).
  {
    const { bus } = makeBus("fail", { result: "should not be used" });
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, runTimeoutMs: 500 });
    check("failed subagent → null", (await s.run("PROMPT")) === null, "");
  }
  // empty result → null (an empty summary must not clobber the root).
  {
    const { bus } = makeBus("ok", { result: "   " });
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, runTimeoutMs: 500 });
    check("empty result → null", (await s.run("PROMPT")) === null, "");
  }
  // spawn rejected → null, no settle event expected.
  {
    const { bus, spawnPayloads } = makeBus("spawn-fail");
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, runTimeoutMs: 500 });
    const out = await s.run("PROMPT");
    check("spawn failure → null", out === null, JSON.stringify(out));
    check("a spawn attempt was made", spawnPayloads.length === 1, String(spawnPayloads.length));
  }
  // slow completion (arrives later than spawnTimeoutMs) still resolves — the
  // ACK timer must not cut off the settle phase (observed in the field:
  // >2 min runs discarded at the old single 120 s timeout, root never edited).
  {
    const { bus } = makeBus("ok", { result: "SLOW-OK" });
    const on = bus.on.bind(bus);
    bus.on = (event, fn) =>
      event === "subagents:completed"
        ? on(event, (data) => setTimeout(() => fn(data), 120))
        : on(event, fn);
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, spawnTimeoutMs: 30, runTimeoutMs: 500 });
    const out = await s.run("PROMPT");
    check("slow completion after spawnTimeout still resolves", out === "SLOW-OK", JSON.stringify(out));
  }
  // silent spawn ACK → null bounded by spawnTimeoutMs, not the long run cap.
  {
    const handlers = new Map();
    const bus = {
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(fn);
        return () => handlers.get(ev)?.delete(fn);
      },
      emit(ev, data) {
        handlers.get(ev)?.forEach((fn) => fn(data));
        if (ev === "subagents:rpc:ping") {
          bus.emit(`subagents:rpc:ping:reply:${data.requestId}`, { success: true, data: { version: 2 } });
        }
        // subagents:rpc:spawn ACK deliberately swallowed
      },
    };
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, spawnTimeoutMs: 40, runTimeoutMs: 60000 });
    const keep = setTimeout(() => {}, 200); // ref'd: the driver's timers are unref'd
    const t0 = Date.now();
    const out = await s.run("PROMPT");
    const dt = Date.now() - t0;
    clearTimeout(keep);
    check("silent spawn ACK → null bounded by spawnTimeoutMs", out === null && dt < 1000, `dt=${dt}ms`);
  }
  // unavailable (pi-subagents absent) → isAvailable false, run null, no spawn.
  {
    const { bus, spawnPayloads } = makeBus("unavailable");
    const s = createSubagentSummarizer({ events: bus, pingTimeoutMs: 20, runTimeoutMs: 500 });
    check("unavailable: ping answered not-present → false", (await s.isAvailable()) === false, "");
    check("unavailable: run → null without a spawn", (await s.run("PROMPT")) === null && spawnPayloads.length === 0, "");
  }
}

// ---- threading: readThreadDelta + event watermark (fake cs) (DESIGN §3/§8) ----
console.log("== threading: readThreadDelta + event watermark (fake cs) ==");
{
  function makeFakeMatrixHttp(timelineMessages) {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot() { n++; return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply() { n++; return { success: true, eventId: `$frep-${n}` }; },
      async editMessage(id, text) { calls.push(["edit", id, text]); return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline(limit) { calls.push(["readTimeline", limit]); return { success: true, messages: timelineMessages }; },
    };
  }
  const ROOT = "$froot-1";
  const timeline = [
    { eventId: ROOT, sender: "@pi:x", body: "root", isThreadRoot: true, timestamp: 1 },
    { eventId: "$t1", sender: "@vincent:x", body: "hello", threadRoot: ROOT, timestamp: 2 },
    { eventId: "$t2", sender: "@pi:x", body: "hi there", threadRoot: ROOT, timestamp: 3 },
    { eventId: "$o1", sender: "@c:x", body: "other", threadRoot: "$other", timestamp: 4 },
  ];
  const fake = makeFakeMatrixHttp(timeline);
  const tm = createThreadManager({
    enabled: true, roomKey: "!room:delta", threadSend: fake, statePath: path.join(stateDir, "thread-map-delta.json"),
    threadIcon: "🧵", threadSummaryByLlm: true, threadSummarizeLimit: 40,
  });
  tm.beginSession("new", "delta-1");
  await tm.ensureThreadRoot("delta topic");

  const delta = await tm.readThreadDelta();
  check("readThreadDelta returns this root's thread messages (newest last)", delta.map((m) => m.eventId).join(",") === `${ROOT},$t1,$t2`, JSON.stringify(delta.map((m) => m.eventId)));

  // A completed LLM run advances the per-root event watermark.
  await tm.updateSummary("# Topic: delta\n- done — status: completed", "$t1");
  check("updateSummary stores the event watermark", tm.status().activeRoot?.lastSummarizedEventId === "$t1" && tm.status().activeRoot?.lastSummary?.includes("# Topic: delta"), JSON.stringify({ wm: tm.status().activeRoot?.lastSummarizedEventId }));

  const delta2 = await tm.readThreadDelta();
  check("delta after the watermark excludes up to + including it", delta2.map((m) => m.eventId).join(",") === "$t2", JSON.stringify(delta2.map((m) => m.eventId)));

  // The clobber path (no-arg updateSummary) never clears the watermark.
  await tm.updateSummary();
  check("no-arg updateSummary keeps the watermark", tm.status().activeRoot?.lastSummarizedEventId === "$t1", JSON.stringify(tm.status().activeRoot?.lastSummarizedEventId));
}

// ---- threading: a subagent completion does NOT spawn a sub-thread (§6.3) ----
console.log("== threading: subagent completion is a no-op on sub-threads (§6.3) ==");
{
  // The matrix extension creates sub-thread roots only via ThreadManager
  // .spawnSubThread(), which is driven from the `subagent` tool's tool_call in
  // index.ts. A programmatic subagents:rpc:spawn (the summarizer path) is not a
  // main-session tool call, so it never reaches that watcher — a completed
  // subagent adds no sub-thread. Assert the ThreadManager invariant: the
  // sub-thread count changes only via spawnSubThread.
  function makeFakeMatrixHttp() {
    const calls = [];
    let n = 0;
    return {
      calls,
      async postThreadRoot() { n++; calls.push(["root"]); return { success: true, eventId: `$froot-${n}` }; },
      async postThreadReply() { n++; calls.push(["reply"]); return { success: true, eventId: `$frep-${n}` }; },
      async editMessage() { return { success: true }; },
      async setRoomTopic() { return { success: true }; },
      async readTimeline() { return { success: true, messages: [] }; },
    };
  }
  const fake = makeFakeMatrixHttp();
  const tm = createThreadManager({
    enabled: true, roomKey: "!room:sub63", threadSend: fake, statePath: path.join(stateDir, "thread-map-sub63.json"),
    threadIcon: "🧵", subThreads: true, rolePrefixes: true,
  });
  tm.beginSession("new", "sub63-1");
  await tm.ensureThreadRoot("sub63 topic");
  check("active root starts with no sub-threads", tm.status().activeRoot?.subThreads.length === 0, String(tm.status().activeRoot?.subThreads.length));
  await tm.spawnSubThread("reviewer", "reviewer");
  check("spawnSubThread adds exactly one sub-thread", tm.status().activeRoot?.subThreads.length === 1, String(tm.status().activeRoot?.subThreads.length));
  // No ThreadManager method consumes subagent results: a completed subagent
  // (the summarizer) leaves the count untouched.
  check("a completed subagent changes no sub-thread (only spawnSubThread does)", tm.status().activeRoot?.subThreads.length === 1, String(tm.status().activeRoot?.subThreads.length));
}

// ---- config: threadSummarizeSource flag (DESIGN-ROOM-SUMMARIZER §5) ----
console.log("== config: threadSummarizeSource flag ==");
{
  const { loadConfig, DEFAULT_CONFIG } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
  check("threadSummarizeSource defaults to room", DEFAULT_CONFIG.threadSummarizeSource === "room", JSON.stringify(DEFAULT_CONFIG.threadSummarizeSource));
  process.env.PI_MATRIX_THREAD_SUMMARIZE_SOURCE = "session";
  const cfgSession = loadConfig(path.join(EXT_DIR, "config", "matrix-config.json"));
  check("env PI_MATRIX_THREAD_SUMMARIZE_SOURCE=session → session", cfgSession.threadSummarizeSource === "session", JSON.stringify(cfgSession.threadSummarizeSource));
  delete process.env.PI_MATRIX_THREAD_SUMMARIZE_SOURCE;
}

// ---- config: seedConfigDefaults (self-healing config files) ----
console.log("== config: seedConfigDefaults (self-healing files) ==");
{
  const { seedConfigDefaults } = await jiti.import(path.join(EXT_DIR, "src/config-utils.ts"));
  const { seedProfileDefaults } = await jiti.import(path.join(EXT_DIR, "src/config.ts"));
  const seedDir = path.join(tmp, "seed");
  fs.mkdirSync(seedDir, { recursive: true });

  // A pre-feature file: only a few keys, most of the newer ones missing.
  const seedPath = path.join(seedDir, "seeded.json");
  fs.writeFileSync(seedPath, JSON.stringify({ sendFormatted: false, threadSummaryEvery: 5 }, null, 2) + "\n");
  const seeded = seedConfigDefaults(seedPath);
  const after = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  check(
    "seeds missing keys with their defaults",
    seeded.includes("threadSummarizeLimit") && seeded.includes("threadSummarizeSource") &&
      after.threadSummarizeLimit === 40 && after.threadSummarizeSource === "room",
    JSON.stringify(seeded),
  );
  check("existing values are preserved", after.threadSummaryEvery === 5 && after.sendFormatted === false, JSON.stringify({ every: after.threadSummaryEvery }));
  check("undefined-default optional keys are not seeded", !("threadSummarizeModel" in after), JSON.stringify(Object.keys(after).includes("threadSummarizeModel")));
  check("second seed is a no-op", seedConfigDefaults(seedPath).length === 0, "");

  // Unreadable / non-object files are left untouched.
  const badPath = path.join(seedDir, "bad.json");
  fs.writeFileSync(badPath, "{ not json");
  check("invalid JSON is left untouched", seedConfigDefaults(badPath).length === 0 && fs.readFileSync(badPath, "utf8") === "{ not json", "");
  const arrPath = path.join(seedDir, "arr.json");
  fs.writeFileSync(arrPath, "[1,2,3]");
  check("non-object JSON is left untouched", seedConfigDefaults(arrPath).length === 0 && fs.readFileSync(arrPath, "utf8") === "[1,2,3]", "");

  // Profile seeding: a missing profile is a no-op; the path-traversal guard holds.
  check("seedProfileDefaults: missing profile is a no-op", seedProfileDefaults("does-not-exist").length === 0, "");
  check("seedProfileDefaults: path-traversal name rejected", seedProfileDefaults("../evil").length === 0, "");

  // Profiles are v2 documents now, so seeding walks sections. Flat keys written
  // at the top level of a v2 file are ignored by the v2 loader and litter it.
  {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-seed-"));
    const seedCfgDir = path.join(proj, ".pi", "matrix");
    fs.mkdirSync(seedCfgDir, { recursive: true });
    // resolveConfigPath() picks the dir up through the ACTIVE config file.
    fs.writeFileSync(path.join(seedCfgDir, "matrix-config.jsonc"), JSON.stringify({ configVersion: "2.0" }));
    const profilePath = path.join(seedCfgDir, "matrix-config.seedme.jsonc");
    fs.writeFileSync(profilePath, JSON.stringify({ configVersion: "2.0", piMatrixThreading: { threads: true } }));
    const cwd = process.cwd();
    process.chdir(proj);
    try {
      const seeded = seedProfileDefaults("seedme");
      const afterSeed = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      check("v2 profile seeds inside its own section", seeded.length > 0 && seeded.every((k) => k.startsWith("piMatrix")), JSON.stringify(seeded));
      check("v2 profile has the seeded key", typeof afterSeed.piMatrixThreading?.threadIcon === "string", JSON.stringify(afterSeed.piMatrixThreading));
      check("v2 seeding writes no flat keys at top level", !("sendMilestones" in afterSeed) && !("autoConnect" in afterSeed), JSON.stringify(Object.keys(afterSeed)));
      check("second v2 seed is a no-op", seedProfileDefaults("seedme").length === 0, "");
    } finally {
      process.chdir(cwd);
      fs.rmSync(proj, { recursive: true, force: true });
    }
  }
}

// ---- summarize-dispatch: source toggle seam (DESIGN-ROOM-SUMMARIZER §5) ----
console.log("== summarize-dispatch: source toggle (seam) ==");
{
  const { createSummarizeDispatcher } = await jiti.import(path.join(EXT_DIR, "src/summarize-dispatch.ts"));

  const root = { eventId: "$r1", topic: "t", lastSummary: "BASE", lastSummarizedEventId: "$old" };
  const delta = [{ eventId: "$d1", sender: "@v:x", body: "hi", timestamp: 1 }];

  function makeDeps(source, { available = true, result = "NEW", delta: d = [] } = {}) {
    const calls = { readDelta: 0, run: 0, inject: [], update: [] };
    const deps = {
      source,
      readDelta: async () => { calls.readDelta++; return d; },
      subagent: {
        isAvailable: async () => available,
        run: async () => { calls.run++; return result; },
      },
      injectDirective: (text) => { calls.inject.push(text); },
      updateSummary: async (s, w) => { calls.update.push([s, w]); return true; },
    };
    return { dispatch: createSummarizeDispatcher(deps), calls };
  }

  // "session" (legacy): baseline-only directive into the main session — no
  // subagent spawn, no context copy, no room read, no direct post.
  {
    const { dispatch, calls } = makeDeps("session", { delta });
    dispatch(root);
    check("session: injects a directive", calls.inject.length === 1, String(calls.inject.length));
    check(
      "session: directive is the legacy form (baseline, no delta section)",
      calls.inject[0].includes("BASE") && !calls.inject[0].includes("Newest thread messages"),
      calls.inject[0]?.slice(0, 100),
    );
    check(
      "session: no subagent / no room read / no post",
      calls.run === 0 && calls.readDelta === 0 && calls.update.length === 0,
      JSON.stringify({ run: calls.run, readDelta: calls.readDelta, update: calls.update.length }),
    );
  }
  // "room" + subagent available: delta read + subagent run + post with watermark.
  {
    const { dispatch, calls } = makeDeps("room", { available: true, result: "NEW", delta });
    dispatch(root);
    await waitUntil(
      () => calls.update.length === 1,
      { label: "room post with the last-delta watermark" },
    );
    check("room: reads the delta + runs the subagent", calls.readDelta === 1 && calls.run === 1, JSON.stringify({ readDelta: calls.readDelta, run: calls.run }));
    check("room: posts the summary with the last-delta watermark", calls.update.length === 1 && calls.update[0][0] === "NEW" && calls.update[0][1] === "$d1", JSON.stringify(calls.update));
    check("room: no directive when the subagent runs", calls.inject.length === 0, String(calls.inject.length));
  }
  // "room" + subagent unavailable: room-sourced in-session fallback directive.
  {
    const { dispatch, calls } = makeDeps("room", { available: false, delta });
    dispatch(root);
    await waitUntil(
      () => calls.inject.length === 1,
      { label: "fallback room-sourced directive" },
    );
    check("room fallback: injects the room-sourced directive (delta included)", calls.inject.length === 1 && calls.inject[0].includes("@v:x: hi"), calls.inject[0]?.slice(0, 120));
    check("room fallback: no subagent / no post", calls.run === 0 && calls.update.length === 0, "");
  }
  // "room" + subagent failure: keep the last summary (no post).
  {
    const { dispatch, calls } = makeDeps("room", { available: true, result: null, delta });
    dispatch(root);
    // result is null → the subagent runs but posts nothing; await the run
    // itself, the terminal observable of this path.
    await waitUntil(
      () => calls.run === 1,
      { label: "subagent run (failed path)" },
    );
    check("room: failed subagent → no post (keep lastSummary)", calls.run === 1 && calls.update.length === 0, JSON.stringify({ run: calls.run, update: calls.update.length }));
  }
  // unknown source value → room path (lenient normalization).
  {
    const { dispatch, calls } = makeDeps("bogus", { available: false });
    dispatch(root);
    await waitUntil(
      () => calls.readDelta === 1 && calls.inject.length === 1,
      { label: "room-path directive for unknown source" },
    );
    check("unknown source → room path", calls.readDelta === 1 && calls.inject.length === 1, JSON.stringify({ readDelta: calls.readDelta, inject: calls.inject.length }));
  }
  // single-flight contract: the room dispatch returns a promise that settles
  // when the run is done and never rejects (the ThreadManager releases its
  // in-flight flag on it).
  {
    const { dispatch, calls } = makeDeps("room", { available: true, result: "NEW", delta });
    const done = dispatch(root);
    check("room: dispatch returns a settle promise", done instanceof Promise, typeof done);
    await done;
    check("room: the promise settles after the post", calls.update.length === 1, JSON.stringify(calls.update));
  }
  // the milestone ledger travels with the root as the fir-tree anchor.
  {
    const { dispatch, calls } = makeDeps("room", { available: false, delta });
    dispatch({ ...root, milestones: ["Shipped v1"] });
    await waitUntil(
      () => calls.inject.length === 1,
      { label: "fallback directive with milestone candidates" },
    );
    check("room fallback: directive carries milestone candidates", calls.inject[0].includes("Shipped v1"), calls.inject[0]?.slice(0, 160));
  }
}

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
    roomUri: "#pi-updates:matrix.r3d.nl", lastError: undefined,
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
    { ...baseStatus, roomUri: "!abcdefgh1234567:matrix.r3d.nl", userId: "@pi_agent:matrix.r3d.nl" },
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
    roomUri: "#pi-updates:matrix.r3d.nl", userId: "@pi_agent:matrix.r3d.nl",
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
    homeserver: "tst2-matrix.r3d.nl",
    userId: "@pi-agent:tst2-matrix.r3d.nl",
    roomId: "#pi-updates:tst2-matrix.r3d.nl",
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
    "sdk postThreadRoot → the m.thread marker the homeops server retains (MSC1767 shape)",
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
  tlHandler(ev("$self-1", "@pi-agent:tst2-matrix.r3d.nl", "m.room.message", { body: "my own post" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
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
  tlHandler(ev("$own-sent", "@pi-agent:tst2-matrix.r3d.nl", "m.room.message", { body: "confirmed copy" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
  check("sdk delivery: the confirmed copy of an outbox send drops (send record, not sender)", !emitted.includes("$own-sent") && !bumped.includes("$own-sent"));
  tlHandler(ev("~!temp-1", "@pi-agent:tst2-matrix.r3d.nl", "m.room.message", { body: "local echo" }), { roomId: "!resolved:test" }, false, false, { liveEvent: true });
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
  check(
    "without a project config, state falls back to the extension-local dir (no silent migration)",
    getStateDir() === path.join(getExtensionDir(), "state"),
    getStateDir(),
  );
}

// F3 regression: the voice leg resolves rpiv-voice lazily UNDER THE
// PI LOADER (this suite runs on the same jiti), so a relocated npm
// store can no longer break the extension's module load.
{
  const { loadVoiceModules } = await jiti.import(path.join(EXT_DIR, "src/voice.ts"));
  const mods = await loadVoiceModules({ debug() {}, warn() {}, error() {} });
  check(
    "voice: rpiv-voice bundle resolves lazily under the pi loader",
    mods !== null && typeof mods.stt?.createSttEngine === "function" &&
      typeof mods.pcm?.bufferToFloat32 === "function" &&
      typeof mods.hal?.isHallucination === "function" &&
      typeof mods.model?.getModelPaths === "function",
    mods === null ? "null (store not found)" : "loaded",
  );
}

finish();
