// app.js — NAI Prompt Studio コントローラ(V4.5対応 / マルチキャラ)
import CATEGORIES, { QUALITY_PRESETS, MODELS, DEFAULT_MODEL, getModel, flattenTags, searchTags } from './tags.js';
import { buildAll, parsePromptText, bumpWeight, setWeight, findDuplicateIds, renderTag } from './prompt.js';
import { normalizeKey, splitTags } from './dedup.js';
import * as db from './db.js';
import * as store from './storage.js';
import { readNaiFromFile } from './naimeta.js';
import { exportPngText, exportPngStealth, exportNaiJson } from './metaexport.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- 状態 ----
const state = {
  model: DEFAULT_MODEL,
  weightMode: 'numeric',
  settings: { dedup: true, keep: 'strongest', crossDup: true },
  base: { positive: [], negative: [] },
  characters: [],          // {id, name, positive:[], negative:[], position:{x,y}|null, aiChoice}
  customTags: [],
  customCategories: [],    // {id, name, order} ユーザー定義カテゴリ(G6)
  params: null,            // 生成パラメータ(G3): {seed,steps,scale,sampler,width,height,...}|null
};
const libOpen = {};        // カテゴリ <details> の開閉状態(G7: 永続化)
let libOrder = [];         // 組み込みカテゴリの表示順(G7: 並べ替え/先頭固定)
let bulkMode = false;      // 一括選択モード(G10)
const bulkSel = new Set(); // 選択中タグの id
let activeBox = { box: 'base', field: 'positive' };

// ---- Undo/Redo(G1): 編集状態のスナップショット履歴 ----
const clone = (o) => JSON.parse(JSON.stringify(o));
const undoMgr = { stack: [], idx: -1, restoring: false, t: 0, MAX: 120 };
function snapshotState() {
  return clone({ model: state.model, weightMode: state.weightMode,
    settings: state.settings, base: state.base, characters: state.characters, params: state.params });
}
function recordHistory(coalesce = false) {
  if (undoMgr.restoring) return;
  const snap = snapshotState();
  const cur = undoMgr.stack[undoMgr.idx];
  if (cur && JSON.stringify(cur) === JSON.stringify(snap)) return;
  const now = Date.now();
  if (coalesce && undoMgr.idx >= 0 && now - undoMgr.t < 500) {
    undoMgr.stack[undoMgr.idx] = snap;           // 連続入力は1ステップにまとめる
  } else {
    undoMgr.stack = undoMgr.stack.slice(0, undoMgr.idx + 1);
    undoMgr.stack.push(snap);
    undoMgr.idx = undoMgr.stack.length - 1;
    if (undoMgr.stack.length > undoMgr.MAX) { undoMgr.stack.shift(); undoMgr.idx--; }
  }
  undoMgr.t = now;
  updateUndoButtons();
}
// スナップショットを state に流し込み(Undo/履歴復元 共通)
function loadSnapshotIntoState(snap) {
  const s = clone(snap);
  state.model = s.model; state.weightMode = s.weightMode;
  Object.assign(state.settings, s.settings || {});
  state.base = s.base || { positive: [], negative: [] };
  state.characters = s.characters || [];
  state.params = s.params || null; ensureParams();
  if (activeBox.box !== 'base' && !getChar(activeBox.box)) activeBox = { box: 'base', field: 'positive' };
  $('#setWeightMode').value = state.weightMode;
}
function rerenderEditorAll() { buildModelOptions(); renderEditor(); renderParams(); updateOutput(); }
function applyHistory(snap) {
  undoMgr.restoring = true;
  loadSnapshotIntoState(snap);
  rerenderEditorAll();
  undoMgr.restoring = false;
  updateSaveStatus('dirty'); saveWorkspace(); updateUndoButtons();
}
function doUndo() {
  if (undoMgr.idx <= 0) { toast('これ以上戻せません'); return; }
  undoMgr.idx--; applyHistory(undoMgr.stack[undoMgr.idx]); toast('元に戻しました');
}
function doRedo() {
  if (undoMgr.idx >= undoMgr.stack.length - 1) { toast('やり直す操作がありません'); return; }
  undoMgr.idx++; applyHistory(undoMgr.stack[undoMgr.idx]); toast('やり直しました');
}
function updateUndoButtons() {
  const u = $('#btnUndo'), r = $('#btnRedo');
  if (u) u.disabled = undoMgr.idx <= 0;
  if (r) r.disabled = undoMgr.idx >= undoMgr.stack.length - 1;
}

// ---- 生成パラメータ(G3) ----
const DEFAULT_PARAMS = { seed: null, steps: 28, scale: 5, cfg_rescale: 0,
  sampler: 'k_euler_ancestral', noise_schedule: 'karras', width: 832, height: 1216 };
