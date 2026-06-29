// db.js — IndexedDB 永続化レイヤ(薄いPromiseラッパ)
// ストア: presets(プロンプトのプリセット), history(生成履歴),
//         customTags(ユーザー追加タグ), favorites(タグセット),
//         customCategories(ユーザー定義カテゴリ), settings(アプリ設定), meta(雑多)
//
// スキーマ version 3 (G0):
//   - favorites: group(所属グループID|null) / order(手動並べ替え) / pinned を追加
//   - customTags: cat(所属カテゴリID, 既定 'custom') を追加
//   - customCategories: {id, name, order} を新設(カスタムタグの振り分け先)
//   既存データは onupgradeneeded のマイグレーションで欠損なく既定値が入る。

const DB_NAME = 'nai-prompt-studio';
const DB_VERSION = 3;
const STORES = {
  presets:          { keyPath: 'id' },
  history:          { keyPath: 'id' },
  customTags:       { keyPath: 'id' },
  customCategories: { keyPath: 'id' },   // ユーザー定義のカスタムタグ・カテゴリ
  favorites:        { keyPath: 'id' },   // 複数タグのお気に入り(タグセット)
  favGroups:        { keyPath: 'id' },   // お気に入りのグループ(フォルダ)
  settings:         { keyPath: 'key' },
  meta:             { keyPath: 'key' },
};

// カスタムタグの既定カテゴリ(customCategories に存在しない固定の受け皿)
export const DEFAULT_CUSTOM_CAT = 'custom';

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const txn = req.transaction; // versionchange トランザクション
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          if (name === 'history') store.createIndex('createdAt', 'createdAt');
          if (name === 'presets') store.createIndex('updatedAt', 'updatedAt');
        }
      }
      // v3 へのマイグレーション: 既存レコードへ新フィールドの既定値を補完
      if (ev.oldVersion < 3) migrateToV3(txn);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// v3: favorites に group/order/pinned、customTags に cat を既定補完
function migrateToV3(txn) {
  try {
    backfill(txn, 'favorites', (rec, i) => {
      if (rec.group === undefined) rec.group = null;
      if (rec.order === undefined) rec.order = i;
      if (rec.pinned === undefined) rec.pinned = false;
      return rec;
    });
    backfill(txn, 'customTags', (rec) => {
      if (rec.cat === undefined) rec.cat = DEFAULT_CUSTOM_CAT;
      return rec;
    });
  } catch (e) { /* 失敗してもアプリ側のレイジー既定で吸収 */ }
}
function backfill(txn, storeName, fn) {
  if (!txn.objectStoreNames.contains(storeName)) return;
  const store = txn.objectStore(storeName);
  let i = 0;
  const cur = store.openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    const updated = fn({ ...c.value }, i++);
    c.update(updated);
    c.continue();
  };
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
