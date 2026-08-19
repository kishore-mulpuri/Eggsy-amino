// Local storage layer — IndexedDB, entirely on-device, no network or native
// plugin dependency. Chosen over a native SQLite plugin so the exact same
// code runs in `npm run dev` (desktop browser) and inside the Capacitor
// Android WebView with zero platform-specific branches.
//
// Stores:
//   people  — keyPath "id" — one unified person store (payroll + wage),
//             descriptors as Float32Array (stored natively by IndexedDB).
//             Rows carry NO photos — thumbnails live in their own store so
//             a roster-wide getAll() never drags image data into memory.
//   thumbs  — keyPath "id" (personId) — 96px JPEG data URLs, fetched lazily
//             from /api/device/photo/:id, one at a time, camera down only.
//   events  — keyPath "id", index "byDate" on date, index "byPersonDate" on
//             [personId, date] — the single outbox (punches and plates).
//   meta    — keyPath "key" — sync config, cursors, PIN list, meal windows,
//             reason codes, serial counters, etc.

const DB_NAME = "eggsy-amino";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("people")) {
        db.createObjectStore("people", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("thumbs")) {
        db.createObjectStore("thumbs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "id" });
        store.createIndex("byDate", "date", { unique: false });
        store.createIndex("byPerson", "personId", { unique: false });
        store.createIndex("byPersonDate", ["personId", "date"], { unique: false });
        // pending=true only while a row is in the outbox — the index lets the
        // camera screen count unsynced rows without scanning the whole store
        // (which carries capturedPhotos; UNIFIED-02 §8.4).
        store.createIndex("byPending", "pending", { unique: false });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    if (result instanceof IDBRequest) {
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(result.error);
    } else {
      result.then(resolve, reject);
    }
    t.onerror = () => reject(t.error);
  });
}

/** Full store read. Deliberately unrestricted — callers are responsible for
 * never calling this on `people` (large rows: descriptors + thumbnails). */
export async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.getAll());
}

/** Keys only — no values. The existence-check primitive for the `people`
 * store; getAll() there would pull every descriptor and thumbnail into
 * memory just to count. */
export async function getAllKeys(storeName: string): Promise<IDBValidKey[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.getAllKeys());
}

export async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  return reqToPromise(store.get(key));
}

export async function put<T>(storeName: string, value: T): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.put(value as any));
}

export async function del(storeName: string, key: IDBValidKey): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.delete(key));
}

export async function clear(storeName: string): Promise<void> {
  await tx(storeName, "readwrite", (store) => store.clear());
}

export async function getByIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  const db = await openDb();
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  const index = store.index(indexName);
  return reqToPromise(index.getAll(query));
}

/** Visit rows through an index one at a time — the low-memory alternative to
 * getAll() on a store whose rows are large (events carries base64
 * capturedPhotos). The visitor must be read-only with respect to this store:
 * the underlying transaction is readonly, so writes belong after the walk. */
export async function forEachByIndex<T>(
  storeName: string,
  indexName: string,
  visit: (row: T) => void | Promise<void>,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, "readonly");
    const index = t.objectStore(storeName).index(indexName);
    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      Promise.resolve(visit(cursor.value as T)).then(() => cursor.continue(), reject);
    };
    req.onerror = () => reject(req.error);
    t.onerror = () => reject(t.error);
  });
}