const SAMPLERS = ['k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m',
  'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'k_dpm_2', 'k_dpm_2_ancestral', 'ddim_v3'];
const NOISE_SCHEDULES = ['native', 'karras', 'exponential', 'polyexponential'];
const RES_PRESETS = [
  { label: 'Portrait 832×1216', w: 832, h: 1216 },
  { label: 'Landscape 1216×832', w: 1216, h: 832 },
  { label: 'Square 1024×1024', w: 1024, h: 1024 },
  { label: 'L-Portrait 1024×1536', w: 1024, h: 1536 },
  { label: 'L-Landscape 1536×1024', w: 1536, h: 1024 },
];
// NAIの生JSONから編集対象パラメータを抽出
function extractGenParams(p) {
  if (!p || typeof p !== 'object') return null;
  const num = (v, d) => (v == null || v === '' || isNaN(+v)) ? d : +v;
  return {
    seed: (p.seed != null && p.seed !== '') ? Math.round(+p.seed) : null,
    steps: num(p.steps, DEFAULT_PARAMS.steps),
    scale: num(p.scale, DEFAULT_PARAMS.scale),
    cfg_rescale: num(p.cfg_rescale, DEFAULT_PARAMS.cfg_rescale),
    sampler: p.sampler || DEFAULT_PARAMS.sampler,
    noise_schedule: p.noise_schedule || DEFAULT_PARAMS.noise_schedule,
    width: num(p.width, DEFAULT_PARAMS.width),
    height: num(p.height, DEFAULT_PARAMS.height),
  };
}
function ensureParams() { if (!state.params) state.params = { ...DEFAULT_PARAMS }; }
function paramsSummary(p) {
  if (!p) return '';
  return `${p.width}×${p.height} · ${p.steps}st · CFG ${p.scale} · ${p.sampler}${p.seed != null ? ` · seed ${p.seed}` : ' · seed ランダム'}`;
}

let boxesHost, outPipe, boxOutputs;

init().catch(err => { console.error(err); toast('初期化に失敗: ' + err.message); });

async function init() {
  boxesHost = $('#editorBoxes'); outPipe = $('#outPipe'); boxOutputs = $('#boxOutputs');
  await loadWorkspace();
  buildModelOptions();
  buildQualityOptions();
  renderLibrary();
  renderFavorites();
  renderEditor();
  renderParams();
  updateOutput();
  wireGlobal();
  wireEditorDelegation();
  enableCustomTagDrag();
  wireParams();
  wireOutput();
  wireDialogs();
  wireFavEditor();
  wireNav();
  await refreshLinkedFileUI();
  registerSW();
  recordHistory();   // 初期状態を Undo 履歴の起点に(G1)
  updateSaveStatus('saved');
}

// ============ 永続化 ============
async function loadWorkspace() {
  const ws = await db.get('settings', 'workspace');
  if (ws?.value) applyWorkspace(ws.value);
  ensureParams();
  state.customTags = await db.getAll('customTags');
  state.customCategories = await db.getAll('customCategories');
  const lo = await db.get('settings', 'libOpen'); if (lo?.value) Object.assign(libOpen, lo.value);
  const ord = await db.get('settings', 'libOrder'); if (Array.isArray(ord?.value)) libOrder = ord.value;
  $('#setDedup').checked = state.settings.dedup;
  $('#setCrossDup').checked = state.settings.crossDup !== false;
  $('#setKeep').value = state.settings.keep;
  $('#setWeightMode').value = state.weightMode;
  $('#autoSaveToggle').checked = await store.getAutoSave();
}

function applyWorkspace(v) {
  // 旧形式(positive/negative直下)からの移行
  if (v.positive || v.negative) {
    state.base = { positive: v.positive || [], negative: v.negative || [] };
  } else {
    state.base = v.base || { positive: [], negative: [] };
  }
  state.characters = (v.characters || []).map(normalizeChar);
  state.model = v.model || DEFAULT_MODEL;
  state.weightMode = v.weightMode || getModel(state.model).weightMode;
  Object.assign(state.settings, v.settings || {});
  state.params = v.params ? { ...DEFAULT_PARAMS, ...v.params } : null;
  ensureParams();
  // weight移行(旧level → weight)
  migrateItems(state.base.positive); migrateItems(state.base.negative);
  state.characters.forEach(c => { migrateItems(c.positive); migrateItems(c.negative); });
}
function migrateItems(arr) {
  for (const it of (arr || [])) {
    if (it.weight == null && it.level != null) it.weight = Math.round((1 + it.level * 0.05) * 100) / 100;
    if (it.weight == null) it.weight = 1;
  }
}
function normalizeChar(c) {
  return { id: c.id || db.uid('c'), name: c.name || '', positive: c.positive || [], negative: c.negative || [],
    position: c.position || null, aiChoice: c.aiChoice !== false };
}

const saveWorkspace = debounce(async () => {
  await db.put('settings', { key: 'workspace', value: {
    model: state.model, weightMode: state.weightMode, settings: state.settings,
    base: state.base, characters: state.characters, params: state.params,
  }});
  store.scheduleAutoSave();
}, 400);

function markDirty(coalesce = false) { updateSaveStatus('dirty'); recordHistory(coalesce); saveWorkspace(); }

// ---- 生成パラメータ UI(G3) ----
function renderParams() {
  const host = $('#paramsHost'); if (!host) return;
  const p = state.params || DEFAULT_PARAMS;
  const open = host.dataset.open === '1';
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  host.innerHTML = `
  <details class="params-box"${open ? ' open' : ''}>
    <summary><span class="params-title">⚙ 生成パラメータ</span><span class="params-sum">${esc(paramsSummary(p))}</span></summary>
    <div class="params-grid">
      <label class="pfield seed">Seed
        <span class="seed-row">
          <input type="number" data-p="seed" value="${p.seed ?? ''}" placeholder="ランダム" autocomplete="off">
          <button type="button" class="mini-btn" data-pact="randseed" title="ランダムなseed">🎲</button>
          <button type="button" class="mini-btn" data-pact="clearseed" title="クリア(ランダム)">✕</button>
        </span>
      </label>
      <label class="pfield">Steps <input type="number" min="1" max="50" data-p="steps" value="${p.steps}"></label>
      <label class="pfield">CFG (scale) <input type="number" step="0.1" data-p="scale" value="${p.scale}"></label>
      <label class="pfield">CFG Rescale <input type="number" step="0.05" min="0" max="1" data-p="cfg_rescale" value="${p.cfg_rescale}"></label>
      <label class="pfield">Sampler <select data-p="sampler">${SAMPLERS.map(s => opt(s, p.sampler)).join('')}</select></label>
      <label class="pfield">Noise <select data-p="noise_schedule">${NOISE_SCHEDULES.map(s => opt(s, p.noise_schedule)).join('')}</select></label>
      <label class="pfield">幅 <input type="number" step="64" min="64" data-p="width" value="${p.width}"></label>
      <label class="pfield">高さ <input type="number" step="64" min="64" data-p="height" value="${p.height}"></label>
    </div>
    <div class="res-presets">${RES_PRESETS.map((r, i) => `<button type="button" class="mini-btn" data-pact="res" data-i="${i}">${esc(r.label)}</button>`).join('')}</div>
  </details>`;
}
function updateParamsSummary() { const el = $('#paramsHost .params-sum'); if (el) el.textContent = paramsSummary(state.params); }
function wireParams() {
  const host = $('#paramsHost'); if (!host) return;
  host.addEventListener('toggle', (e) => {
    const d = e.target.closest('details'); if (d) host.dataset.open = d.open ? '1' : '0';
  }, true);
  host.addEventListener('input', (e) => {
    const f = e.target.closest('[data-p]'); if (!f || f.tagName === 'SELECT') return;
    ensureParams();
    const key = f.dataset.p; const raw = f.value;
    if (key === 'seed') state.params.seed = raw === '' ? null : Math.round(+raw);
    else if (['steps', 'width', 'height'].includes(key)) state.params[key] = raw === '' ? DEFAULT_PARAMS[key] : Math.round(+raw);
    else state.params[key] = raw === '' ? DEFAULT_PARAMS[key] : +raw;
    updateParamsSummary(); markDirty(true);
  });
  host.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-p]'); if (!sel) return;
    ensureParams(); state.params[sel.dataset.p] = sel.value; updateParamsSummary(); markDirty();
  });
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pact]'); if (!b) return;
    ensureParams();
    const act = b.dataset.pact;
    if (act === 'randseed') state.params.seed = Math.floor(Math.random() * 4294967295);
    else if (act === 'clearseed') state.params.seed = null;
    else if (act === 'res') { const r = RES_PRESETS[+b.dataset.i]; state.params.width = r.w; state.params.height = r.h; }
    else return;
    renderParams(); markDirty();
  });
}
function updateSaveStatus(kind) {
  const el = $('#saveStatus'); el.className = 'save-status ' + (kind || '');
  el.textContent = kind === 'dirty' ? '未保存' : kind === 'saved' ? '保存済' : '—';
}

