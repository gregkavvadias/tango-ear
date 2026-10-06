// Tiny persistence layer: IndexedDB key-value (for folder handles and the tag cache)
// and localStorage JSON (for settings, stats and manual artist mappings).

let dbp;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('tango-ear', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('tags');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)).catch(() => undefined),
  set: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)).catch(() => {}),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)).catch(() => {}),
  async getMany(store, keys) {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const t = d.transaction(store, 'readonly'), s = t.objectStore(store), out = new Map();
        for (const k of keys) { const r = s.get(k); r.onsuccess = () => r.result && out.set(k, r.result); }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      });
    } catch { return new Map(); }
  },
  async setMany(store, entries) {
    try {
      const d = await db();
      await new Promise((resolve, reject) => {
        const t = d.transaction(store, 'readwrite'), s = t.objectStore(store);
        for (const [k, v] of entries) s.put(v, k);
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    } catch {}
  },
};

export function load(key, fallback) {
  try {
    const v = localStorage.getItem('tango-ear:' + key);
    return v ? { ...fallback, ...JSON.parse(v) } : structuredClone(fallback);
  } catch { return structuredClone(fallback); }
}

export function save(key, value) {
  try { localStorage.setItem('tango-ear:' + key, JSON.stringify(value)); } catch {}
}
