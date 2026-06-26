// dedup.js — NAI(NovelAI)プロンプトのタグ正規化と重複排除エンジン
// 設計依存なし。最終プロンプト生成時にここを通すことで重複タグを除去する。
//
// 対応する重み記法:
//   - 波括弧/角括弧:  {tag} {{tag}} (強調) / [tag] [[tag]] (弱調)
//   - 数値::記法:      1.3::tag::  /  -1.2::tag::   (NAI Diffusion)
//   - SD互換:          (tag:1.2)  /  (tag)
//   - エスケープ:       \( \) はリテラル括弧として保持
//
// 正規化キー(比較用)はタグ本体のみ。アンダースコア↔空白、大文字小文字、
// 連続空白を吸収して「同じタグ」を検出する。

const BRACE_STEP = 1.05;   // NAI: {} 1段あたりの倍率
const BRACKET_STEP = 1 / 1.05;

/**
 * 1タグ文字列を解析して { raw, base, key, weight } を返す。
 * weight は 1.0 を基準とした effective strength(概算)。
 */
export function parseTag(rawInput) {
  const raw = String(rawInput).trim();
  if (!raw) return null;

  let s = raw;
  let weight = 1.0;

  // --- 数値::記法  1.3::tag::  ---
  const numMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*::(.*?)::\s*$/);
  if (numMatch) {
    weight = parseFloat(numMatch[1]);
    s = numMatch[2].trim();
  }

  // --- SD互換  (tag:1.2)  ---
  const sdMatch = s.match(/^\((.*?):(-?\d+(?:\.\d+)?)\)$/);
  if (sdMatch) {
    s = sdMatch[1].trim();
    weight *= parseFloat(sdMatch[2]);
  }

  // --- 波括弧 / 角括弧(ネスト対応) ---
  // 先頭末尾の対応する括弧を剥がしながら倍率を掛ける
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    const head = s[0];
    const tail = s[s.length - 1];
    // エスケープされた括弧 \{ は対象外
    if (head === '{' && tail === '}') {
      s = s.slice(1, -1).trim();
      weight *= BRACE_STEP;
      changed = true;
    } else if (head === '[' && tail === ']') {
      s = s.slice(1, -1).trim();
      weight *= BRACKET_STEP;
      changed = true;
    } else if (head === '(' && tail === ')' && !/^\(.*:.*\)$/.test(s)) {
      // 重み無しの () は SD強調(約1.1)
      s = s.slice(1, -1).trim();
      weight *= 1.1;
      changed = true;
    }
  }

  const base = s;
  const key = normalizeKey(base);
  if (!key) return null;

  return { raw, base, key, weight: round(weight, 4) };
}

/** 比較用キー: 小文字化 / アンダースコア→空白 / 連続空白圧縮 / エスケープ除去 */
export function normalizeKey(base) {
  return String(base)
    .toLowerCase()
    .replace(/\\([(){}\[\]])/g, '$1') // \( → (
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * プロンプト文字列(カンマ区切り)をタグ配列に分割。
 * `::` 重みブロックや括弧内のカンマは保護する。
 */
export function splitTags(prompt) {
  const out = [];
  let depth = 0;       // () [] {} のネスト深さ
  let inNumWeight = false;
  let buf = '';
  const str = String(prompt);

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const prev = str[i - 1];

    if (prev !== '\\') {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (c === ':' && str[i + 1] === ':') inNumWeight = !inNumWeight;
    }

    if (c === ',' && depth === 0 && !inNumWeight) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 重複排除のメイン。
 * @param {string|string[]} input  プロンプト文字列 or タグ配列
 * @param {object} opts
 *   - keep: 'strongest'(既定) | 'first' | 'last'  どの重みを残すか
 * @returns {{ tags: ParsedTag[], text: string, removed: {key,raw}[] , duplicates:number }}
 */
export function dedupe(input, opts = {}) {
  const keep = opts.keep || 'strongest';
  const rawTags = Array.isArray(input) ? input : splitTags(input);

  const map = new Map();   // key -> { tag, order }
  const removed = [];
  let order = 0;

  for (const rt of rawTags) {
    const parsed = parseTag(rt);
    if (!parsed) continue;
    const existing = map.get(parsed.key);

    if (!existing) {
      map.set(parsed.key, { tag: parsed, order: order++ });
      continue;
    }

    // 重複検出
    removed.push({ key: parsed.key, raw: parsed.raw });
    let winner = existing.tag;
    if (keep === 'last') {
      winner = parsed;
    } else if (keep === 'strongest') {
      // 1.0からの乖離が大きい方を採用
      winner = Math.abs(parsed.weight - 1) > Math.abs(existing.tag.weight - 1)
        ? parsed : existing.tag;
    } // 'first' は何もしない
    map.set(parsed.key, { tag: winner, order: existing.order });
  }

  const tags = [...map.values()].sort((a, b) => a.order - b.order).map(e => e.tag);
  return {
    tags,
    text: tags.map(t => t.raw).join(', '),
    removed,
    duplicates: removed.length,
  };
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
