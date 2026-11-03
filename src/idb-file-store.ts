/**
 * Pi Matrix Integration — file-backed IndexedDB shim (transport-and-state.md-SDK-HTTP-
 * transport-and-state.md).
 *
 * The js-sdk's Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`) persists
 * E2EE keys through IndexedDB (`StoreHandle.open(name, passphrase)`). Node
 * has no IndexedDB and `fake-indexeddb` is explicitly in-memory, so this
 * shim implements the IDB surface the wasm backend actually calls (verified
 * against the wasm glue, 2026-09-18): open / transaction / objectStore /
 * put / add / get / delete / clear / count / getAll / getAllKeys / getKey /
 * openCursor / createIndex / index / objectStoreNames / version.
 *
 * Storage: one JSON file per key under `dir/<db>/<store>/` (atomic
 * temp+rename writes; dir 0700, files 0600). Values are JSON-plain (the
 * wasm side stores serde-converted JSON); `Uint8Array`s round-trip via a
 * `__bin1` base64 marker. At-rest encryption is the wasm store's own
 * (`store_passphrase`) — the files hold the encrypted blobs.
 *
 * Install BEFORE `initRustCrypto`:
 *   installFileIdb(cryptoStoreDir, globalThis);
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ============================================================================
// Value codec (binary-safe JSON)
// ============================================================================

function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __bin1: Buffer.from(v).toString("base64") };
  if (v instanceof ArrayBuffer) {
    return { __bin1: Buffer.from(new Uint8Array(v)).toString("base64") };
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) out[k] = encodeValue(val);
    return out;
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.__bin1 === "string") {
      return new Uint8Array(Buffer.from(o.__bin1, "base64"));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = decodeValue(val);
    return out;
  }
  if (Array.isArray(v)) return v.map(decodeValue);
  return v;
}

// ============================================================================
// Key ordering (IDB comparison — the crypto store's keys are strings)
// ============================================================================

function keyCmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function inRange(key: unknown, range: unknown): boolean {
  if (!range || typeof range !== "object") return true;
  const r = range as { lower?: unknown; upper?: unknown; lowerOpen?: boolean; upperOpen?: boolean };
  if (r.lower !== undefined) {
    const c = keyCmp(key, r.lower);
    if (c < 0 || (c === 0 && r.lowerOpen)) return false;
  }
  if (r.upper !== undefined) {
    const c = keyCmp(key, r.upper);
    if (c > 0 || (c === 0 && r.upperOpen)) return false;
  }
  return true;
}

/** Resolve an IDB keyPath ("a.b" or ["a","b"]) against a value. */
function resolveKeyPath(value: unknown, keyPath: string | string[]): unknown {
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  let cur: unknown = value;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ============================================================================
// Requests / transactions
// ============================================================================

interface IdRequest {
  result: unknown;
  error: unknown;
  onsuccess: ((this: unknown) => void) | null;
  onerror: ((this: unknown) => void) | null;
  onupgradeneeded?: ((this: unknown, ev?: unknown, req?: unknown) => void) | null;
  onblocked?: ((this: unknown) => void) | null;
  transaction: unknown;
  done: boolean;
  _settle?: (e?: unknown) => void;
  then?: (onF?: (r: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise<unknown>;
}

// Prototypes installed by installFileIdb (the wasm glue type-checks request
// objects with `instanceof IDBRequest` / `instanceof IDBOpenDBRequest`).
let requestProto: object = Object.prototype;
let openRequestProto: object = Object.prototype;

function makeRequest(open = false): IdRequest {
  const o: Record<string, unknown> = Object.create(open ? openRequestProto : requestProto);
  o.result = undefined;
  o.error = undefined;
  o.onsuccess = null;
  o.onerror = null;
  o.onupgradeneeded = null;
  o.onblocked = null;
  o.transaction = null;
  o.done = false;
  let settle: (e?: unknown) => void = () => {};
  const settled = new Promise<unknown>((res, rej) => {
    settle = (e) => (e === undefined ? res(undefined) : rej(e));
  });
  o._settle = settle;
  // Browsers expose a Promise-like `.then` on IDB requests; the wasm glue
  // awaits requests through it.
  o.then = (onF?: (r: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    settled.then(
      () => (typeof onF === "function" ? onF(o.result) : o.result),
      (e: unknown) => (typeof onR === "function" ? onR(e) : Promise.reject(e)),
    );
  return o as unknown as IdRequest;
}

function fulfill(req: IdRequest, value: unknown): void {
  req.result = value;
  queueMicrotask(() => {
    fire(req.onsuccess, req);
    req._settle?.();
  });
}

function fail(req: IdRequest, error: unknown): void {
  req.error = error;
  queueMicrotask(() => {
    fire(req.onerror, req);
    req._settle?.(error);
  });
}

/**
 * Invoke an IDB event handler with browser-shaped event args: the wasm glue
 * reads `event.target` off the handler argument (real IDB: request events
 * target the request, versionchange targets the request too — the database
 * is reachable via `event.target.result`).
 */
function fire(handler: ((ev: unknown, target?: unknown) => void) | null | undefined, target: unknown): void {
  if (process.env.PI_IDB_DEBUG && handler) {
    console.error(`[idb-shim] fire target=${String((target as { name?: string })?.name ?? (target as { type?: string })?.type ?? target)}`);
  }
  handler?.({ target }, target);
}

class IdTransaction {
  readonly oncomplete: ((this: unknown) => void) | null = null;
  readonly onerror: ((this: unknown) => void) | null = null;
  readonly onabort: ((this: unknown) => void) | null = null;
  mode: string;
  private pending = 0;
  private aborted = false;
  private committed = false;
  private readonly db: IdDatabase;
  private readonly storeNames: string[];
  private readonly dynamicStores: boolean;

  constructor(db: IdDatabase, stores: string[], mode: string, dynamicStores = false) {
    this.db = db;
    this.storeNames = stores;
    this.mode = mode;
    this.dynamicStores = dynamicStores;
    if (!dynamicStores) {
      // Browser: EVERY transaction auto-commits when the task ends — even
      // one that never issued a request. Mirror that with a task-boundary
      // timer; complete() is guarded so op-driven settlement wins first.
      setTimeout(() => this.complete(), 0);
    }
  }

  objectStore(name: string): IdObjectStore {
    const ok = this.dynamicStores
      ? this.db["readMeta"]().stores.includes(name)
      : this.storeNames.includes(name);
    if (!ok) {
      throw new Error(`NotFoundError: no object store "${name}" in this transaction`);
    }
    return this.db.storeFor(name, this);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.pending = 0;
    fire(this.onabort, this);
  }

  /** Commit is a no-op in this shim: writes are immediate (atomic rename). */
  commit(): void {
    if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] tx.commit`);
    /* no-op */
  }

  /** Called by store ops as they settle. */
  settle(): void {
    if (this.aborted) return;
    this.pending -= 1;
    if (this.pending === 0) this.complete();
  }

  /** Called before a store op begins. */
  beginOp(): void {
    this.pending += 1;
  }

  private complete(): void {
    // Commit defers to the next macrotask (real IDB: a tx commits when the
    // task goes idle) — callers assign `oncomplete` after issuing requests.
    if (this.aborted || this.committed) return;
    this.committed = true;
    if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] tx complete hasHandler=${!!this.oncomplete}`);
    setTimeout(() => fire(this.oncomplete, this), 0);
  }

  getAborted(): boolean {
    return this.aborted;
  }
}

// ============================================================================
// Object store (one directory of {b64(key)}.json files)
// ============================================================================

class IdObjectStore {
  readonly name: string;
  readonly autoIncrement = false;
  private entries: Map<string, { key: unknown; value: unknown }> | null = null;

  constructor(readonly db: IdDatabase, readonly tx: IdTransaction, name: string) {
    this.name = name;
  }

  private get store(): string {
    return this.name;
  }

  private loadAll(): Map<string, { key: unknown; value: unknown }> {
    if (this.entries) return this.entries;
    const map = new Map<string, { key: unknown; value: unknown }>();
    const dir = this.db.storeDir(this.name);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const key = Buffer.from(f.slice(0, -5), "base64url").toString("utf8");
        const value = decodeValue(JSON.parse(readFileSync(join(dir, f), "utf8")));
        map.set(key, { key, value });
      }
    }
    this.entries = map;
    return map;
  }

  private invalidate(): void {
    this.entries = null;
  }

  private write(key: unknown, value: unknown): void {
    this.invalidate();
    const dir = this.db.storeDir(this.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${Buffer.from(String(key), "utf8").toString("base64url")}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(encodeValue(value)), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private remove(key: unknown): void {
    const dir = this.db.storeDir(this.name);
    const file = join(dir, `${Buffer.from(String(key), "utf8").toString("base64url")}.json`);
    if (existsSync(file)) rmSync(file);
    this.invalidate();
  }

  private checkWritable(): void {
    if (this.tx.mode !== "readwrite") throw new Error("ReadOnlyError: transaction is readonly");
  }

  // ---- value ops (all spec-shaped: request handlers fire on a microtask)

  put(value: unknown, key?: unknown): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      try {
        if (key === undefined) throw new Error("InvalidAccessError: no key (autoIncrement not supported)");
        this.checkWritable();
        this.write(key, value);
        fulfill(req, key);
      } catch (e) {
        fail(req, e);
      } finally {
        this.tx.settle();
      }
    });
    return req;
  }

  add(value: unknown, key?: unknown): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      try {
        if (key === undefined) {
          // Auto-increment counter in meta (spec: add(value) on an
          // autoIncrement store generates the next key).
          key = this.db.nextAutoInc(this.name);
        }
        this.checkWritable();
        this.write(key, value);
        fulfill(req, key);
      } catch (e) {
        fail(req, e);
      } finally {
        this.tx.settle();
      }
    });
    return req;
  }

  get(key: unknown): IdRequest {
    if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] get ${this.name}/${JSON.stringify(key)?.slice(0, 60)}`);
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      const entry = this.loadAll().get(String(key));
      fulfill(req, entry ? entry.value : undefined);
      this.tx.settle();
    });
    return req;
  }

  delete(key: unknown): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      try {
        this.checkWritable();
        this.remove(key);
        fulfill(req, undefined);
      } catch (e) {
        fail(req, e);
      } finally {
        this.tx.settle();
      }
    });
    return req;
  }

  clear(): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      try {
        this.checkWritable();
        const dir = this.db.storeDir(this.name);
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) if (f.endsWith(".json")) rmSync(join(dir, f));
          this.invalidate();
        }
        fulfill(req, undefined);
      } catch (e) {
        fail(req, e);
      } finally {
        this.tx.settle();
      }
    });
    return req;
  }

  count(keyOrRange?: unknown): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      const all = [...this.loadAll().values()];
      const n = keyOrRange === undefined ? all.length : this.matches(all, keyOrRange).length;
      fulfill(req, n);
      this.tx.settle();
    });
    return req;
  }

  getAll(range?: unknown, limit?: number): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      let rows = [...this.loadAll().values()].sort((a, b) => keyCmp(a.key, b.key));
      if (range !== undefined) rows = this.matches(rows, range);
      if (typeof limit === "number") rows = rows.slice(0, limit);
      fulfill(req, rows.map((r) => r.value));
      this.tx.settle();
    });
    return req;
  }

  getAllKeys(range?: unknown, limit?: number): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      let rows = [...this.loadAll().values()].sort((a, b) => keyCmp(a.key, b.key));
      if (range !== undefined) rows = this.matches(rows, range);
      if (typeof limit === "number") rows = rows.slice(0, limit);
      fulfill(req, rows.map((r) => r.key));
      this.tx.settle();
    });
    return req;
  }

  getKey(key: unknown): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      fulfill(req, this.loadAll().has(String(key)) ? key : undefined);
      this.tx.settle();
    });
    return req;
  }

  /**
   * Entries matching a key or an IDBKeyRange-shaped object.
   * `matches(rows, key)` — exact key match on the PRIMARY key;
   * `matches(rows, range)` — range over the primary key.
   */
  private matches(rows: { key: unknown; value: unknown }[], keyOrRange: unknown): { key: unknown; value: unknown }[] {
    if (keyOrRange !== undefined && typeof keyOrRange === "object" &&
      ("lower" in (keyOrRange as object) || "upper" in (keyOrRange as object))) {
      return rows.filter((r) => inRange(r.key, keyOrRange));
    }
    const k = String(keyOrRange);
    return rows.filter((r) => String(r.key) === k);
  }

  openCursor(range?: unknown, direction?: string): IdRequest {
    return this.openCursorImpl(range, direction, false);
  }

  openKeyCursor(range?: unknown, direction?: string): IdRequest {
    return this.openCursorImpl(range, direction, true);
  }

  private openCursorImpl(range: unknown, direction: string | undefined, keyOnly: boolean): IdRequest {
    const req = makeRequest();
    req.transaction = this.tx;
    this.tx.beginOp();
    queueMicrotask(() => {
      let rows = [...this.loadAll().values()].sort((a, b) => keyCmp(a.key, b.key));
      if (range !== undefined) rows = this.matches(rows, range);
      if (direction === "prev" || direction === "prevopen") rows.reverse();
      const cursor = new IdCursor(this, rows, keyOnly);
      fulfill(req, cursor);
      this.tx.settle();
    });
    return req;
  }

  index(name: string): IdIndex {
    const idx = this.db.indexFor(this.name, name);
    if (!idx) throw new Error(`NotFoundError: no index "${name}" on object store "${this.name}"`);
    return new IdIndex(this, idx);
  }

  /** Register an index (upgrade pass). The wasm defines store indexes here. */
  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean; multiEntry?: boolean }): IdIndex {
    const meta = this.db["readMeta"]();
    meta.indexes[this.name] = meta.indexes[this.name] ?? [];
    meta.indexes[this.name] = meta.indexes[this.name].filter((i) => i.name !== name);
    meta.indexes[this.name].push({ name, keyPath, multiEntry: options?.multiEntry ?? false, unique: options?.unique ?? false });
    this.db["writeMeta"](meta);
    this.invalidate();
    return new IdIndex(this, meta.indexes[this.name][meta.indexes[this.name].length - 1]);
  }
}

// ============================================================================
// Cursor
// ============================================================================

class IdCursor {
  key: unknown;
  value: unknown;
  readonly direction: string;
  private pos = -1;
  private keyOnly: boolean;
  private req: IdRequest | null = null;

  constructor(
    private store: IdObjectStore,
    private rows: { key: unknown; value: unknown }[],
    keyOnly: boolean,
  ) {
    this.direction = "next";
    this.keyOnly = keyOnly;
    this.pos = 0;
    this.applyPosition();
  }

  /** Point key/value at rows[this.pos] (null key when exhausted). */
  private applyPosition(): void {
    const row = this.rows[this.pos];
    this.key = row ? row.key : null;
    this.value = row ? (this.keyOnly ? undefined : row.value) : undefined;
  }

  continue(): IdRequest {
    const req = makeRequest();
    this.req = req;
    queueMicrotask(() => {
      this.pos += 1;
      this.applyPosition();
      fulfill(req, null);
    });
    return this.req;
  }

  continuePrimaryKey(): IdRequest {
    return this.continue(); // single-key store — same behavior
  }

  advance(n: number): IdRequest {
    const req = makeRequest();
    queueMicrotask(() => {
      this.pos += n;
      this.applyPosition();
      fulfill(req, null);
    });
    return req;
  }

  update(value: unknown): IdRequest {
    const req = makeRequest();
    queueMicrotask(() => {
      if (this.key === null || this.store.tx.mode !== "readwrite") {
        fail(req, new Error("InvalidStateError: cursor invalid or readonly"));
        return;
      }
      this.store.put(this.value, this.key); // no settle chain needed; put() manages its own tx op
      this.value = value;
      fulfill(req, null);
    });
    return req;
  }

  delete(): IdRequest {
    const req = makeRequest();
    queueMicrotask(() => {
      if (this.key === null || this.store.tx.mode !== "readwrite") {
        fail(req, new Error("InvalidStateError: cursor invalid or readonly"));
        return;
      }
      const k = this.key;
      this.store.delete(k);
      this.key = null;
      this.value = undefined;
      fulfill(req, null);
    });
    return req;
  }

  get request(): IdRequest | null {
    return this.req;
  }
}


// ============================================================================
// Index (computed from the primary store on each query)
// ============================================================================

interface IndexDef {
  name: string;
  keyPath: string | string[];
  multiEntry: boolean;
  unique: boolean;
}

class IdIndex {
  constructor(private store: IdObjectStore, private def: IndexDef) {}

  get name(): string {
    return this.def.name;
  }

  get keyPath(): string | string[] {
    return this.def.keyPath;
  }

  get multiEntry(): boolean {
    return this.def.multiEntry;
  }

  set multiEntry(v: boolean) {
    this.def.multiEntry = v;
  }

  get unique(): boolean {
    return this.def.unique;
  }

  set unique(v: boolean) {
    this.def.unique = v;
  }

  private matches(keyOrRange: unknown): { key: unknown; value: unknown }[] {
    const rows = [...this.store["loadAll"]().values()].sort((a, b) => keyCmp(a.key, b.key));
    const isRange = keyOrRange !== undefined && typeof keyOrRange === "object";
    const keyOf = (r: { key: unknown; value: unknown }): unknown => resolveKeyPath(r.value, this.def.keyPath);
    if (isRange) {
      return rows.filter((r) => inRange(keyOf(r), keyOrRange));
    }
    const k = String(keyOrRange);
    return rows.filter((r) => String(keyOf(r)) === k);
  }

  private ordered(rows: { key: unknown; value: unknown }[]): { key: unknown; value: unknown }[] {
    const keyOf = (r: { key: unknown; value: unknown }): unknown => resolveKeyPath(r.value, this.def.keyPath);
    return [...rows].sort((a, b) => {
      const c = keyCmp(keyOf(a), keyOf(b));
      return c !== 0 ? c : keyCmp(a.key, b.key);
    });
  }

  get(key: unknown): IdRequest {
    const req = makeRequest();
    const hit = this.matches(key).find((r) => String(resolveKeyPath(r.value, this.def.keyPath)) === String(key));
    fulfill(req, hit ? hit.value : undefined);
    return req;
  }

  getKey(key: unknown): IdRequest {
    const req = makeRequest();
    const hit = this.matches(key).find((r) => String(resolveKeyPath(r.value, this.def.keyPath)) === String(key));
    fulfill(req, hit ? hit.key : undefined);
    return req;
  }

  getAll(valueOrRange: unknown, limit?: number): IdRequest {
    const req = makeRequest();
    let rows = this.ordered(this.matches(valueOrRange));
    if (typeof limit === "number") rows = rows.slice(0, limit);
    fulfill(req, rows.map((r) => r.value));
    return req;
  }

  getAllKeys(valueOrRange: unknown, limit?: number): IdRequest {
    const req = makeRequest();
    let rows = this.ordered(this.matches(valueOrRange));
    if (typeof limit === "number") rows = rows.slice(0, limit);
    fulfill(req, rows.map((r) => r.key));
    return req;
  }

  count(valueOrRange?: unknown): IdRequest {
    const req = makeRequest();
    const rows = valueOrRange === undefined ? [...this.store["loadAll"]().values()] : this.matches(valueOrRange);
    fulfill(req, rows.length);
    return req;
  }

  openCursor(range?: unknown, direction?: string): IdRequest {
    const req = makeRequest();
    const rows = this.ordered(this.matches(range));
    if (direction === "prev" || direction === "prevopen") rows.reverse();
    const cursor = new IdCursor(this.store, rows, false);
    fulfill(req, cursor);
    return req;
  }
}

// ============================================================================
// Database
// ============================================================================

class IdDatabase {
  readonly name: string;
  readonly version: number;
  get objectStoreNames(): string[] & { item: (i: number) => string | null } {
    const stores = this.readMeta().stores;
    // The glue walks this as a DOMStringList: `names.item(i)`.
    const list = stores.slice() as string[] & { item: (i: number) => string | null };
    list.item = (i: number) => (i >= 0 && i < stores.length ? stores[i] : null);
    return list;
  }
  private readonly dirPath: string;
  private readonly metaPath: string;

  constructor(name: string, version: number, dirPath: string) {
    this.name = name;
    this.version = version;
    this.dirPath = dirPath;
    this.metaPath = join(dirPath, "meta.json");
  }

  private readMeta(): { stores: string[]; autoinc: Record<string, number>; indexes: Record<string, IndexDef[]> } {
    try {
      return JSON.parse(readFileSync(this.metaPath, "utf8")) as {
        stores: string[];
        autoinc: Record<string, number>;
        indexes: Record<string, IndexDef[]>;
      };
    } catch {
      return { stores: [], autoinc: {}, indexes: {} };
    }
  }

  private writeMeta(meta: { stores: string[]; autoinc: Record<string, number>; indexes: Record<string, IndexDef[]> }): void {
    const tmp = `${this.metaPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
    renameSync(tmp, this.metaPath);
  }

  storeDir(store: string): string {
    return join(this.dirPath, store);
  }

  nextAutoInc(store: string): number {
    const meta = this.readMeta();
    const next = (meta.autoinc[store] ?? 0) + 1;
    meta.autoinc[store] = next;
    this.writeMeta(meta);
    return next;
  }

  indexFor(store: string, name: string): IndexDef | undefined {
    return this.readMeta().indexes[store]?.find((i) => i.name === name);
  }

  createObjectStore(storeName: string, _options?: { autoIncrement?: boolean }): IdObjectStore {
    const meta = this.readMeta();
    if (meta.stores.includes(storeName)) throw new Error(`ConstraintError: store "${storeName}" already exists`);
    meta.stores.push(storeName);
    this.writeMeta(meta);
    mkdirSync(this.storeDir(storeName), { recursive: true, mode: 0o700 });
    // Usable only inside an upgrade transaction (spec); the wasm opens with
    // its own upgrade pass. Return a no-tx handle guarded by a readonly tx.
    const upgradeTx = new IdTransaction(this, [storeName], "readwrite");
    return new IdObjectStore(this, upgradeTx, storeName);
  }

  deleteObjectStore(storeName: string): void {
    const meta = this.readMeta();
    meta.stores = meta.stores.filter((s) => s !== storeName);
    delete meta.indexes[storeName];
    this.writeMeta(meta);
    if (existsSync(this.storeDir(storeName))) rmSync(this.storeDir(storeName), { recursive: true, force: true });
  }

  transaction(stores: string | string[], mode: string = "readonly"): IdTransaction {
    const names = Array.isArray(stores) ? stores : [stores];
    const meta = this.readMeta();
    if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] transaction ${names.join(",")} mode=${mode} knownStores=${meta.stores.join(",")}`);
    for (const n of names) {
      if (!meta.stores.includes(n)) throw new Error(`NotFoundError: no object store "${n}"`);
    }
    return new IdTransaction(this, names, mode);
  }

  close(): void {
    /* no-op (files stay where they are) */
  }

  storeFor(name: string, tx: IdTransaction): IdObjectStore {
    return new IdObjectStore(this, tx, name);
  }
}

// ============================================================================
// Install
// ============================================================================

interface FileIdb {
  open(name: string, version?: number): IdRequest;
  deleteDatabase(name: string): IdRequest;
  cmpVersions(_a: unknown, _b: unknown): number;
}

/**
 * Install a file-backed `indexedDB` on `target` (default: globalThis).
 * `dir` is the root: `<dir>/<db>/…`. Returns an uninstall function.
 */
export function installFileIdb(dir: string, target: object = globalThis): () => void {
  const root = join(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* pre-existing dir — best effort */
  }

  // The wasm glue type-checks shim objects against the IDB global classes
  // (e.g. `req.result instanceof IDBDatabase`) and builds key ranges via
  // `IDBKeyRange.bound/...`. Node has none of those globals, so install
  // minimal stand-ins and graft the shim classes onto their prototypes.
  const g = target as Record<string, unknown>;
  if (!g.IDBRequest) g.IDBRequest = class IDBRequest {};
  if (!g.IDBOpenDBRequest) g.IDBOpenDBRequest = class extends (g.IDBRequest as unknown as new () => object) {};
  if (!g.IDBDatabase) g.IDBDatabase = class IDBDatabase {};
  if (!g.IDBTransaction) g.IDBTransaction = class IDBTransaction {};
  if (!g.IDBCursor) g.IDBCursor = class IDBCursor {};
  if (!g.IDBCursorWithValue) g.IDBCursorWithValue = class extends (g.IDBCursor as unknown as new () => object) {};
  if (!g.IDBKeyRange) {
    g.IDBKeyRange = class IDBKeyRange {
      static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false) {
        return { lower, upper, lowerOpen, upperOpen };
      }
      static lowerBound(lower: unknown, lowerOpen = false) {
        return { lower, lowerOpen };
      }
      static upperBound(upper: unknown, upperOpen = false) {
        return { upper, upperOpen };
      }
      static only(key: unknown) {
        return { lower: key, upper: key };
      }
    };
  }
  requestProto = (g.IDBRequest as new () => object).prototype;
  openRequestProto = (g.IDBOpenDBRequest as new () => object).prototype;
  Object.setPrototypeOf(IdDatabase.prototype, (g.IDBDatabase as new () => object).prototype);
  Object.setPrototypeOf(IdTransaction.prototype, (g.IDBTransaction as new () => object).prototype);
  Object.setPrototypeOf(IdCursor.prototype, (g.IDBCursorWithValue as new () => object).prototype);

  const api: FileIdb = {
    open(name, version) {
      const req = makeRequest(true);
      // Browsers fire the open handshake (upgradeneeded/onsuccess) no sooner
      // than the next TASK — callers set handlers synchronously after
      // open(). A microtask here would fire before the wasm registers its
      // handlers, so the handshake defers to a macrotask.
      setTimeout(() => {
        try {
          const dbDir = join(root, name);
          const metaPath = join(dbDir, "meta.json");
          const hasMeta = existsSync(metaPath);
          if (!hasMeta) {
            mkdirSync(dbDir, { recursive: true, mode: 0o700 });
            writeFileSync(metaPath, JSON.stringify({ version: version ?? 1, stores: [], autoinc: {}, indexes: {} }), { mode: 0o600 });
          }
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { version?: number; stores: string[] };
          // Browser semantics: a missing DB has version 0, so ANY open of a
          // fresh DB fires versionchange (0 -> target) — that is where the
          // wasm creates its object stores. An existing DB opened with a
          // higher version bumps and fires the upgrade pass again.
          const oldVersion = hasMeta ? (meta.version ?? 1) : 0;
          const targetVersion = version === undefined ? Math.max(oldVersion, 1) : version;
          if (version !== undefined && version < oldVersion) {
            fail(req, new Error(`DataError: The requested version (${version}) is less than the existing version (${oldVersion})`));
            return;
          }
          const db = new IdDatabase(name, targetVersion, dbDir);
          req.result = db;
          if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] open ${name} oldVersion=${oldVersion} target=${targetVersion}`);
          if (targetVersion > oldVersion) {
            // Browser: the versionchange event targets the OPEN REQUEST —
            // event.target.result is the database, event.target.transaction
            // is the implicit upgrade transaction (store set grows as
            // createObjectStore runs, so it tracks the live meta).
            const upgradeTx = new IdTransaction(db, [], "readwrite", true);
            req.transaction = upgradeTx;
            req.onupgradeneeded?.({ target: req, oldVersion, newVersion: targetVersion }, req);
            // Re-read: the upgrade pass may have added stores to meta.
            const meta2 = JSON.parse(readFileSync(metaPath, "utf8")) as { version?: number; stores: string[] };
            meta2.version = targetVersion;
            writeFileSync(`${metaPath}.tmp`, JSON.stringify(meta2, null, 2), { mode: 0o600 });
            renameSync(`${metaPath}.tmp`, metaPath);
            if (process.env.PI_IDB_DEBUG) console.error(`[idb-shim] upgrade ${oldVersion}->${targetVersion} stores now=${meta2.stores.join(",")}`);
          }
          queueMicrotask(() => fire(req.onsuccess, req));
        } catch (e) {
          fail(req, e);
        }
      }, 0);
      return req;
    },

    deleteDatabase(name) {
      const req = makeRequest();
      queueMicrotask(() => {
        const dbDir = join(root, name);
        if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });
        fulfill(req, undefined);
      });
      return req;
    },

    cmpVersions() {
      return 0;
    },
  };

  const previous = (target as { indexedDB?: unknown }).indexedDB;
  (target as { indexedDB?: unknown }).indexedDB = api;
  return () => {
    if (previous === undefined) delete (target as { indexedDB?: unknown }).indexedDB;
    else (target as { indexedDB?: unknown }).indexedDB = previous;
  };
}
