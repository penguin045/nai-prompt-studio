// prompt.js — プロンプトモデルと最終生成(重複排除を組み込み / NAI V4.5対応)
//
// モデル: 各タグは { id, base, weight, enabled }
//   base    : タグ本体(例 "long hair" / "source#hug")
//   weight  : 重み(float, 既定1.0)。>1 強調 / 0〜1 弱調 / <0 除去・反転(V4.5)
//   enabled : 出力に含めるか
//
// 重み記法(設定 weightMode):
//   'bracket' : NAI古典 {tag}=×1.05 / [tag]=÷1.05(全モデル)
//   'numeric' : NAI数値  1.5::tag::(V4+専用。負値はV4.5専用)
//
// 最終生成は dedup.js を通して重複タグを除去する(ボックス単位)。

import { dedupe, parseTag, splitTags, normalizeKey } from './dedup.js';
import { uid } from './db.js';

export const WEIGHT_MODES = { bracket: 'bracket', numeric: 'numeric' };
const BRACE_STEP = 1.05;
const W_MIN = -2, W_MAX = 4;

const clampW = (w) => Math.max(W_MIN, Math.min(W_MAX, w));
const round2 = (w) => Math.round(w * 100) / 100;
function fmtW(w) { return String(round2(w)).replace(/\.0+$/, ''); }
const near1 = (w) => Math.abs(w - 1) < 1e-6;

// 1タグを記法に従ってレンダリング
export function renderTag(item, mode = 'numeric') {
  const base = item.base;
  // ランダマイザ ||a|b|c|| は重み記法を適用せずそのまま出力する
  if (base.includes('||')) return base;
  const w = item.weight ?? 1;
  if (near1(w)) return base;

  if (mode === 'numeric') return `${fmtW(w)}::${base}::`;

  // bracket: 正の重みのみ括弧表現。負値は数値記法へフォールバック(除去はbracket不可)
  if (w <= 0) return `${fmtW(w)}::${base}::`;
  const n = Math.round(Math.log(w) / Math.log(BRACE_STEP));
  if (n === 0) return base;
  return n > 0 ? '{'.repeat(n) + base + '}'.repeat(n) : '['.repeat(-n) + base + ']'.repeat(-n);
}

// 生テキスト(貼り付け等)から item 配列を作る
export function parsePromptText(text) {
  return splitTags(text).map(raw => {
    const p = parseTag(raw);
    if (!p) return null;
    return { id: uid('t'), base: p.base, weight: round2(p.weight), enabled: true };
  }).filter(Boolean);
}

// 重み増減(モードで刻みが変わる)。bracketは×1.05、numericは±0.1。
export function bumpWeight(item, delta, mode = 'numeric') {
  const w = item.weight ?? 1;
  const next = mode === 'bracket'
    ? w * Math.pow(BRACE_STEP, delta)
    : w + 0.1 * delta;
  return { ...item, weight: round2(clampW(next)) };
}

export function setWeight(item, w) { return { ...item, weight: round2(clampW(w)) }; }

/**
 * 1ボックスの最終生成。enabledをレンダリング→結合→重複排除。
 * @returns {{ text, tags, removed, duplicates, tokenEstimate }}
 */
export function buildPrompt(items, { mode = 'numeric', dedup = true, keep = 'strongest' } = {}) {
  const rendered = (items || []).filter(it => it.enabled && it.base).map(it => renderTag(it, mode));
  let result;
  if (dedup) result = dedupe(rendered, { keep });
  else result = { tags: rendered.map(parseTag).filter(Boolean), text: rendered.join(', '), removed: [], duplicates: 0 };
  return { ...result, tokenEstimate: estimateTokens(result.text) };
}

// 重複id(UIハイライト用)
export function findDuplicateIds(items) {
  const seen = new Map(); const dup = new Set();
  for (const it of (items || [])) {
    if (!it.enabled || !it.base) continue;
    const key = normalizeKey(it.base);
    if (seen.has(key)) { dup.add(it.id); dup.add(seen.get(key)); }
    else seen.set(key, it.id);
  }
  return dup;
}

// トークン概算(CLIP近似)。重み記法/括弧を除いた語を ~4文字/トークンで数え、
// タグ区切り(カンマ)もそれぞれ約1トークンとして加算する。
export function estimateTokens(text) {
  if (!text) return 0;
  // 数値::記法・波/角/丸括弧を除去
  const clean = String(text).replace(/-?\d+(?:\.\d+)?::|::/g, ' ').replace(/[{}\[\]()]/g, ' ');
  let t = 0;
  for (const seg of clean.split(',')) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    for (const w of words) t += Math.max(1, Math.ceil(w.length / 4));
    if (words.length) t += 1;   // カンマ区切り相当
  }
  return t;
}

// 非ASCII(日本語/絵文字)検出 — モデルはプロンプトでUnicode非対応
export function findNonAscii(text) {
  const m = String(text).match(/[^\x00-\x7F]/gu);
  return m ? [...new Set(m)] : [];
}

/**
 * マルチキャラクター対応の総合ビルド(V4/V4.5)。
 * @param {object} state { weightMode, settings:{dedup,keep}, base:{positive,negative}, characters:[{name,positive,negative,position,aiChoice}] }
 * @returns 構造化された出力 + パイプ形式 + 警告
 */
export function buildAll(state) {
  const mode = state.weightMode || 'numeric';
  const opts = { mode, dedup: state.settings?.dedup !== false, keep: state.settings?.keep || 'strongest' };

  const base = {
    positive: buildPrompt(state.base?.positive, opts),
    negative: buildPrompt(state.base?.negative, opts),
  };

  const characters = (state.characters || []).map((c, i) => ({
    name: c.name || `キャラ${i + 1}`,
    position: c.position || null,
    aiChoice: c.aiChoice !== false,
    positive: buildPrompt(c.positive, opts),
    negative: buildPrompt(c.negative, opts),
  }));

  // パイプ形式(ポジティブ): base | char1 | char2 …(V4.5の | 区切り)
  const pipeParts = [base.positive.text, ...characters.map(c => c.positive.text)].filter(Boolean);
  const pipePositive = pipeParts.join(' | ');

  // パイプ形式(ネガティブ): base UC | char1 UC | …(キャラ別UCを持つV4向け)
  const pipeNegParts = [base.negative.text, ...characters.map(c => c.negative.text)].filter(Boolean);
  const pipeNegative = pipeNegParts.join(' | ');

  // 集計
  const duplicates = base.positive.duplicates + base.negative.duplicates +
    characters.reduce((s, c) => s + c.positive.duplicates + c.negative.duplicates, 0);
  const tokenEstimate = base.positive.tokenEstimate + base.negative.tokenEstimate +
    characters.reduce((s, c) => s + c.positive.tokenEstimate + c.negative.tokenEstimate, 0);

  const allText = [base.positive.text, base.negative.text,
    ...characters.flatMap(c => [c.positive.text, c.negative.text])].join(' ');
  const nonAscii = findNonAscii(allText);

  return {
    base, characters, pipePositive, pipeNegative,
    duplicates, tokenEstimate,
    tokenLimit: 512,
    overLimit: tokenEstimate > 512,
    nonAscii,
  };
}
