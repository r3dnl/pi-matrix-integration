/**
 * Unread-model unit tests (DESIGN-TRANSPORT-AND-IDENTITY §3.6): the D1
 * rules (first reply bumps once, further replies don't, a new root
 * counts, clear wipes both), atomic save/load (U-01), the `count?` field
 * present from day one, watermark idempotency (U-04) at the model level.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPiJiti, EXT_DIR, makeCheck } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { check, finish } = makeCheck();

const { UnreadModel, makePreview, PREVIEW_LIMIT } = await jiti.import(
  path.join(EXT_DIR, "src/unread-model.ts"),
);

const ROOM = "!room:test.example.org";
const ROOT = "$root-A";

console.log("== D1 bump rules ==");
{
  const m = new UnreadModel();
  m.bump(ROOM, { ts: 1, preview: "flat one" });
  m.bump(ROOM, { ts: 2, preview: "flat two" });
  check("two flat messages → total 2", m.totalFor(ROOM) === 2, String(m.totalFor(ROOM)));

  // first reply into a thread adds ONE unit…
  m.bump(ROOM, { ts: 3, preview: "reply 1", threadRoot: ROOT });
  check("first reply adds one unit", m.totalFor(ROOM) === 3, String(m.totalFor(ROOM)));
  // …further replies only update lastTs/count, never the total
  m.bump(ROOM, { ts: 4, preview: "reply 2", threadRoot: ROOT });
  m.bump(ROOM, { ts: 5, preview: "reply 3", threadRoot: ROOT });
  check("further replies do not add units", m.totalFor(ROOM) === 3, String(m.totalFor(ROOM)));
  const entry = m.room(ROOM).threads.get(ROOT);
  check(
    "reply counter tracks the thread (count?)",
    entry?.count === 3 && entry?.lastTs === 5 && entry?.preview === "reply 3",
    JSON.stringify(entry),
  );

  // a new root is a new conversation: one unit
  m.bump(ROOM, { ts: 6, preview: "new root", isThreadRoot: true, eventId: "$root-B" });
  check("new root counts as one unit", m.totalFor(ROOM) === 4, String(m.totalFor(ROOM)));
  // a reply into that new root adds nothing more
  m.bump(ROOM, { ts: 7, preview: "reply in B", threadRoot: "$root-B" });
  check("reply into the new root adds no unit", m.totalFor(ROOM) === 4, String(m.totalFor(ROOM)));

  // clear wipes the flat counter AND the thread map
  m.clear(ROOM);
  check("clear wipes flat + threads (since kept)", m.totalFor(ROOM) === 0 && m.sinceFor(ROOM) === 7,
    JSON.stringify({ total: m.totalFor(ROOM), since: m.sinceFor(ROOM) }));

  // a clear on an unseen room is a no-op
  m.clear("!nope:d");
  check("clear unknown room is a no-op", !m.rooms.has("!nope:d"), "");
}

console.log("== D1 total = new_flat + threads_with_new_replies ==");
{
  const m = new UnreadModel();
  for (let i = 0; i < 5; i++) m.bump(ROOM, { ts: i + 1, preview: `flat ${i}` });
  m.bump(ROOM, { ts: 6, preview: "r", threadRoot: ROOT });
  m.bump(ROOM, { ts: 7, preview: "r2", threadRoot: ROOT });
  m.bump(ROOM, { ts: 8, preview: "r", threadRoot: "$root-C" });
  // 5 flat + 2 threads-with-replies = 7 (the per-event alternative would be 8)
  check("total is conversations, not events", m.totalFor(ROOM) === 7, String(m.totalFor(ROOM)));
  check("model.total() sums rooms", m.total() === 7, String(m.total()));
}

console.log("== watermark (U-04) ==");
{
  const m = new UnreadModel();
  m.bump(ROOM, { ts: 100, preview: "x" });
  m.bump(ROOM, { ts: 90, preview: "older" });
  check("since advances to the max seen", m.sinceFor(ROOM) === 100, String(m.sinceFor(ROOM)));
  check("never-seen room has since 0", m.sinceFor("!x:d") === 0, "");
  check("setSince is explicit + idempotent", (m.setSince(ROOM, 100), m.sinceFor(ROOM) === 100), "");
}

console.log("== preview (never the full body, §19.7) ==");
{
  check("preview truncates long bodies", makePreview("word ".repeat(50)).length <= PREVIEW_LIMIT,
    String(makePreview("word ".repeat(50)).length));
  check("preview is single-line", !makePreview("a\nb\nc").includes("\n"), "");
}

console.log("== save/load (U-01 atomic, U-06 degradable) ==");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unread-model-"));
  const file = path.join(dir, "unread-alpha.json");
  const m = new UnreadModel();
  m.bump(ROOM, { ts: 1, preview: "f1" });
  m.bump(ROOM, { ts: 2, preview: "f2" });
  m.bump(ROOM, { ts: 3, preview: "r1", threadRoot: ROOT });
  m.bump(ROOM, { ts: 4, preview: "r2", threadRoot: ROOT });
  m.save(file);

  check("save leaves no .tmp behind", !fs.readdirSync(dir).some((n) => n.includes(".tmp")),
    JSON.stringify(fs.readdirSync(dir)));

  const loaded = UnreadModel.load(file);
  check(
    "round-trip: totals, since, thread entries + count survive",
    loaded.totalFor(ROOM) === 3 &&
      loaded.sinceFor(ROOM) === 4 &&
      loaded.room(ROOM).threads.get(ROOT)?.count === 2 &&
      loaded.room(ROOM).threads.get(ROOT)?.preview === "r2",
    JSON.stringify(loaded.toDict()),
  );
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  check(
    "file shape carries schema + version + per-thread count?",
    raw.apiVersion === "pi-matrix/v1" && raw.schema === "pi-matrix/unread" && raw.version === 3 &&
      raw.rooms[ROOM].threads[ROOT].count === 2,
    JSON.stringify(raw),
  );

  check("load absent file → empty model", !UnreadModel.load(path.join(dir, "nope.json")).hasData(), "");
  fs.writeFileSync(file + ".corrupt", "{ not json");
  check("load corrupt file → empty model (U-06)", !UnreadModel.load(file + ".corrupt").hasData(), "");
}

finish();
