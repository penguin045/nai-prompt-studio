// db.js — IndexedDB 永続化レイヤ(薄いPromiseラッパ)
// ストア: presets(プロンプトのプリセット), history(生成履歴),
//         customTags(ユーザー追加タグ), settings(アプリ設定), meta(雑多)

const DB_NAME = 'nai-prompt-studio';
const DB_VERSION = 1;
const STORES = {
  presets:    { keyPath: 'id' },
  history:    { keyPath: 'id' },
  customTags: { keyPath: 'id' },
  settings:   { keyPath: 'key' },
  meta:       { keyPath: 'key' },
};

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          if (name === 'history') store.createIndex('createdAt', 'createdAt');
          if (name === 'presets') store.createIndex('updatedAt', 'updatedAt');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function put(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = tx(db, store, 'readwrite').put(value);
    r.onsuccess = () => resolve(value);
    r.onerror = () => reject(r.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = tx(db, store, 'readonly').get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

export async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = tx(db, store, 'readonly').getAll();
    r.onsuccess = () => resolve(r.result ?? []);
    r.onerror = () => reject(r.error);
  });
}

export async function del(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = tx(db, store, 'readwrite').delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function clear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = tx(db, store, 'readwrite').clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// 全ストアをまとめて取得(エクスポート用)
export async function dumpAll() {
  const out = {};
  for (const name of Object.keys(STORES)) {
    out[name] = await getAll(name);
  }
  return out;
}

// 全ストアへまとめて書き込み(インポート用)。merge=false で置換。
export async function loadAll(data, { merge = true } = {}) {
  const db = await openDB();
  const names = Object.keys(STORES);
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    for (const name of names) {
      const store = t.objectStore(name);
      if (!merge) store.clear();
      const rows = data[name];
      if (Array.isArray(rows)) for (const row of rows) store.put(row);
    }
  });
}

// シンプルなID生成(crypto優先)
export function uid(prefix = '') {
  const r = (crypto?.randomUUID?.() ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)));
  return prefix ? `${prefix}_${r}` : r;
}

export const STORE_NAMES = Object.keys(STORES);
