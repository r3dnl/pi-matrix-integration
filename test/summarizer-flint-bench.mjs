// Bench the thread summarizer prompt against a local OpenAI-compatible server.
// Reads the real thread (root + delta) from Matrix, builds the exact extension
// prompt, POSTs it, prints timing + output. Read-only against Matrix.
// Usage: node test/summarizer-flint-bench.mjs [rootEventId]
import { readFileSync } from "node:fs";
import { buildThreadSummarizePrompt } from "../src/summarize.ts";

const ROOT = "$" + (process.argv[2] || "Qwhfe21GKH4i_UreZWyZLmIUAoJ0UNM4LwdRSpB-8-w");
const ROOM = "!ilyfgrDPAerEATgFKm:matrix.r3d.nl";
const BASE = process.env.BENCH_API || "http://192.168.2.11:8000";
const MODEL = process.env.BENCH_MODEL || "mlx-community/flint-mixed-3-4bit";

const creds = JSON.parse(readFileSync(process.env.HOME + "/.config/mtx/accounts/pi_agent--matrix.r3d.nl/credentials.json", "utf8"));
const H = { Authorization: `Bearer ${creds.access_token}` };
const v3 = (p) => `${creds.homeserver}/_matrix/client/v3${p}`;
const v1 = (p) => `${creds.homeserver}/_matrix/client/v1${p}`;
const enc = encodeURIComponent;

const root = await (await fetch(v3(`/rooms/${enc(ROOM)}/messages?dir=b&limit=1000`), { headers: H })).json();
const rootEv = (root.chunk ?? []).find((e) => e.event_id === ROOT);
const rc = rootEv?.unsigned?.["m.relations"]?.["m.replace"]?.content ?? rootEv?.content ?? {};
const baseSummary = (rc["m.new_content"]?.body ?? rc.body ?? "").replace(/^🧵[^\n]*\n/, "").trim();
const topic = (rc.body ?? "").match(/^🧵\s*(.+?)(?::|\n)/)?.[1]?.trim() || "(unknown)";

const delta = [];
let from;
do {
  const q = new URLSearchParams({ limit: "50", dir: "f" });
  if (from) q.set("from", from);
  const r = await (await fetch(v1(`/rooms/${enc(ROOM)}/relations/${enc(ROOT)}/m.thread?${q}`), { headers: H })).json();
  for (const e of r.chunk ?? []) {
    const body = e.content?.["m.new_content"]?.body ?? e.content?.body;
    if (typeof body === "string") delta.push({ sender: e.sender, body: body.replace(/\n/g, " ").slice(0, 400) });
  }
  from = r.next_batch;
} while (from && delta.length < 40);

const prompt = buildThreadSummarizePrompt({ topic, lastSummary: baseSummary, delta: delta.slice(-40) });
console.log(`thread: ${ROOT.slice(0, 12)}…  topic: ${topic}`);
console.log(`delta: ${delta.length} messages | baseline: ${baseSummary.split("\n").length} lines | prompt: ${prompt.length} chars`);

const t0 = Date.now();
const resp = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: readFileSync(process.env.HOME + "/.pi/agent/extensions/pi-matrix-integration/agents/pi-matrix-integration-thread-summarizer.md", "utf8").split("---\n")[2].trim() },
      { role: "user", content: prompt },
    ],
    max_tokens: Number(process.env.BENCH_MAX_TOKENS || 4096),
    // mlx_vlm server only: thinking is always emitted by flint-mixed; the
    // budget force-closes it. Ceiling: unneeded once the server honours
    // enable_thinking:false — delete this branch then.
    ...(BASE.includes(":8000") ? { enable_thinking: true, thinking_budget: Number(process.env.BENCH_THINK_BUDGET || 256) } : {}),
  }),
});
const data = await resp.json();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const out = data.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 300);
console.log(`\n=== model replied in ${secs}s | usage: ${JSON.stringify(data.usage ?? null)} ===\n`);
console.log(out);
