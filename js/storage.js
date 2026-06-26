// storage.js — ブラウザ外永続化レイヤ
// 要件「ブラウザデータ以外でデータを永続化する手段」を満たす。
//
// 提供する手段(環境に応じてフォールバック):
//   1) File System Access API: 実ファイル(JSON)へ直接 保存/読込。
//      ファイルハンドルを IndexedDB(meta)に保持し、ワンクリック上書き保存・
//      自動バックアップが可能。← ブラウザ管理ストレージの外(ユーザーのファイル)。
//   2) 非対応ブラウザ: <a download> エクスポート / <input type=file> インポート。

import { dumpAll, loadAll, get as dbGet, put as dbPut } from './db.js';

const SCHEMA = 'nai-prompt-studio';
const SCHEMA_VERSION = 1;
const HANDLE_KEY = 'fileHandle';
const AUTOSAVE_KEY = 'autoSave';

export const supportsFS = typeof window !== 'undefined' &&
  'showSaveFilePicker' in window && 'showOpenFilePicker' in window;

// ---- スナップショット(エクスポートする論理データ) ----
export async function buildSnapshot() {
  const data = await dumpAll();
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

function validateSnapshot(obj) {
  if (!obj || obj.schema !== SCHEMA || typeof obj.data !== 'object') {
    throw new Error('対応していないバックアップ形式です');
  }
  return obj;
}

// ---- File System Access API ルート ----

async function getStoredHandle() {
  const rec = await dbGet('meta', HANDLE_KEY);
  return rec?.handle ?? null;
}

async function storeHandle(handle) {
  await dbPut('meta', { key: HANDLE_KEY, handle });
}

async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// 新規にファイルを選んで保存先として確定
export async function chooseSaveFile() {
  if (!supportsFS) throw new Error('このブラウザは直接保存に未対応です');
  const handle = await window.showSaveFilePicker({
    suggestedName: `nai-prompt-studio_${stamp()}.json`,
    types: [{ description: 'NAI Prompt Studio Data', accept: { 'application/json': ['.json'] } }],
  });
  await storeHandle(handle);
  await saveToHandle(handle);
  return handle.name;
}

// 既存ファイルを保存先として開く(以後そこへ上書き)
export async function linkExistingFile() {
  if (!supportsFS) throw new Error('このブラウザは直接保存に未対応です');
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: 'NAI Prompt Studio Data', accept: { 'application/json': ['.json'] } }],
  });
  await storeHandle(handle);
  return handle.name;
}

async function saveToHandle(handle) {
  if (!(await ensurePermission(handle, 'readwrite'))) {
    throw new Error('ファイルへの書き込み許可が必要です');
  }
  const snap = await buildSnapshot();
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(snap, null, 2));
  await writable.close();
  await dbPut('meta', { key: 'lastSavedAt', value: snap.exportedAt });
  return snap.exportedAt;
}

// 確定済みのファイルへ上書き保存(なければ false)
export async function saveToLinkedFile() {
  const handle = await getStoredHandle();
  if (!handle) return false;
  await saveToHandle(handle);
  return true;
}

// 確定済みファイルから読込
export async function loadFromLinkedFile({ merge = false } = {}) {
  const handle = await getStoredHandle();
  if (!handle) return false;
  if (!(await ensurePermission(handle, 'read'))) {
    throw new Error('ファイルの読み込み許可が必要です');
  }
  const file = await handle.getFile();
  const text = await file.text();
  const snap = validateSnapshot(JSON.parse(text));
  await loadAll(snap.data, { merge });
  return true;
}

export async function getLinkedFileName() {
  const handle = await getStoredHandle();
  return handle?.name ?? null;
}

export async function unlinkFile() {
  await dbPut('meta', { key: HANDLE_KEY, handle: null });
}

// ---- ダウンロード / アップロード フォールバック ----

export async function exportDownload() {
  const snap = await buildSnapshot();
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nai-prompt-studio_${stamp()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return a.download;
}

export async function importFromFileObject(file, { merge = false } = {}) {
  const text = await file.text();
  const snap = validateSnapshot(JSON.parse(text));
  await loadAll(snap.data, { merge });
  return snap;
}

// <input type=file> を動的に開いてインポート
export function importViaDialog({ merge = false } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try { resolve(await importFromFileObject(file, { merge })); }
      catch (e) { reject(e); }
    };
    input.click();
  });
}

// ---- 自動保存設定 ----
export async function setAutoSave(enabled) {
  await dbPut('meta', { key: AUTOSAVE_KEY, value: !!enabled });
}
export async function getAutoSave() {
  const rec = await dbGet('meta', AUTOSAVE_KEY);
  return !!rec?.value;
}

// 自動保存: 確定ファイルがあり autoSave が有効なら上書き保存
let _autoSaveTimer = null;
export function scheduleAutoSave(delay = 1500) {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    try {
      if (await getAutoSave()) await saveToLinkedFile();
    } catch (e) { console.warn('autoSave failed', e); }
  }, delay);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
