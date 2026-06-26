// app.js — NAI Prompt Studio コントローラ(V4.5対応 / マルチキャラ)
import CATEGORIES, { QUALITY_PRESETS, MODELS, DEFAULT_MODEL, getModel, flattenTags, searchTags } from './tags.js';
import { buildAll, buildPrompt, makeItem, parsePromptText, bumpWeight, findDuplicateIds, renderTag } from './prompt.js';
import { normalizeKey, splitTags } from './dedup.js';
import * as db from './db.js';
import * as store from './storage.js';
import { readNaiFromFile } from './naimeta.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- 状態 ----
const state = {
  model: DEFAULT_MODEL,
  weightMode: 'numeric',
  settings: { dedup: true, keep: 'strongest' },
  base: { positive: [], negative: [] },
  characters: [],          // {id, name, positive:[], negative:[], position:{x,y}|null, aiChoice}
  customTags: [],
};
let activeBox = { box: 'base', field: 'positive' };

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
  updateOutput();
  wireGlobal();
  wireEditorDelegation();
  wireOutput();
  wireDialogs();
  wireFavEditor();
  wireNav();
  await refreshLinkedFileUI();
  registerSW();
  updateSaveStatus('saved');
}

// ============ 永続化 ============
async function loadWorkspace() {
  const ws = await db.get('settings', 'workspace');
  if (ws?.value) applyWorkspace(ws.value);
  state.customTags = await db.getAll('customTags');
  $('#setDedup').checked = state.settings.dedup;
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
    base: state.base, characters: state.characters,
  }});
  store.scheduleAutoSave();
}, 400);