// ============ モデル / 品質プリセット ============
function buildModelOptions() {
  const sel = $('#modelSelect');
  sel.innerHTML = MODELS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  sel.value = state.model;
}
// 品質プリセットを現在のモデルで絞り込み(G13: QUALITY_PRESETS.models を使用)
function buildQualityOptions() {
  const sel = $('#qualityPreset'); const cur = sel.value;
  sel.innerHTML = '<option value="">— なし —</option>';
  for (const [k, v] of Object.entries(QUALITY_PRESETS)) {
    if (v.models && !v.models.includes(state.model)) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function onModelChange(id) {
  state.model = id;
  state.weightMode = getModel(id).weightMode;
  $('#setWeightMode').value = state.weightMode;
  buildQualityOptions();   // モデル連動で品質プリセットを絞り込み
  renderEditor(); updateOutput(); markDirty();
}
function applyQuality() {
  const k = $('#qualityPreset').value;
  if (!k) { toast('プリセットを選択してください'); return; }
  const p = QUALITY_PRESETS[k];
  // 破壊的置換を避け、先頭へ追加(重複は最終出力のdedupで解消)。Undoで取り消し可。
  state.base.positive = [...parsePromptText(p.positive), ...state.base.positive];
  state.base.negative = [...parsePromptText(p.negative), ...state.base.negative];
  renderEditor(); updateOutput(); markDirty();
  toast(`「${p.label}」をベースへ追加(Ctrl+Zで取消)`);
}

// ============ ライブラリ(折りたたみ式カテゴリ / カスタムカテゴリ G6+G7)============
function renderLibrary(query = '') {
  const host = $('#categoryList');
  const flat = flattenTags(CATEGORIES, state.customTags);
  if (query) {
    const hits = searchTags(query, flat);
    host.innerHTML = `<div class="category-jump-result"><div class="category-title">検索結果 (${hits.length})</div>
      <div class="tag-chips">${hits.map(libChip).join('') || '<span class="cat-empty">該当なし</span>'}</div></div>`;
    return;
  }
  let html = '';
  const byKey = new Map(CATEGORIES.map(c => ['b_' + c.id, c]));
  for (const key of orderedBuiltin()) {
    const cat = byKey.get(key); if (!cat) continue;
    const headBtns = `<span class="cat-actions">
      <button class="cat-mini" data-libcat="pin" data-key="${key}" title="先頭へ固定">📌</button>
      <button class="cat-mini" data-libcat="up" data-key="${key}" title="上へ">↑</button>
      <button class="cat-mini" data-libcat="down" data-key="${key}" title="下へ">↓</button></span>`;
    html += catDetails(key, cat.name, cat.tags.map(libChip).join(''), { headBtns });
  }
  html += renderCustomSection();
  host.innerHTML = html;
  populateCatJump();
}
// 組み込みカテゴリの表示順(保存順 + 新規カテゴリを末尾補完)
function builtinKeys() { return CATEGORIES.map(c => 'b_' + c.id); }
function orderedBuiltin() {
  const valid = builtinKeys();
  const ord = libOrder.filter(k => valid.includes(k));
  for (const k of valid) if (!ord.includes(k)) ord.push(k);
  return ord;
}
const saveLibOrder = debounce(() => db.put('settings', { key: 'libOrder', value: libOrder }), 300);
function libCatMove(key, act) {
  const ord = orderedBuiltin(); const i = ord.indexOf(key); if (i < 0) return;
  if (act === 'pin') { ord.splice(i, 1); ord.unshift(key); }
  else if (act === 'up' && i > 0) { [ord[i - 1], ord[i]] = [ord[i], ord[i - 1]]; }
  else if (act === 'down' && i < ord.length - 1) { [ord[i + 1], ord[i]] = [ord[i], ord[i + 1]]; }
  else return;
  libOrder = ord; saveLibOrder(); renderLibrary($('#tagSearch').value);
}
function populateCatJump() {
  const sel = $('#catJump'); if (!sel) return;
  const opts = ['<option value="">カテゴリへ移動…</option>'];
  for (const key of orderedBuiltin()) { const c = CATEGORIES.find(x => 'b_' + x.id === key); if (c) opts.push(`<option value="${key}">${esc(c.name)}</option>`); }
  opts.push('<option value="c_custom">カスタム</option>');
  for (const cc of [...state.customCategories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) opts.push(`<option value="c_${esc(cc.id)}">${esc(cc.name)}</option>`);
  sel.innerHTML = opts.join('');
}
function jumpToCategory(key) {
  if (!key) return;
  const d = $(`.category[data-catkey="${CSS.escape(key)}"]`); if (!d) return;
  d.open = true; onLibToggle(key, true);
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setAllCategories(open) {
  $$('.category[data-catkey]').forEach(d => { d.open = open; libOpen[d.dataset.catkey] = open; });
  saveLibOpen();
}
// カテゴリ <details>。開閉状態は libOpen に保持(既定: 開)
function catDetails(key, name, chipsHtml, opts = {}) {
  const open = libOpen[key] !== false;
  const dropAttr = opts.dropcat ? ` data-customcat="${esc(opts.dropcat)}"` : '';
  return `<details class="category" data-catkey="${esc(key)}"${open ? ' open' : ''}>
    <summary class="category-title"><span class="cat-name">${esc(name)}</span>${opts.headBtns || ''}</summary>
    <div class="tag-chips"${dropAttr}>${chipsHtml || '<span class="cat-empty">(空)</span>'}</div>
  </details>`;
}
function renderCustomSection() {
  const cats = [...state.customCategories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const byCat = (cid) => state.customTags.filter(c => (c.cat || db.DEFAULT_CUSTOM_CAT) === cid);
  let html = `<div class="custom-head"><span class="category-title">カスタムタグ</span>
    <button class="ghost-btn xs" data-libact="addcat" title="カスタムカテゴリを追加">＋カテゴリ</button></div>`;
  html += catDetails('c_custom', 'カスタム', byCat(db.DEFAULT_CUSTOM_CAT).map(customChip).join(''), { dropcat: db.DEFAULT_CUSTOM_CAT });
  for (const cat of cats) {
    const headBtns = `<span class="cat-actions">
      <button class="cat-mini" data-catact="rename" data-cid="${esc(cat.id)}" title="名前変更">✎</button>
      <button class="cat-mini" data-catact="del" data-cid="${esc(cat.id)}" title="削除">✕</button></span>`;
    html += catDetails('c_' + cat.id, cat.name, byCat(cat.id).map(customChip).join(''), { dropcat: cat.id, headBtns });
  }
  return html;
}
function libChip(t) {
  if (t.custom) return customChip({ t: t.t, j: t.j, id: t.id });
  return `<button class="lib-chip" data-tag="${esc(t.t)}" title="${esc(t.t)}">
    <span class="ja">${esc(t.j || t.t)}</span>${t.j ? `<span class="en">${esc(t.t)}</span>` : ''}</button>`;
}
function customChip(c) {
  return `<span class="lib-chip custom" data-tag="${esc(c.t)}" data-cid="${esc(c.id)}" title="${esc(c.t)}">
    <span class="lib-grip" title="ドラッグでカテゴリ移動">⠿</span>
    <span class="ja">${esc(c.j || c.t)}</span>
    <button class="lib-del" data-cid="${esc(c.id)}" title="削除">✕</button></span>`;
}

// ---- カスタムカテゴリ CRUD ----
async function addCustomCategory() {
  const name = prompt('カスタムカテゴリ名'); if (!name || !name.trim()) return;
  const all = await db.getAll('customCategories');
  const maxOrder = all.reduce((m, c) => Math.max(m, c.order ?? 0), 0);
  const rec = { id: db.uid('cc'), name: name.trim(), order: maxOrder + 1 };
  state.customCategories.push(rec); await db.put('customCategories', rec);
  renderLibrary($('#tagSearch').value); toast(`カテゴリ「${rec.name}」を追加`);
}
async function renameCustomCategory(cid) {
  const rec = state.customCategories.find(c => c.id === cid); if (!rec) return;
  const name = prompt('カテゴリ名を変更', rec.name); if (name == null) return;
  rec.name = name.trim() || rec.name; await db.put('customCategories', rec); renderLibrary($('#tagSearch').value);
}
async function deleteCustomCategory(cid) {
  const rec = state.customCategories.find(c => c.id === cid); if (!rec) return;
  if (!confirm(`カテゴリ「${rec.name}」を削除しますか?(中のタグは「カスタム」へ移動)`)) return;
  state.customCategories = state.customCategories.filter(c => c.id !== cid);
  await db.del('customCategories', cid);
  for (const t of state.customTags.filter(t => t.cat === cid)) { t.cat = db.DEFAULT_CUSTOM_CAT; await db.put('customTags', t); }
  renderLibrary($('#tagSearch').value); toast('カテゴリを削除');
}
// カテゴリ開閉状態の永続化(G7)
const saveLibOpen = debounce(() => db.put('settings', { key: 'libOpen', value: libOpen }), 300);
function onLibToggle(key, open) { if (!key) return; libOpen[key] = open; saveLibOpen(); }

async function moveCustomTag(cid, cat) {
  const rec = state.customTags.find(c => c.id === cid);
  if (!rec || (rec.cat || db.DEFAULT_CUSTOM_CAT) === cat) return;
  rec.cat = cat; await db.put('customTags', rec); renderLibrary($('#tagSearch').value); toast('カテゴリを移動');
}

// ---- カスタムタグの D&D(カテゴリ間移動) ----
function enableCustomTagDrag() {
  const host = $('#categoryList');
  let chip = null, cid = null;
  const clearHover = () => host.querySelectorAll('[data-customcat].drop-hover').forEach(z => z.classList.remove('drop-hover'));
  host.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.lib-grip'); if (!grip) return;
    chip = grip.closest('.lib-chip.custom'); cid = chip?.dataset.cid; if (!chip) return;
    chip.setPointerCapture?.(e.pointerId); chip.classList.add('dragging'); e.preventDefault();
  });
  host.addEventListener('pointermove', (e) => {
    if (!chip) return;
    chip.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    chip.style.pointerEvents = '';
    clearHover();
    under?.closest?.('[data-customcat]')?.classList.add('drop-hover');
  });
  const end = async (e) => {
    if (!chip) return;
    chip.classList.remove('dragging');
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cat = under?.closest?.('[data-customcat]')?.dataset.customcat;
    clearHover(); chip = null;
    if (cat) await moveCustomTag(cid, cat);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
}
function wireGlobal() {
  $('#categoryList').addEventListener('click', (e) => {
    const addcat = e.target.closest('[data-libact="addcat"]');
    if (addcat) { e.preventDefault(); addCustomCategory(); return; }
    const catact = e.target.closest('[data-catact]');
    if (catact) {   // summary 内: 既定のトグルを抑止
      e.preventDefault(); e.stopPropagation();
      if (catact.dataset.catact === 'rename') renameCustomCategory(catact.dataset.cid);
      else deleteCustomCategory(catact.dataset.cid);
      return;
    }
    const libcat = e.target.closest('[data-libcat]');
    if (libcat) { e.preventDefault(); e.stopPropagation(); libCatMove(libcat.dataset.key, libcat.dataset.libcat); return; }
    const del = e.target.closest('.lib-del');
    if (del) { e.preventDefault(); deleteCustomTag(del.dataset.cid); return; }
    if (e.target.closest('.lib-grip')) return;   // ドラッグ用グリップはクリック追加しない
    const t = e.target.closest('[data-tag]');
    if (t) addTags(activeBox.box, activeBox.field, t.dataset.tag);
  });
  $('#categoryList').addEventListener('toggle', (e) => {
    const d = e.target.closest('details.category'); if (d) onLibToggle(d.dataset.catkey, d.open);
  }, true);
  $('#tagSearch').addEventListener('input', (e) => renderLibrary(e.target.value));
  $('#btnAddCustom').addEventListener('click', addCustomFromSearch);
  $('#catJump').addEventListener('change', (e) => { jumpToCategory(e.target.value); e.target.value = ''; });
  $('#btnExpandAll').addEventListener('click', () => setAllCategories(true));
  $('#btnCollapseAll').addEventListener('click', () => setAllCategories(false));
  $('#activeBoxSelect').addEventListener('change', (e) => {
    const [box, field] = e.target.value.split('::'); activeBox = { box, field }; highlightActiveField();
  });
  $('#btnBulkMode').addEventListener('click', toggleBulkMode);
  $('#bulkBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    bulkAction(b.dataset.bulk, $('#bulkMoveTarget')?.value);
  });
  $('#modelSelect').addEventListener('change', e => onModelChange(e.target.value));
  $('#btnApplyQuality').addEventListener('click', applyQuality);
  $('#btnAddChar').addEventListener('click', addCharacter);
  $('#btnLoadImage').addEventListener('click', importFromImage);
  $('#btnSaveFav').addEventListener('click', saveFavorite);
  $('#btnAddFavGroup').addEventListener('click', addFavGroup);
  $('#favSearch').addEventListener('input', (e) => { favState.query = e.target.value; renderFavorites(); });
  $('#favList').addEventListener('click', onFavClick);
  $('#btnUndo').addEventListener('click', doUndo);
  $('#btnRedo').addEventListener('click', doRedo);
  document.addEventListener('keydown', onGlobalKey);
}

function onGlobalKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  // テキスト編集中はブラウザ標準のUndoに任せる
  const t = e.target;
  const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.readOnly;
  if (editable && k === 'z' && !e.shiftKey) return;
  e.preventDefault();
  if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo(); else doUndo();
}

// ===== お気に入り(タグセット): グループ化・ピン・並べ替え・検索 (G6) =====
const favState = { query: '' };

async function renderFavorites() {
  const [favs, groups] = await Promise.all([db.getAll('favorites'), db.getAll('favGroups')]);
  favs.forEach((f, i) => { if (f.order == null) f.order = i; if (f.pinned == null) f.pinned = false; });
  groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const host = $('#favList');
  if (!favs.length) { host.innerHTML = `<div class="fav-empty">タグを入れて「＋保存」でまとめ登録</div>`; return; }
  const q = favState.query.trim().toLowerCase();
  const match = (f) => !q || (f.name || '').toLowerCase().includes(q) || (f.tags || '').toLowerCase().includes(q);
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
  const groupIds = new Set(groups.map(g => g.id));
  const vis = favs.filter(match);
  let html = '';
  const pinned = vis.filter(f => f.pinned).sort(byOrder);
  if (pinned.length) html += favBlock('pin', '📌 ピン留め', pinned, false);
  for (const g of groups) html += favBlock(g.id, g.name, vis.filter(f => !f.pinned && f.group === g.id).sort(byOrder), true);
  const ungrouped = vis.filter(f => !f.pinned && !groupIds.has(f.group)).sort(byOrder);
  if (ungrouped.length || groups.length) html += favBlock('none', groups.length ? 'その他' : '', ungrouped, false);
  host.innerHTML = html || `<div class="fav-empty">該当なし</div>`;
}
function favBlock(gid, label, items, manageable) {
  const head = label ? `<div class="fav-group-head" data-gid="${esc(gid)}">
    <span class="fav-group-name">${esc(label)} <em>${items.length}</em></span>
    ${manageable ? `<span class="fav-group-actions">
      <button class="fav-mini" data-gact="grename" title="グループ名を変更">✎</button>
      <button class="fav-mini" data-gact="gdel" title="グループを削除">✕</button></span>` : ''}
  </div>` : '';
  const chips = items.map(favChip).join('') || `<div class="fav-empty mini">(空)</div>`;
  return `<div class="fav-group">${head}<div class="fav-group-list">${chips}</div></div>`;
}
function favChip(f) {
  return `<span class="fav-chip${f.pinned ? ' pinned' : ''}" data-id="${f.id}" title="${esc(f.tags)}">
    <button class="fav-insert" data-fav="ins">★ ${esc(f.name)} <em>${f.count || 0}</em></button>
    <button class="fav-mini" data-fav="up" title="上へ">↑</button>
    <button class="fav-mini" data-fav="down" title="下へ">↓</button>
    <button class="fav-mini" data-fav="pin" title="${f.pinned ? 'ピン解除' : 'ピン留め'}">${f.pinned ? '📌' : '📍'}</button>
    <button class="fav-mini" data-fav="edit" title="編集">✎</button>
    <button class="fav-del" data-fav="del" title="削除">✕</button></span>`;
}
async function onFavClick(e) {
  const gact = e.target.closest('[data-gact]');
  if (gact) {
    const gid = gact.closest('.fav-group-head').dataset.gid;
    if (gact.dataset.gact === 'grename') await renameFavGroup(gid);
    else if (gact.dataset.gact === 'gdel') await deleteFavGroup(gid);
    return;
  }
  const chip = e.target.closest('.fav-chip'); if (!chip) return;
  const act = e.target.closest('[data-fav]')?.dataset.fav || 'ins';
  const f = await db.get('favorites', chip.dataset.id); if (!f) return;
  if (act === 'del') { if (confirm(`お気に入り「${f.name || ''}」を削除しますか?`)) { await db.del('favorites', f.id); renderFavorites(); toast('削除しました'); } return; }
  if (act === 'edit') { openFavEditor({ id: f.id, name: f.name, group: f.group, tagItems: splitTags(f.tags).map(t => ({ text: t, on: true })) }); return; }
  if (act === 'pin') { f.pinned = !f.pinned; await db.put('favorites', f); renderFavorites(); toast(f.pinned ? 'ピン留めしました' : 'ピンを解除'); return; }
  if (act === 'up' || act === 'down') { await reorderFav(f, act); return; }
  addTags(activeBox.box, activeBox.field, f.tags); toast(`「${f.name}」を ${activeBox.field === 'positive' ? 'ポジ' : 'ネガ'} へ挿入`);
}
async function reorderFav(f, dir) {
  const all = await db.getAll('favorites');
  const sibs = all.filter(x => !!x.pinned === !!f.pinned && (x.group || null) === (f.group || null))
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = sibs.findIndex(x => x.id === f.id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  const a = sibs[i], b = sibs[j];
  const ao = a.order ?? 0, bo = b.order ?? 0; a.order = bo; b.order = ao;
  await db.put('favorites', a); await db.put('favorites', b);
  renderFavorites();
}
async function addFavGroup() {
  const name = prompt('新しいグループ名'); if (!name || !name.trim()) return;
  const all = await db.getAll('favGroups');
  const maxOrder = all.reduce((m, g) => Math.max(m, g.order ?? 0), 0);
  await db.put('favGroups', { id: db.uid('g'), name: name.trim(), order: maxOrder + 1 });
  renderFavorites(); toast(`グループ「${name.trim()}」を追加`);
}
async function renameFavGroup(gid) {
  const g = await db.get('favGroups', gid); if (!g) return;
  const name = prompt('グループ名を変更', g.name); if (name == null) return;
  g.name = name.trim() || g.name; await db.put('favGroups', g); renderFavorites();
}
async function deleteFavGroup(gid) {
  const g = await db.get('favGroups', gid); if (!g) return;
  if (!confirm(`グループ「${g.name}」を削除しますか?(中のお気に入りは「その他」へ移動)`)) return;
  const favs = await db.getAll('favorites');
  for (const f of favs.filter(x => x.group === gid)) { f.group = null; await db.put('favorites', f); }
  await db.del('favGroups', gid); renderFavorites(); toast('グループを削除');
}

// 「＋保存」: 現在のボックスのタグを全選択状態でエディタを開く(不要分を外して保存)
function saveFavorite() {
  const arr = (getArr(activeBox.box, activeBox.field) || []).filter(i => i.enabled && i.base);
  const tagItems = arr.map(i => ({ text: renderTag(i, state.weightMode), on: true }));
  openFavEditor({ id: null, name: arr.slice(0, 3).map(i => i.base).join(', '), tagItems });
}

// ---- お気に入り編集ダイアログ ----
let favEdit = null;
function openFavEditor({ id = null, name = '', group = null, tagItems = [] }) {
  favEdit = { id, group, tags: tagItems.slice() };
  $('#favDialogTitle').textContent = id ? 'お気に入りを編集' : 'お気に入りを保存';
  $('#favName').value = name;
  $('#favAddInput').value = '';
  populateFavGroupSelect(group);
  renderFavPick();
  $('#favDialog').showModal();
}
async function populateFavGroupSelect(selId) {
  const el = $('#favGroupSelect'); if (!el) return;
  const groups = await db.getAll('favGroups'); groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  el.innerHTML = `<option value="">(グループなし)</option>` +
    groups.map(g => `<option value="${g.id}"${g.id === selId ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
}
function renderFavPick() {
  const host = $('#favTagPick');
  host.innerHTML = favEdit.tags.length
    ? favEdit.tags.map((t, i) => `<button type="button" class="pick-chip${t.on ? ' on' : ''}" data-i="${i}">${esc(t.text)}</button>`).join('')
    : `<div class="meta">タグなし。下の欄から追加できます</div>`;
}
function wireFavEditor() {
  $('#favTagPick').addEventListener('click', (e) => {
    const b = e.target.closest('.pick-chip'); if (!b) return;
    const t = favEdit.tags[+b.dataset.i]; t.on = !t.on; b.classList.toggle('on', t.on);
  });
  $('#favAddInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return; e.preventDefault();
    for (const p of splitTags(e.target.value)) favEdit.tags.push({ text: p, on: true });
    e.target.value = ''; renderFavPick();
  });
  $('#favCancelBtn').addEventListener('click', () => $('#favDialog').close());
  $('#favSaveBtn').addEventListener('click', saveFavFromDialog);
}
async function saveFavFromDialog() {
  const name = $('#favName').value.trim() || 'お気に入り';
  const tags = favEdit.tags.filter(t => t.on).map(t => t.text);
  if (!tags.length) { toast('タグを1つ以上選択してください'); return; }
  const group = $('#favGroupSelect')?.value || null;
  let rec;
  if (favEdit.id) {
    const prev = await db.get('favorites', favEdit.id) || {};
    rec = { ...prev, id: favEdit.id, name, tags: tags.join(', '), count: tags.length, group };
  } else {
    const all = await db.getAll('favorites');
    const maxOrder = all.reduce((m, f) => Math.max(m, f.order ?? 0), 0);
    rec = { id: db.uid('f'), name, tags: tags.join(', '), count: tags.length,
      group: group || null, order: maxOrder + 1, pinned: false, createdAt: new Date().toISOString() };
  }
  await db.put('favorites', rec);
  $('#favDialog').close(); renderFavorites(); toast(favEdit.id ? `「${name}」を更新` : `「${name}」を保存`);
}

// ===== カスタムタグ: 追加(画像/手動)・削除 =====
async function addTagsToLibrary(baseTags) {
  const keys = new Set(flattenTags(CATEGORIES, state.customTags).map(t => normalizeKey(t.t)));
  let added = 0;
  for (const raw of baseTags) {
    const t = String(raw || '').trim(); const k = normalizeKey(t);
    if (!t || !k || keys.has(k)) continue;
    keys.add(k);
    const rec = { id: db.uid('c'), t, j: '', cat: db.DEFAULT_CUSTOM_CAT };
    state.customTags.push(rec); await db.put('customTags', rec); added++;
  }
  if (added) renderLibrary($('#tagSearch').value);
  return added;
}
async function deleteCustomTag(id) {
  if (!id) return;
  state.customTags = state.customTags.filter(c => c.id !== id);
  await db.del('customTags', id);
  renderLibrary($('#tagSearch').value); toast('カスタムタグを削除');
}

// NAI生成PNGからプロンプト/キャラを読み込んで編集欄へ展開
function importFromImage() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg';
  input.onchange = async () => {
    const file = input.files?.[0]; if (!file) return;
    try {
      toast('画像を解析中…');
      const norm = await readNaiFromFile(file);
      if (norm.model) { state.model = norm.model; state.weightMode = getModel(norm.model).weightMode; $('#setWeightMode').value = state.weightMode; }
      const gp = extractGenParams(norm.params); if (gp) state.params = gp;   // 生成パラメータを保持(G2/G3)
      state.base = { positive: parsePromptText(norm.base.positive), negative: parsePromptText(norm.base.negative) };
      state.characters = norm.characters.map(c => ({
        id: db.uid('c'), name: c.name || '',
        positive: parsePromptText(c.positive), negative: parsePromptText(c.negative),
        position: c.position || null, aiChoice: c.aiChoice !== false,
      }));
      activeBox = { box: 'base', field: 'positive' };
      buildModelOptions(); renderEditor(); renderParams(); updateOutput(); markDirty();
      switchPanel('editor');
      // 読み込んだタグをライブラリ(カスタム)へ追加
      const imgTags = [...state.base.positive, ...state.characters.flatMap(c => c.positive)].map(i => i.base);
      const added = await addTagsToLibrary(imgTags);
      toast(`読込完了: ベース+キャラ${state.characters.length}人${norm.isV4 ? ' (V4形式)' : ''}${added ? ` / ライブラリに${added}件追加` : ''}`);
    } catch (e) { console.error(e); toast(e.message || '画像の読み込みに失敗しました'); }
  };
  input.click();
}
async function addCustomFromSearch() {
  const v = $('#tagSearch').value.trim();
  if (!v) { toast('検索欄にタグを入力してください'); return; }
  const rec = { id: db.uid('c'), t: v, j: '', cat: db.DEFAULT_CUSTOM_CAT };
  state.customTags.push(rec); await db.put('customTags', rec);
  $('#tagSearch').value = ''; renderLibrary(); toast(`カスタムタグ「${v}」を追加`);
}

// ============ 状態アクセス ============
function getArr(box, field) {
  if (box === 'base') return state.base[field];
  const c = state.characters.find(x => x.id === box);
  return c ? c[field] : null;
}
function getChar(box) { return state.characters.find(x => x.id === box); }

// ============ エディタ描画 ============
function renderEditor() {
  const m = getModel(state.model);
  let html = boxHTML('base', state.base, m.multichar ? 'ベースプロンプト(シーン・画風・人数)' : 'プロンプト', null, m);
  if (m.multichar) html += state.characters.map((c, i) => boxHTML(c.id, c, null, { c, i }, m)).join('');
  boxesHost.innerHTML = html;
  $('#btnAddChar').style.display = m.multichar ? '' : 'none';
  $('#btnAddChar').disabled = state.characters.length >= 6;
  $('#multicharHint').style.display = m.multichar ? '' : 'none';
  renderAllAreas();
  syncActiveLabel();
}

function boxHTML(box, data, title, charMeta, model) {
  const isChar = !!charMeta;
  let head;
  if (isChar) {
    const c = charMeta.c;
    head = `<div class="pbox-head char">
      <span class="char-grip" title="ドラッグで並べ替え">⋮⋮</span>
      <input class="char-name" data-charid="${c.id}" value="${esc(c.name)}" placeholder="キャラ${charMeta.i + 1}の名前(任意)">
      <button class="mini-btn pos-btn" data-act="pos" title="位置">⊞ 位置</button>
      <label class="ai-choice"><input type="checkbox" data-act="aichoice" ${c.aiChoice ? 'checked' : ''}>AIにおまかせ</label>
      <button class="mini-btn danger" data-act="rmchar" title="このキャラを削除">✕</button>
    </div>${positionGridHTML(c)}`;
  } else {
    head = `<div class="pbox-head"><h3>${esc(title)}</h3></div>`;
  }
  return `<div class="pbox${isChar ? ' is-char' : ''}" data-box="${box}">
    ${head}
    <div class="pbox-body">
      ${fieldHTML(box, 'positive', 'ポジティブ', isChar ? 'girl, blue eyes …(番号なし)' : 'タグを入力して Enter')}
      ${fieldHTML(box, 'negative', 'ネガティブ', '除外したいタグ(任意)')}
    </div>
  </div>`;
}
function fieldHTML(box, field, label, ph) {
  return `<div class="field-group" data-box="${esc(box)}" data-field="${field}">
    <label>${label}</label>
    <input class="tag-input" data-box="${box}" data-field="${field}" placeholder="${esc(ph)}" autocomplete="off">
    <div class="tag-area" data-box="${box}" data-field="${field}"></div>
  </div>`;
}
function positionGridHTML(c) {
  let cells = '';
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const sel = c.position && c.position.x === x && c.position.y === y ? ' sel' : '';
    cells += `<button class="pos-cell${sel}" data-act="poscell" data-x="${x}" data-y="${y}" tabindex="-1"></button>`;
  }
  return `<div class="pos-grid${c.aiChoice ? ' disabled' : ''}" data-charid="${c.id}" hidden>
    <div class="pos-grid-inner">${cells}</div>
    <div class="pos-cap">${c.position ? `位置 (${c.position.x + 1}, ${c.position.y + 1})` : '未指定'}</div>
  </div>`;
}

function renderAllAreas() {
  renderArea('base', 'positive'); renderArea('base', 'negative');
  for (const c of state.characters) { renderArea(c.id, 'positive'); renderArea(c.id, 'negative'); }
}
function areaEl(box, field) {
  return $$('.tag-area', boxesHost).find(el => el.dataset.box === box && el.dataset.field === field);
}
function renderArea(box, field) {
  const host = areaEl(box, field); if (!host) return;
  const items = getArr(box, field) || [];
  const dupIds = state.settings.dedup ? findDuplicateIds(items) : new Set();
  host.dataset.empty = field === 'positive' ? 'タグ未追加' : '(任意)';
  host.classList.toggle('empty', items.length === 0);
  host.innerHTML = items.map(it => tagChip(it, dupIds.has(it.id))).join('');
}
function tagChip(it, isDup) {
  const w = it.weight ?? 1;
  const wcls = w < 0 ? 'neg' : w < 1 - 1e-6 ? 'weak' : w > 1 + 1e-6 ? 'strong' : 'neutral';
  const wtxt = Math.round(w * 100) / 100;
  const sel = bulkSel.has(it.id);
  const check = bulkMode ? `<button class="bulk-check" data-act="bulkcheck" title="選択">${sel ? '☑' : '☐'}</button>` : '';
  return `<span class="tag${it.enabled ? '' : ' disabled'}${isDup ? ' dup' : ''}${sel ? ' selected' : ''}" data-id="${it.id}" tabindex="0" title="Alt+←/→で並べ替え / Enterで編集 / Deleteで削除">
    ${check}
    <span class="drag-grip" title="ドラッグで並べ替え">⠿</span>
    <span class="label" title="クリックで編集">${esc(it.base)}</span>
    <span class="wctl">
      <button class="tag-btn minus" data-act="minus" title="弱める">−</button>
      <button class="wval ${wcls}" data-act="wedit" title="重みを直接入力">${wtxt}</button>
      <button class="tag-btn plus" data-act="plus" title="強める">＋</button>
    </span>
    <button class="tag-btn" data-act="toggle" title="有効/無効">${it.enabled ? '◐' : '○'}</button>
    <button class="tag-btn rm" data-act="rm" title="削除">✕</button>
  </span>`;
}
// ---- 一括操作(G10)----
function findItemLoc(id) {
  for (const [box, field] of allBoxFields()) {
    const arr = getArr(box, field); const it = arr?.find(x => x.id === id);
    if (it) return { box, field, arr, it };
  }
  return null;
}
function toggleBulkMode() { bulkMode = !bulkMode; if (!bulkMode) bulkSel.clear(); renderEditor(); updateBulkBar(); }
function toggleBulkSel(id) {
  if (bulkSel.has(id)) bulkSel.delete(id); else bulkSel.add(id);
  const el = boxesHost.querySelector(`.tag[data-id="${CSS.escape(id)}"]`);
  if (el) { const on = bulkSel.has(id); el.classList.toggle('selected', on); const cb = el.querySelector('[data-act="bulkcheck"]'); if (cb) cb.textContent = on ? '☑' : '☐'; }
  updateBulkBar();
}
function bulkSelectAll() {
  bulkSel.clear();
  for (const [box, field] of allBoxFields()) for (const it of (getArr(box, field) || [])) bulkSel.add(it.id);
  renderEditor(); updateBulkBar();
}
function bulkAction(act, targetVal) {
  if (act === 'all') return bulkSelectAll();
  if (act === 'clear') { bulkSel.clear(); renderEditor(); updateBulkBar(); return; }
  if (!bulkSel.size) { toast('タグを選択してください'); return; }
  if (act === 'delete') {
    for (const id of bulkSel) { const l = findItemLoc(id); if (l) { const i = l.arr.findIndex(x => x.id === id); if (i >= 0) l.arr.splice(i, 1); } }
    bulkSel.clear(); afterBulk(); toast('選択タグを削除(Ctrl+Zで戻す)');
  } else if (act === 'enable' || act === 'disable') {
    const on = act === 'enable';
    for (const id of bulkSel) { const l = findItemLoc(id); if (l) l.it.enabled = on; }
    afterBulk(); toast(on ? '選択タグを有効化' : '選択タグを無効化');
  } else if (act === 'move') {
    const [tbox, tfield] = (targetVal || '').split('::'); const tarr = getArr(tbox, tfield);
    if (!tarr) { toast('移動先が無効です'); return; }
    const moving = [];
    for (const id of bulkSel) { const l = findItemLoc(id); if (l && !(l.box === tbox && l.field === tfield)) { const i = l.arr.findIndex(x => x.id === id); if (i >= 0) moving.push(l.arr.splice(i, 1)[0]); } }
    tarr.push(...moving); bulkSel.clear(); afterBulk(); toast(`${moving.length}件を移動`);
  }
}
function afterBulk() { renderEditor(); updateOutput(); markDirty(); updateBulkBar(); }
function updateBulkBar() {
  const bar = $('#bulkBar'); if (!bar) return;
  bar.hidden = !bulkMode;
  $('#btnBulkMode').classList.toggle('active', bulkMode);
  $('#btnBulkMode').textContent = bulkMode ? '☑ 一括選択中' : '☑ 一括選択';
  $('#bulkCount').textContent = `${bulkSel.size}件`;
  const sel = $('#bulkMoveTarget');
  if (sel) { const cur = sel.value; sel.innerHTML = activeBoxOptions().map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); if (cur) sel.value = cur; }
}

// チップ内インライン編集(タグ文字列 / 重み直接入力)G9
function startInlineEdit(box, field, id) {
  const arr = getArr(box, field); const it = arr?.find(x => x.id === id); if (!it) return;
  const tagEl = areaEl(box, field)?.querySelector(`.tag[data-id="${CSS.escape(id)}"]`); if (!tagEl) return;
  const label = tagEl.querySelector('.label'); if (!label) return;
  const input = document.createElement('input');
  input.className = 'tag-edit'; input.value = it.base; input.size = Math.max(4, it.base.length);
  label.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = input.value.trim(); if (v && v !== it.base) { it.base = v; markDirty(); } }
    renderArea(box, field); updateOutput();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  input.addEventListener('blur', () => commit(true));
}
function startWeightEdit(box, field, id) {
  const arr = getArr(box, field); const it = arr?.find(x => x.id === id); if (!it) return;
  const wval = areaEl(box, field)?.querySelector(`.tag[data-id="${CSS.escape(id)}"] .wval`); if (!wval) return;
  const input = document.createElement('input');
  input.type = 'number'; input.step = '0.05'; input.className = 'wedit-input'; input.value = String(it.weight ?? 1);
  wval.replaceWith(input); input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = parseFloat(input.value); if (!isNaN(v)) { Object.assign(it, setWeight(it, v)); markDirty(); } }
    renderArea(box, field); updateOutput();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } });
  input.addEventListener('blur', () => commit(true));
}

// ============ エディタ操作(委譲) ============
function wireEditorDelegation() {
  boxesHost.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.tag-input'); if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); addTags(inp.dataset.box, inp.dataset.field, inp.value); inp.value = ''; }
  });
  // チップにフォーカス時のキーボード操作(G13: D&D非依存の並べ替え)
  boxesHost.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const tagEl = e.target.closest('.tag'); if (!tagEl) return;
    const box = tagEl.closest('[data-box]')?.dataset.box;
    const field = tagEl.closest('[data-field]')?.dataset.field;
    const id = tagEl.dataset.id; if (!box || !field) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) { e.preventDefault(); moveTag(box, field, id, -1); }
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) { e.preventDefault(); moveTag(box, field, id, 1); }
    else if (e.key === 'Delete') { e.preventDefault(); removeTag(box, field, id); }
    else if (e.key === 'Enter') { e.preventDefault(); startInlineEdit(box, field, id); }
  });
  boxesHost.addEventListener('focusin', (e) => {
    const f = e.target.closest('[data-field]');
    if (f) { activeBox = { box: f.dataset.box, field: f.dataset.field }; syncActiveLabel(); }
  });
  boxesHost.addEventListener('input', (e) => {
    const nm = e.target.closest('.char-name');
    if (nm) { const c = getChar(nm.dataset.charid); if (c) { c.name = nm.value; markDirty(true); } }
  });
  boxesHost.addEventListener('change', (e) => {
    const ai = e.target.closest('[data-act="aichoice"]');
    if (ai) {
      const c = getChar(e.target.closest('[data-box]').dataset.box);
      if (c) { c.aiChoice = ai.checked; const g = ai.closest('.pbox').querySelector('.pos-grid'); g?.classList.toggle('disabled', c.aiChoice); markDirty(); }
    }
  });
  boxesHost.addEventListener('click', onEditorClick);
  enableDrag();
  enableCharDrag();
}

function onEditorClick(e) {
  const box = e.target.closest('[data-box]')?.dataset.box;
  // 一括選択チェック
  if (e.target.closest('[data-act="bulkcheck"]')) { const tg = e.target.closest('.tag'); if (tg) toggleBulkSel(tg.dataset.id); return; }
  // インライン編集(タグ文字列 / 重み)
  const tagEl0 = e.target.closest('.tag');
  if (tagEl0 && box) {
    const field0 = tagEl0.closest('[data-field]').dataset.field; const id0 = tagEl0.dataset.id;
    if (e.target.closest('[data-act="wedit"]')) { startWeightEdit(box, field0, id0); return; }
    if (e.target.closest('.label')) { startInlineEdit(box, field0, id0); return; }
  }
  // タグ操作
  const tbtn = e.target.closest('.tag-btn');
  if (tbtn && box) {
    const tagEl = e.target.closest('.tag'); const id = tagEl?.dataset.id;
    const field = tagEl.closest('[data-field]').dataset.field;
    const arr = getArr(box, field); const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return;
    const act = tbtn.dataset.act;
    if (act === 'minus') arr[idx] = bumpWeight(arr[idx], -1, state.weightMode);
    else if (act === 'plus') arr[idx] = bumpWeight(arr[idx], +1, state.weightMode);
    else if (act === 'toggle') arr[idx] = { ...arr[idx], enabled: !arr[idx].enabled };
    else if (act === 'rm') { arr.splice(idx, 1); toast('タグを削除(Ctrl+Zで戻す)'); }
    renderArea(box, field); updateOutput(); markDirty();
    return;
  }
  // ボックスレベル
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'rmchar') { removeCharacter(box); return; }
  if (act === 'pos') { const g = e.target.closest('.pbox').querySelector('.pos-grid'); g.hidden = !g.hidden; return; }
  if (act === 'poscell') {
    const c = getChar(box); if (!c || c.aiChoice) return;
    const x = +e.target.dataset.x, y = +e.target.dataset.y;
    c.position = (c.position && c.position.x === x && c.position.y === y) ? null : { x, y };
    // セル表示更新
    const grid = e.target.closest('.pos-grid');
    $$('.pos-cell', grid).forEach(cell => cell.classList.toggle('sel', c.position && +cell.dataset.x === c.position.x && +cell.dataset.y === c.position.y));
    grid.querySelector('.pos-cap').textContent = c.position ? `位置 (${c.position.x + 1}, ${c.position.y + 1})` : '未指定';
    markDirty();
  }
}

// キーボードによるタグ並べ替え/削除(G13)
function moveTag(box, field, id, dir) {
  const arr = getArr(box, field); if (!arr) return;
  const i = arr.findIndex(x => x.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderArea(box, field); updateOutput(); markDirty();
  areaEl(box, field)?.querySelector(`.tag[data-id="${CSS.escape(id)}"]`)?.focus();
}
function removeTag(box, field, id) {
  const arr = getArr(box, field); if (!arr) return;
  const i = arr.findIndex(x => x.id === id); if (i < 0) return;
  arr.splice(i, 1); renderArea(box, field); updateOutput(); markDirty(); toast('タグを削除(Ctrl+Zで戻す)');
}

function addTags(box, field, text) {
  const items = parsePromptText(text);
  if (!items.length) return;
  const arr = getArr(box, field); if (!arr) return;
  arr.push(...items);
  renderArea(box, field); updateOutput(); markDirty();
}

function addCharacter() {
  if (state.characters.length >= 6) { toast('キャラは最大6人です'); return; }
  state.characters.push(normalizeChar({ name: '' }));
  renderEditor(); updateOutput(); markDirty();
}
function removeCharacter(box) {
  const i = state.characters.findIndex(c => c.id === box);
  if (i < 0) return;
  state.characters.splice(i, 1);
  if (activeBox.box === box) activeBox = { box: 'base', field: 'positive' };
  renderEditor(); updateOutput(); markDirty();
  toast('キャラを削除(Ctrl+Zで戻す)');
}

// 追加先の選択肢(ベース + 各キャラ × ポジ/ネガ)。G8
function activeBoxOptions() {
  const opts = [['base::positive', 'ベース / ポジティブ'], ['base::negative', 'ベース / ネガティブ']];
  if (getModel(state.model).multichar) {
    state.characters.forEach((c, i) => {
      const nm = c.name || `キャラ${i + 1}`;
      opts.push([`${c.id}::positive`, `${nm} / ポジティブ`]);
      opts.push([`${c.id}::negative`, `${nm} / ネガティブ`]);
    });
  }
  return opts;
}
function syncActiveLabel() {
  const sel = $('#activeBoxSelect');
  if (sel) {
    const cur = `${activeBox.box}::${activeBox.field}`;
    sel.innerHTML = activeBoxOptions().map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }
  highlightActiveField();
}
function highlightActiveField() {
  if (!boxesHost) return;
  $$('.field-group', boxesHost).forEach(g =>
    g.classList.toggle('active-target', g.dataset.box === activeBox.box && g.dataset.field === activeBox.field));
}

// ---- タグ並べ替え(ポインタD&D, 全ボックス委譲) ----
function enableDrag() {
  let dragEl = null, dragArea = null;
  boxesHost.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.tag .drag-grip'); if (!grip) return;
    dragEl = grip.closest('.tag'); dragArea = dragEl.closest('.tag-area');
    dragEl.setPointerCapture?.(e.pointerId);
    dragEl.classList.add('dragging'); dragEl.style.opacity = '.6'; e.preventDefault();
  });
  boxesHost.addEventListener('pointermove', (e) => {
    if (!dragEl) return;
    dragEl.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    dragEl.style.pointerEvents = '';
    const t2 = under?.closest?.('.tag');
    if (!t2 || t2 === dragEl || t2.parentElement !== dragArea) return;
    const r = t2.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2 || (e.clientX > r.left + r.width / 2 && Math.abs(e.clientY - r.top) < r.height);
    dragArea.insertBefore(dragEl, after ? t2.nextSibling : t2);
  });
  const end = () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging'); dragEl.style.opacity = '';
    const box = dragArea.dataset.box, field = dragArea.dataset.field;
    const order = $$('.tag', dragArea).map(el => el.dataset.id);
    getArr(box, field).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    dragEl = null; dragArea = null;
    updateOutput(); markDirty();
  };
  boxesHost.addEventListener('pointerup', end);
  boxesHost.addEventListener('pointercancel', end);
}

// ---- キャラボックス並べ替え(グリップ) ----
function enableCharDrag() {
  let el = null;
  boxesHost.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.char-grip'); if (!grip) return;
    el = grip.closest('.pbox'); el.setPointerCapture?.(e.pointerId); el.classList.add('dragging'); e.preventDefault();
  });
  boxesHost.addEventListener('pointermove', (e) => {
    if (!el) return;
    el.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    el.style.pointerEvents = '';
    const t2 = under?.closest?.('.pbox.is-char');
    if (!t2 || t2 === el) return;
    const r = t2.getBoundingClientRect();
    boxesHost.insertBefore(el, e.clientY > r.top + r.height / 2 ? t2.nextSibling : t2);
  });
  const end = () => {
    if (!el) return;
    el.classList.remove('dragging');
    const order = $$('.pbox.is-char', boxesHost).map(b => b.dataset.box);
    state.characters.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    el = null; updateOutput(); markDirty();
  };
  boxesHost.addEventListener('pointerup', end);
  boxesHost.addEventListener('pointercancel', end);
}

// ============ 出力 ============
function updateOutput() {
  const res = buildAll(state);
  const m = getModel(state.model);
  outPipe.value = res.pipePositive;
  const outPipeNeg = $('#outPipeNeg');
  if (outPipeNeg) {
    outPipeNeg.value = res.pipeNegative;
    $('#pipeNegGroup').style.display = res.pipeNegative ? '' : 'none';
  }
  // モバイル用ミニ出力(G11)
  const miniPos = $('#miniOutPipe'), miniNeg = $('#miniOutPipeNeg');
  if (miniPos) miniPos.value = res.pipePositive;
  if (miniNeg) miniNeg.value = res.pipeNegative;
  const miniNegBtn = $('#miniCopyNeg'); if (miniNegBtn) miniNegBtn.style.display = res.pipeNegative ? '' : 'none';

  // ボックス別出力
  let html = '';
  html += outBoxHTML('ベース ポジティブ', 'out_base_pos', res.base.positive.text);
  if (res.base.negative.text) html += outBoxHTML('ベース ネガティブ', 'out_base_neg', res.base.negative.text);
  res.characters.forEach((c, i) => {
    const pos = c.position ? ` @(${c.position.x + 1},${c.position.y + 1})` : c.aiChoice ? ' @おまかせ' : '';
    html += outBoxHTML(`${esc(c.name)} ポジ${esc(pos)}`, `out_c${i}_pos`, c.positive.text);
    if (c.negative.text) html += outBoxHTML(`${esc(c.name)} ネガ`, `out_c${i}_neg`, c.negative.text);
  });
  boxOutputs.innerHTML = html || `<div class="meta">タグを追加すると出力されます</div>`;

  // 統計
  const xdup = computeCrossDupIds();
  $('#outStats').innerHTML =
    `<span>重複除去 <b>${res.duplicates}</b></span>` +
    (xdup.size ? `<span class="xdup-stat">横断重複 <b>${xdup.size}</b></span>` : '') +
    `<span class="${res.overLimit ? 'over' : ''}">トークン概算 <b>${res.tokenEstimate}</b>/512</span>` +
    (m.multichar ? `<span>キャラ <b>${state.characters.length}</b>/6</span>` : '');

  // 警告
  const warns = [];
  if (res.overLimit) warns.push(`⚠ トークン概算が512を超過(${res.tokenEstimate})。base+全キャラ合計の上限です。`);
  if (res.nonAscii.length) warns.push(`⚠ 非ASCII文字 ${res.nonAscii.slice(0, 8).join(' ')} はモデルが解釈できません(出力は英語タグで)。`);
  if (!m.negative && hasNegativeWeights()) warns.push(`⚠ 負の重み(除去)はV4.5専用です。現在のモデルでは無効になる可能性があります。`);
  if (state.weightMode === 'numeric' && m.family === 'v3') warns.push(`⚠ 数値強調はV4+専用です。V3では波括弧記法を使ってください。`);
  const wa = $('#warnArea');
  wa.innerHTML = warns.map(w => `<div class="warn">${esc(w)}</div>`).join('');

  renderDupHighlight(xdup);
  syncActiveLabel();
}
function outBoxHTML(label, id, text) {
  return `<div class="out-group">
    <div class="out-label"><span>${label}</span><button class="copy-btn" data-copy-el="${id}">コピー</button></div>
    <textarea id="${id}" class="out-text" readonly rows="2">${esc(text)}</textarea></div>`;
}
function hasNegativeWeights() {
  const any = (arr) => (arr || []).some(it => it.enabled && (it.weight ?? 1) < 0);
  return any(state.base.positive) || any(state.base.negative) ||
    state.characters.some(c => any(c.positive) || any(c.negative));
}
// ボックス横断の重複検出(G12): 同一タグが異なるボックスに現れたら全該当idを返す
function computeCrossDupIds() {
  if (state.settings.crossDup === false) return new Set();
  const keyIds = new Map(), keyBoxes = new Map();
  for (const [box, field] of allBoxFields()) {
    for (const it of (getArr(box, field) || [])) {
      if (!it.enabled || !it.base) continue;
      const k = normalizeKey(it.base);
      if (!keyIds.has(k)) { keyIds.set(k, []); keyBoxes.set(k, new Set()); }
      keyIds.get(k).push(it.id); keyBoxes.get(k).add(box);
    }
  }
  const out = new Set();
  for (const [k, boxes] of keyBoxes) if (boxes.size > 1) for (const id of keyIds.get(k)) out.add(id);
  return out;
}
function renderDupHighlight(xdup = computeCrossDupIds()) {
  for (const [box, field] of allBoxFields()) {
    const host = areaEl(box, field); if (!host) continue;
    const dupIds = state.settings.dedup ? findDuplicateIds(getArr(box, field)) : new Set();
    $$('.tag', host).forEach(el => {
      el.classList.toggle('dup', dupIds.has(el.dataset.id));
      el.classList.toggle('xdup', xdup.has(el.dataset.id));
    });
  }
}
function* allBoxFields() {
  yield ['base', 'positive']; yield ['base', 'negative'];
  for (const c of state.characters) { yield [c.id, 'positive']; yield [c.id, 'negative']; }
}

function wireOutput() {
  $('#boxOutputs').addEventListener('click', onCopyClick);
  $('.output-scroll').addEventListener('click', (e) => {
    const b = e.target.closest('.copy-btn'); if (!b) return;
    const id = b.dataset.copyEl;
    if (id === 'outPipe') copyFromEl('outPipe', 'パイプ形式(ポジ)');
    else if (id === 'outPipeNeg') copyFromEl('outPipeNeg', 'パイプ形式(ネガ)');
  });
  $('#btnSavePreset').addEventListener('click', savePreset);
  $('#miniOut').addEventListener('click', (e) => {
    const b = e.target.closest('.copy-btn'); if (!b) return;
    copyFromEl(b.dataset.copyEl, b.dataset.copyEl === 'miniOutPipe' ? 'パイプ形式(ポジ)' : 'パイプ形式(ネガ)');
  });
  $('#btnClearHistory').addEventListener('click', async () => { await db.clear('history'); renderHistory(); toast('履歴をクリア'); });
  renderPresets(); renderHistory();
}
function onCopyClick(e) {
  const b = e.target.closest('.copy-btn'); if (!b) return;
  copyFromEl(b.dataset.copyEl, 'コピー');
}
async function copyFromEl(id, label) {
  const el = document.getElementById(id); const text = el?.value || '';
  if (!text) { toast('コピーする内容がありません'); return; }
  try { await navigator.clipboard.writeText(text); } catch { fallbackCopy(text); }
  toast(`${label}をコピーしました`);
  if (id === 'outPipe' || id === 'miniOutPipe') addHistory(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
  ta.select(); document.execCommand('copy'); ta.remove();
}

// ============ プリセット ============
async function savePreset() {
  const name = prompt('プリセット名', `セット ${new Date().toLocaleString('ja-JP')}`); if (!name) return;
  const now = new Date().toISOString();
  await db.put('presets', { id: db.uid('p'), name, createdAt: now, updatedAt: now,
    model: state.model, weightMode: state.weightMode, base: state.base, characters: state.characters, params: state.params });
  renderPresets(); toast('プリセットを保存しました');
}
async function renderPresets() {
  const list = await db.getAll('presets');
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const host = $('#presetList');
  if (!list.length) { host.innerHTML = `<div class="meta">保存済みプリセットはありません</div>`; return; }
  host.innerHTML = list.map(p => `<div class="preset-item" data-id="${p.id}">
    <div><div class="name">${esc(p.name)}</div>
    <div class="meta">${esc(getModel(p.model).label)} · キャラ${(p.characters?.length || 0)}</div></div>
    <div class="row-actions"><button class="mini-btn" data-pact="load">読込</button>
    <button class="mini-btn danger" data-pact="del">削除</button></div></div>`).join('');
  host.onclick = async (e) => {
    const btn = e.target.closest('.mini-btn'); if (!btn) return;
    const id = e.target.closest('.preset-item').dataset.id; const rec = await db.get('presets', id);
    if (btn.dataset.pact === 'load' && rec) {
      applyWorkspace(rec); buildModelOptions(); renderEditor(); updateOutput(); markDirty(); toast(`「${rec.name}」を読込`);
    } else if (btn.dataset.pact === 'del') { await db.del('presets', id); renderPresets(); toast('削除しました'); }
  };
}

// ============ 履歴(全状態スナップショット / G5)============
async function addHistory(label) {
  const snapshot = snapshotState();   // model/weightMode/settings/base/characters/params
  await db.put('history', { id: db.uid('h'), createdAt: new Date().toISOString(),
    label: label || buildAll(state).pipePositive || '(空)', snapshot });
  const all = await db.getAll('history'); all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of all.slice(30)) await db.del('history', old.id);
  renderHistory();
}
// 履歴レコードの表示用テキスト(新: label / 旧: text)
function historyLabel(h) { return h.label ?? h.text ?? '(空)'; }
async function renderHistory() {
  const all = await db.getAll('history'); all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const host = $('#historyList');
  if (!all.length) { host.innerHTML = `<div class="meta">履歴はありません</div>`; return; }
  host.innerHTML = all.slice(0, 30).map(h => {
    const full = !!h.snapshot;
    const meta = full ? `${getModel(h.snapshot.model).label} · キャラ${h.snapshot.characters?.length || 0}` : '旧形式(baseのみ)';
    return `<div class="history-item" data-id="${h.id}">
      <div class="hcol"><span class="htext" title="${esc(historyLabel(h))}">${esc(historyLabel(h))}</span>
      <span class="meta">${esc(meta)}</span></div>
      <button class="mini-btn" data-hact="restore" title="${full ? '保存時の全状態を復元' : 'baseポジへ展開'}">${full ? '復元' : 'ベースへ'}</button></div>`;
  }).join('');
  host.onclick = async (e) => {
    const btn = e.target.closest('.mini-btn'); if (!btn) return;
    const rec = await db.get('history', e.target.closest('.history-item').dataset.id);
    if (!rec) return;
    if (rec.snapshot) {
      loadSnapshotIntoState(rec.snapshot); rerenderEditorAll(); markDirty();
      switchPanel('editor'); toast('履歴から全状態を復元');
    } else {  // 旧形式フォールバック
      state.base.positive = parsePromptText((rec.text || '').split('|')[0]);
      renderEditor(); updateOutput(); markDirty(); switchPanel('editor'); toast('履歴をベースへ展開');
    }
  };
}

// ============ ダイアログ ============
function wireDialogs() {
  $('#btnData').addEventListener('click', () => $('#dataDialog').showModal());
  $('#btnSettings').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#setWeightMode').addEventListener('change', e => { state.weightMode = e.target.value; renderEditor(); updateOutput(); markDirty(); });
  $('#setDedup').addEventListener('change', e => { state.settings.dedup = e.target.checked; renderAllAreas(); updateOutput(); markDirty(); });
  $('#setCrossDup').addEventListener('change', e => { state.settings.crossDup = e.target.checked; updateOutput(); markDirty(); });
  $('#setKeep').addEventListener('change', e => { state.settings.keep = e.target.value; updateOutput(); markDirty(); });

  $('#btnChooseFile').addEventListener('click', guard(async () => { const n = await store.chooseSaveFile(); await refreshLinkedFileUI(); toast(`保存先: ${n}`); updateSaveStatus('saved'); }));
  $('#btnLinkFile').addEventListener('click', guard(async () => { const n = await store.linkExistingFile(); await refreshLinkedFileUI(); toast(`連携: ${n}`); }));
  $('#btnSaveNow').addEventListener('click', guard(async () => { const ok = await store.saveToLinkedFile(); toast(ok ? 'ファイルへ保存しました' : '先に保存先を指定してください'); if (ok) updateSaveStatus('saved'); }));
  $('#btnLoadFile').addEventListener('click', guard(async () => { const ok = await store.loadFromLinkedFile({ merge: false }); if (ok) { await reloadFromDB(); toast('ファイルから読込'); } else toast('連携ファイルがありません'); }));
  $('#autoSaveToggle').addEventListener('change', async e => { await store.setAutoSave(e.target.checked); toast(e.target.checked ? '自動保存: ON' : 'OFF'); });
  $('#btnExportPng').addEventListener('click', guard(async () => { const n = await exportPngText(state); toast(`${n} を書き出し`); }));
  $('#btnExportStealth').addEventListener('click', guard(async () => { const n = await exportPngStealth(state); toast(`${n} を書き出し`); }));
  $('#btnExportNaiJson').addEventListener('click', guard(() => { const n = exportNaiJson(state); toast(`${n} を書き出し`); }));
  $('#btnExport').addEventListener('click', guard(async () => { const n = await store.exportDownload(); toast(`${n} を書き出し`); }));
  $('#btnImport').addEventListener('click', guard(async () => { const s = await store.importViaDialog({ merge: false }); if (s) { await reloadFromDB(); toast('読み込み(置換)'); } }));
  $('#btnImportMerge').addEventListener('click', guard(async () => { const s = await store.importViaDialog({ merge: true }); if (s) { await reloadFromDB(); toast('読み込み(マージ)'); } }));
}
async function refreshLinkedFileUI() {
  const name = await store.getLinkedFileName();
  $('#linkedFileName').textContent = name || '未設定';
  $('#fsButtons').style.opacity = store.supportsFS ? '1' : '.4';
}
async function reloadFromDB() {
  await loadWorkspace(); buildModelOptions(); renderLibrary(); renderFavorites(); renderEditor(); renderParams(); updateOutput(); renderPresets(); renderHistory();
  undoMgr.stack = []; undoMgr.idx = -1; recordHistory();   // 読込後を新たな起点に
}

// ============ ナビ ============
function wireNav() {
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => switchPanel(b.dataset.nav)));
  switchPanel('editor');
}
function switchPanel(name) {
  $$('.panel').forEach(p => p.classList.toggle('active-panel', p.dataset.panel === name));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
}

// ============ ユーティリティ ============
function guard(fn) { return async () => { try { await fn(); } catch (e) { if (e?.name === 'AbortError') return; console.error(e); toast(e.message || 'エラー'); } }; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastTimer;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200); }
function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); }
