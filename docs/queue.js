// Holds developed frames on the phone until they upload, so a bad signal
// at the party never loses a shot. Falls back to memory if IndexedDB is blocked.

const DB_NAME = 'roll';
const STORE = 'pending';
let dbPromise = null;
const memory = new Map();

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx(conn, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = conn.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export async function enqueue(item) {
  const conn = await db();
  if (!conn) { memory.set(item.id, item); return; }
  try { await tx(conn, 'readwrite', (s) => s.put(item)); }
  catch { memory.set(item.id, item); }
}

export async function all() {
  const conn = await db();
  let stored = [];
  if (conn) {
    try { stored = await tx(conn, 'readonly', (s) => s.getAll()); } catch {}
  }
  return [...stored, ...memory.values()].sort((a, b) => a.takenAt - b.takenAt);
}

async function remove(id) {
  memory.delete(id);
  const conn = await db();
  if (conn) {
    try { await tx(conn, 'readwrite', (s) => s.delete(id)); } catch {}
  }
}

let flushing = false;

// Uploads oldest first. Stops at the first failure and leaves the rest queued.
export async function flush(upload) {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of await all()) {
      try { await upload(item); } catch { break; }
      await remove(item.id);
    }
  } finally {
    flushing = false;
  }
}