function markDirty() { updateSaveStatus('dirty'); saveWorkspace(); }
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
function buildQualityOptions() {
  const sel = $('#qualityPreset');
  for (const [k, v] of Object.entries(QUALITY_PRESETS)) {
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
}
function onModelChange(id) {
  state.model = id;
  state.weightMode = getModel(id).weightMode;
  $('#setWeightMode').value = state.weightMode;
  renderEditor(); updateOutput(); markDirty();
}
function applyQuality() {
  const k = $('#qualityPreset').value;
  if (!k) { toast('プリセットを選択してください'); return; }
  const p = QUALITY_PRESETS[k];
  state.base.positive = [...parsePromptText(p.positive), ...state.base.positive];
  state.base.negative = parsePromptText(p.negative);
  renderEditor(); updateOutput(); markDirty();
  toast(`「${p.label}」をベースへ適用`);
}

// ============ ライブラリ ============
function renderLibrary(query = '') {
  const host = $('#categoryList');
  const flat = flattenTags(CATEGORIES, state.customTags);
  if (query) {
    const hits = searchTags(query, flat);
    host.innerHTML = `<div class="category"><div class="category-title">検索結果 (${hits.length})</div>
      <div class="tag-chips">${hits.map(libChip).join('')}</div></div>`;
    return;
  }
  let html = '';
  for (const cat of CATEGORIES) {
    html += `<div class="category"><div class="category-title">${esc(cat.name)}</div>
      <div class="tag-chips">${cat.tags.map(libChip).join('')}</div></div>`;
  }
  if (state.customTags.length) {
    html += `<div class="category"><div class="category-title">カスタム</div>
      <div class="tag-chips">${state.customTags.map(c => libChip({ t: c.t, j: c.j, custom: true, id: c.id })).join('')}</div></div>`;
  }
  host.innerHTML = html;
}
function libChip(t) {
  if (t.custom) {
    return `<span class="lib-chip custom" data-tag="${esc(t.t)}" title="${esc(t.t)}">
      <span class="ja">${esc(t.j || t.t)}</span>
      <button class="lib-del" data-cid="${esc(t.id || '')}" title="削除">✕</button></span>`;
  }
  return `<button class="lib-chip" data-tag="${esc(t.t)}" title="${esc(t.t)}">
    <span class="ja">${esc(t.j || t.t)}</span>${t.j ? `<span class="en">${esc(t.t)}</span>` : ''}</button>`;
}
function wireGlobal() {
  $('#categoryList').addEventListener('click', (e) => {
    const del = e.target.closest('.lib-del');
    if (del) { deleteCustomTag(del.dataset.cid); return; }
    const t = e.target.closest('[data-tag]');
    if (t) addTags(activeBox.box, activeBox.field, t.dataset.tag);
  });
  $('#tagSearch').addEventListener('input', (e) => renderLibrary(e.target.value));
  $('#btnAddCustom').addEventListener('click', addCustomFromSearch);
  $('#modelSelect').addEventListener('change', e => onModelChange(e.target.value));
  $('#btnApplyQuality').addEventListener('click', applyQuality);
  $('#btnAddChar').addEventListener('click', addCharacter);
  $('#btnLoadImage').addEventListener('click', importFromImage);
  $('#btnSaveFav').addEventListener('click', saveFavorite);
  $('#favList').addEventListener('click', onFavClick);
}

// ===== お気に入り(タグセット) =====
async function renderFavorites() {
  const favs = await db.getAll('favorites');
  favs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const host = $('#favList');
  if (!favs.length) { host.innerHTML = `<div class="fav-empty">タグを入れて「＋保存」でまとめ登録</div>`; return; }
  host.innerHTML = favs.map(f => `<span class="fav-chip" data-id="${f.id}" title="${esc(f.tags)}">
    <button class="fav-insert" data-fav="ins">★ ${esc(f.name)} <em>${f.count || 0}</em></button>
    <button class="fav-mini" data-fav="edit" title="編集">✎</button>
    <button class="fav-del" data-fav="del" title="削除">✕</button></span>`).join('');
}
async function onFavClick(e) {
  const chip = e.target.closest('.fav-chip'); if (!chip) return;
  const id = chip.dataset.id;
  if (e.target.closest('[data-fav="del"]')) {
    const f = await db.get('favorites', id);
    if (confirm(`お気に入り「${f?.name || ''}」を削除しますか?`)) { await db.del('favorites', id); renderFavorites(); toast('削除しました'); }
    return;
  }
  if (e.target.closest('[data-fav="edit"]')) {
    const f = await db.get('favorites', id);
    if (f) openFavEditor({ id: f.id, name: f.name, tagItems: splitTags(f.tags).map(t => ({ text: t, on: true })) });
    return;
  }
  const f = await db.get('favorites', id);
  if (f) { addTags(activeBox.box, activeBox.field, f.tags); toast(`「${f.name}」を ${activeBox.field === 'positive' ? 'ポジ' : 'ネガ'} へ挿入`); }
}

// 「＋保存」: 現在のボックスのタグを全選択状態でエディタを開く(不要分を外して保存)
function saveFavorite() {
  const arr = (getArr(activeBox.box, activeBox.field) || []).filter(i => i.enabled && i.base);
  const tagItems = arr.map(i => ({ text: renderTag(i, state.weightMode), on: true }));
  openFavEditor({ id: null, name: arr.slice(0, 3).map(i => i.base).join(', '), tagItems });
}

// ---- お気に入り編集ダイアログ ----
let favEdit = null;
function openFavEditor({ id = null, name = '', tagItems = [] }) {
  favEdit = { id, tags: tagItems.slice() };
  $('#favDialogTitle').textContent = id ? 'お気に入りを編集' : 'お気に入りを保存';
  $('#favName').value = name;
  $('#favAddInput').value = '';
  renderFavPick();
  $('#favDialog').showModal();
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
  await db.put('favorites', { id: favEdit.id || db.uid('f'), name, tags: tags.join(', '), count: tags.length, createdAt: new Date().toISOString() });
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
    const rec = { id: db.uid('c'), t, j: '' };
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
      state.base = { positive: parsePromptText(norm.base.positive), negative: parsePromptText(norm.base.negative) };
      state.characters = norm.characters.map(c => ({
        id: db.uid('c'), name: c.name || '',
        positive: parsePromptText(c.positive), negative: parsePromptText(c.negative),
        position: c.position || null, aiChoice: c.aiChoice !== false,
      }));
      activeBox = { box: 'base', field: 'positive' };
      buildModelOptions(); renderEditor(); updateOutput(); markDirty();
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
  const rec = { id: db.uid('c'), t: v, j: '' };
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
  return `<div class="field-group">
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
  let badge = '';
  if (Math.abs(w - 1) > 1e-6) {
    const cls = w < 0 ? 'neg' : w < 1 ? 'weak' : 'strong';
    const txt = w < 0 ? `${w}` : `${w}x`;
    badge = `<span class="wbadge ${cls}">${txt}</span>`;
  }
  return `<span class="tag${it.enabled ? '' : ' disabled'}${isDup ? ' dup' : ''}" data-id="${it.id}">
    <span class="label" title="${esc(it.base)}">${esc(it.base)}</span>${badge}
    <button class="tag-btn minus" data-act="minus" title="弱める">−</button>
    <button class="tag-btn plus" data-act="plus" title="強める">＋</button>
    <button class="tag-btn" data-act="toggle" title="有効/無効">${it.enabled ? '◐' : '○'}</button>
    <button class="tag-btn rm" data-act="rm" title="削除">✕</button>
  </span>`;
}

// ============ エディタ操作(委譲) ============
function wireEditorDelegation() {
  boxesHost.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.tag-input'); if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); addTags(inp.dataset.box, inp.dataset.field, inp.value); inp.value = ''; }
  });
  boxesHost.addEventListener('focusin', (e) => {
    const f = e.target.closest('[data-field]');
    if (f) { activeBox = { box: f.dataset.box, field: f.dataset.field }; syncActiveLabel(); }
  });
  boxesHost.addEventListener('input', (e) => {
    const nm = e.target.closest('.char-name');
    if (nm) { const c = getChar(nm.dataset.charid); if (c) { c.name = nm.value; markDirty(); } }
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
    else if (act === 'rm') arr.splice(idx, 1);
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
}

function syncActiveLabel() {
  const name = activeBox.box === 'base' ? 'ベース' :
    (getChar(activeBox.box)?.name || `キャラ${state.characters.findIndex(c => c.id === activeBox.box) + 1}`);
  $('#activeBoxLabel').textContent = `${name} / ${activeBox.field === 'positive' ? 'ポジティブ' : 'ネガティブ'}`;
}

// ---- タグ並べ替え(ポインタD&D, 全ボックス委譲) ----
function enableDrag() {
  let dragEl = null, dragArea = null;
  boxesHost.addEventListener('pointerdown', (e) => {
    const label = e.target.closest('.tag .label'); if (!label) return;
    dragEl = label.closest('.tag'); dragArea = dragEl.closest('.tag-area');
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
  $('#outStats').innerHTML =
    `<span>重複除去 <b>${res.duplicates}</b></span>` +
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

  renderDupHighlight();
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
function renderDupHighlight() {
  for (const [box, field] of allBoxFields()) {
    const host = areaEl(box, field); if (!host) continue;
    const dupIds = state.settings.dedup ? findDuplicateIds(getArr(box, field)) : new Set();
    $$('.tag', host).forEach(el => el.classList.toggle('dup', dupIds.has(el.dataset.id)));
  }
}
function* allBoxFields() {
  yield ['base', 'positive']; yield ['base', 'negative'];
  for (const c of state.characters) { yield [c.id, 'positive']; yield [c.id, 'negative']; }
}

function wireOutput() {
  $('#boxOutputs').addEventListener('click', onCopyClick);
  $('.output-scroll').addEventListener('click', (e) => {
    const b = e.target.closest('.copy-btn[data-copy-el="outPipe"]'); if (b) copyFromEl('outPipe', 'パイプ形式');
  });
  $('#btnSavePreset').addEventListener('click', savePreset);
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
  if (id === 'outPipe') addHistory(text);
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
    model: state.model, weightMode: state.weightMode, base: state.base, characters: state.characters });
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

// ============ 履歴 ============
async function addHistory(text) {
  await db.put('history', { id: db.uid('h'), createdAt: new Date().toISOString(), text });
  const all = await db.getAll('history'); all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of all.slice(30)) await db.del('history', old.id);
  renderHistory();
}
async function renderHistory() {
  const all = await db.getAll('history'); all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const host = $('#historyList');
  if (!all.length) { host.innerHTML = `<div class="meta">履歴はありません</div>`; return; }
  host.innerHTML = all.slice(0, 30).map(h => `<div class="history-item" data-id="${h.id}">
    <span class="htext" title="${esc(h.text)}">${esc(h.text)}</span>
    <button class="mini-btn" data-hact="use">ベースへ</button></div>`).join('');
  host.onclick = async (e) => {
    const btn = e.target.closest('.mini-btn'); if (!btn) return;
    const rec = await db.get('history', e.target.closest('.history-item').dataset.id);
    if (rec) { state.base.positive = parsePromptText(rec.text.split('|')[0]); renderEditor(); updateOutput(); markDirty(); switchPanel('editor'); toast('履歴をベースへ展開'); }
  };
}

// ============ ダイアログ ============
function wireDialogs() {
  $('#btnData').addEventListener('click', () => $('#dataDialog').showModal());
  $('#btnSettings').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#setWeightMode').addEventListener('change', e => { state.weightMode = e.target.value; renderEditor(); updateOutput(); markDirty(); });
  $('#setDedup').addEventListener('change', e => { state.settings.dedup = e.target.checked; renderAllAreas(); updateOutput(); markDirty(); });
  $('#setKeep').addEventListener('change', e => { state.settings.keep = e.target.value; updateOutput(); markDirty(); });

  $('#btnChooseFile').addEventListener('click', guard(async () => { const n = await store.chooseSaveFile(); await refreshLinkedFileUI(); toast(`保存先: ${n}`); updateSaveStatus('saved'); }));
  $('#btnLinkFile').addEventListener('click', guard(async () => { const n = await store.linkExistingFile(); await refreshLinkedFileUI(); toast(`連携: ${n}`); }));
  $('#btnSaveNow').addEventListener('click', guard(async () => { const ok = await store.saveToLinkedFile(); toast(ok ? 'ファイルへ保存しました' : '先に保存先を指定してください'); if (ok) updateSaveStatus('saved'); }));
  $('#btnLoadFile').addEventListener('click', guard(async () => { const ok = await store.loadFromLinkedFile({ merge: false }); if (ok) { await reloadFromDB(); toast('ファイルから読込'); } else toast('連携ファイルがありません'); }));
  $('#autoSaveToggle').addEventListener('change', async e => { await store.setAutoSave(e.target.checked); toast(e.target.checked ? '自動保存: ON' : 'OFF'); });
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
  await loadWorkspace(); buildModelOptions(); renderLibrary(); renderFavorites(); renderEditor(); updateOutput(); renderPresets(); renderHistory();
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
