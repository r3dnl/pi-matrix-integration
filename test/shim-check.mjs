/**
 * Shim self-check (design: "non-trivial logic leaves one runnable check"):
 * put/get/add/delete/getAll/cursor/index round-trips through the file
 * store, including the __bin1 binary path and an index scan. Run:
 *   node test/shim-check.mjs   (via jiti, exits 0 on pass)
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiJiti, EXT_DIR } from "./_harness.mjs";

const jiti = await createPiJiti(import.meta.url);
const { installFileIdb } = await jiti.import(join(EXT_DIR, "src", "idb-file-store.ts"));

const dir = join(tmpdir(), "pi-idb-shim-check");
rmSync(dir, { recursive: true, force: true });
const uninstall = installFileIdb(dir, globalThis);
const dbp = new Promise((resolve, reject) => {
  const req = globalThis.indexedDB.open("shimcheck");
  req.onupgradeneeded = (evt) => {
    // Browser-faithful: the versionchange event targets the OPEN REQUEST;
    // the database is event.target.result (the wasm glue reads it the same
    // way — Database::from_event → req.result).
    const db = evt.target.result;
    db.createObjectStore("kv");
    db.createObjectStore("idx").createIndex("by_dev", "device_id");
  };
  req.onsuccess = (evt) => resolve(evt.target.result);
  req.onerror = () => reject(new Error("open failed: " + req.error));
});

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "FAIL "}${name}${extra ? ` ${extra}` : ""}`);
  if (!cond) failures++;
};

const db = await dbp;
const tx = db.transaction(["kv", "idx"], "readwrite");
const kv = tx.objectStore("kv");
const idx = tx.objectStore("idx");

await new Promise((r) => (kv.put({ a: 1, nested: { b: [1, 2, 3] } }, "k1").onsuccess = r));
await new Promise((r) => (kv.put(new Uint8Array([1, 2, 255]), "bin").onsuccess = r));
await new Promise((r) => (kv.add({ n: 1 }, 42).onsuccess = r)); // explicit number key
await new Promise((r) => (idx.put({ device_id: "DEV_A", secret: true }, "d1").onsuccess = r));
await new Promise((r) => (idx.put({ device_id: "DEV_B", secret: false }, "d2").onsuccess = r));
await new Promise((r) => tx.oncomplete = r);

const r2 = db.transaction(["kv", "idx"], "readonly");
const kv2 = r2.objectStore("kv");
const got = await new Promise((r) => (kv2.get("k1").onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check("object round-trip", JSON.stringify(got) === JSON.stringify({ a: 1, nested: { b: [1, 2, 3] } }), JSON.stringify(got));

const gotBin = await new Promise((r) => (kv2.get("bin").onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check(
  "uint8array round-trip",
  gotBin instanceof Uint8Array && gotBin.length === 3 && gotBin[2] === 255,
  String(gotBin) + " " + gotBin?.constructor?.name,
);

const gotNum = await new Promise((r) => (kv2.get(42).onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check("numeric key round-trip", JSON.stringify(gotNum) === JSON.stringify({ n: 1 }), JSON.stringify(gotNum));

const all = await new Promise((r) => (kv2.getAll().onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check("getAll count", all.length === 3, `got ${all.length}`);

// Index scan
const idx2 = r2.objectStore("idx").index("by_dev");
const byDev = await new Promise((r) => (idx2.get("DEV_B").onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check("index.get", byDev && byDev.secret === false, JSON.stringify(byDev));
const idxAll = await new Promise((r) => (idx2.getAllKeys("DEV_A").onsuccess = (e) => r(e.target ? e.target.result : e.result)));
check("index.getAllKeys", JSON.stringify(idxAll) === JSON.stringify(["d1"]), JSON.stringify(idxAll));

// Cursor (shim mutates the cursor in place, like real IDB: continue() moves
// the same object to the next entry and nulls key/value at the end).
let cursor = await new Promise((r) => (kv2.openCursor().onsuccess = (e) => r(e.target ? e.target.result : e.result)));
const keys = [];
while (cursor && cursor.key !== null) {
  keys.push(String(cursor.key));
  await new Promise((r) => (cursor.continue().onsuccess = r));
}
check("cursor iterates all", keys.length === 3, keys.join(","));

// delete + persistence
const r3 = db.transaction("kv", "readwrite");
await new Promise((res) => (r3.objectStore("kv").delete("k1").onsuccess = res));
await new Promise((res) => (r3.oncomplete = res));
const gone = await new Promise((res) => {
  const t = db.transaction("kv", "readonly");
  t.objectStore("kv").get("k1").onsuccess = (e) => res(e.target ? e.target.result : e.result);
});
check("delete", gone === undefined, String(gone));

uninstall();
if (failures === 0) {
  console.log("SHIM SELF-CHECK PASSED");
  process.exit(0);
}
console.error(`${failures} CHECK(S) FAILED`);
process.exit(1);
