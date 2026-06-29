// metaexport.js — 現在の編集状態を NAI 形式メタデータとして書き出す(G2)
//
// naimeta.js(読込)の逆。出力経路:
//   1) NAI形式 JSON ファイル(.json)
//   2) PNG + iTXt "Comment"(UTF-8。Japaneseキャラ名も保持)
//   3) PNG + stealth LSB(αチャンネル。naimeta.js の readStealth と往復)
//
// 画像本体は「プロンプトカード」を生成(背景グラデ+概要テキスト)。
// 寸法は生成パラメータ(width/height)に合わせる。

import { buildAll } from './prompt.js';
import { getModel } from './tags.js';

// ---- NAI形式ペイロード生成 ----
export function buildNaiPayload(state) {
  const res = buildAll(state);
  const m = getModel(state.model);
  const p = state.params || {};
  const chars = state.characters || [];
  const useCoords = chars.some(c => c.aiChoice === false && c.position);

  const num = (v) => (v == null || v === '' || isNaN(+v)) ? undefined : +v;
  const payload = {
    prompt: res.base.positive.text,
    uc: res.base.negative.text,
    steps: num(p.steps), scale: num(p.scale), cfg_rescale: num(p.cfg_rescale),
    sampler: p.sampler, noise_schedule: p.noise_schedule,
    width: num(p.width), height: num(p.height),
  };
  if (p.seed != null && p.seed !== '') payload.seed = Math.round(+p.seed);

  if (m.multichar) {
    const gridToCenter = (pos) => pos
      ? { x: +(((pos.x + 0.5) / 5).toFixed(3)), y: +(((pos.y + 0.5) / 5).toFixed(3)) }
      : { x: 0.5, y: 0.5 };
    const capPos = res.characters.map((c, i) => ({
      char_caption: c.positive.text,
      centers: [gridToCenter(chars[i] && chars[i].aiChoice === false ? chars[i].position : null)],
    }));
    const capNeg = res.characters.map((c) => ({ char_caption: c.negative.text, centers: [{ x: 0.5, y: 0.5 }] }));
    payload.v4_prompt = { caption: { base_caption: res.base.positive.text, char_captions: capPos }, use_coords: useCoords, use_order: true };
    payload.v4_negative_prompt = { caption: { base_caption: res.base.negative.text, char_captions: capNeg } };
  }
  return payload;
}

// 読込側が解釈する text フィールド一式(Comment は params の JSON 文字列)
function buildTextFields(state) {
  const payload = buildNaiPayload(state);
  const source = getModel(state.model).label;
  return {
    payload,
    comment: JSON.stringify(payload),
    source,
    software: 'NAI Prompt Studio',
    description: payload.prompt || '',
  };
}

// ---- ダウンロードユーティリティ ----
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- JSON 書き出し ----
export function exportNaiJson(state) {
  const { payload } = buildTextFields(state);
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `nai-meta_${stamp()}.json`);
  return `nai-meta_${stamp()}.json`;
}

// ---- プロンプトカード描画 ----
function drawCard(ctx, w, h, state) {
  const res = buildAll(state);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#0a0b11'); g.addColorStop(0.5, '#11132099'); g.addColorStop(1, '#1a1530');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // アクセントの帯
  const ag = ctx.createLinearGradient(0, 0, w, 0);
  ag.addColorStop(0, '#5b8cff'); ag.addColorStop(1, '#a87bff');
  ctx.fillStyle = ag; ctx.fillRect(0, 0, w, Math.max(6, h * 0.012));

  const pad = Math.round(w * 0.05);
  let y = pad + 40;
  ctx.fillStyle = '#e9ebf5';
  ctx.font = `bold ${Math.round(w * 0.045)}px sans-serif`;
  ctx.fillText('NAI Prompt Studio', pad, y);
  y += Math.round(w * 0.04);
  ctx.fillStyle = '#9aa0b8';
  ctx.font = `${Math.round(w * 0.026)}px sans-serif`;
  ctx.fillText(getModel(state.model).label, pad, y);
  y += Math.round(w * 0.05);

  ctx.fillStyle = '#bcc7f0';
  ctx.font = `${Math.round(w * 0.028)}px monospace`;
  const lines = wrapText(ctx, res.pipePositive || '(プロンプト未設定)', w - pad * 2);
  for (const ln of lines.slice(0, 18)) { ctx.fillText(ln, pad, y); y += Math.round(w * 0.04); }
}
function wrapText(ctx, text, maxW) {
  const words = String(text).split(/(\s+|,)/); const out = []; let line = '';
  for (const word of words) {
    const test = line + word;
    if (ctx.measureText(test).width > maxW && line) { out.push(line.trimEnd()); line = word.trimStart(); }
    else line = test;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// ---- PNG (iTXt) 書き出し ----
export async function exportPngText(state) {
  const p = state.params || {};
  const w = clampDim(p.width, 832), h = clampDim(p.height, 1216);
  const canvas = makeCanvas(w, h);
  drawCard(canvas.getContext('2d'), w, h, state);
  const baseBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const pngBytes = new Uint8Array(await baseBlob.arrayBuffer());
  const tf = buildTextFields(state);
  const chunks = [
    iTXtChunk('Comment', tf.comment),
    iTXtChunk('Source', tf.source),
    iTXtChunk('Software', tf.software),
    iTXtChunk('Description', tf.description),
  ];
  const out = insertBeforeIEND(pngBytes, chunks);
  const name = `nai-prompt_${stamp()}.png`;
  download(new Blob([out], { type: 'image/png' }), name);
  return name;
}

// ---- PNG (stealth LSB) 書き出し ----
export async function exportPngStealth(state) {
  const p = state.params || {};
  const w = clampDim(p.width, 832), h = clampDim(p.height, 1216);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawCard(ctx, w, h, state);
  const imgData = ctx.getImageData(0, 0, w, h);

  const tf = buildTextFields(state);
  const wrapper = { Software: 'NovelAI', Source: tf.source, Comment: tf.comment, Description: tf.description };
  const payloadBytes = await gzip(new TextEncoder().encode(JSON.stringify(wrapper)));
  embedStealth(imgData, payloadBytes);   // throws if容量不足
  ctx.putImageData(imgData, 0, 0);

  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const name = `nai-stealth_${stamp()}.png`;
  download(blob, name);
  return name;
}

function clampDim(v, d) { const n = Math.round(+v); return (!n || isNaN(n) || n < 64) ? d : Math.min(n, 4096); }

// ---- stealth LSB writer(naimeta.js readStealth と対) ----
// magic(15) + uint32 bitLen + payload。列優先(row内側→col外側)・各byte MSB先頭。
function embedStealth(imageData, payloadBytes) {
  const { data, width: w, height: h } = imageData;
  const magic = strBytes('stealth_pngcomp');         // 15 bytes
  const totalBits = (magic.length + 4 + payloadBytes.length) * 8;
  if (totalBits > w * h) throw new Error('画像が小さくメタデータを埋め込めません(寸法を大きくしてください)');

  let col = 0, row = 0;
  const putBit = (bit) => {
    const idx = (row * w + col) * 4 + 3;             // αチャンネル
    data[idx] = (data[idx] & 0xFE) | (bit & 1);
    row++; if (row >= h) { row = 0; col++; }
  };
  const putByte = (b) => { for (let i = 7; i >= 0; i--) putBit((b >> i) & 1); };
  for (const b of magic) putByte(b);
  const bitLen = payloadBytes.length * 8;
  putByte((bitLen >>> 24) & 0xFF); putByte((bitLen >>> 16) & 0xFF);
  putByte((bitLen >>> 8) & 0xFF); putByte(bitLen & 0xFF);
  for (const b of payloadBytes) putByte(b);
}

async function gzip(u8) {
  if (typeof CompressionStream === 'undefined') throw new Error('このブラウザは圧縮(gzip)に未対応です');
  const cs = new CompressionStream('gzip');
  const stream = new Blob([u8]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- PNG チャンク構築 ----
function strBytes(s) { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xFF; return o; }

// iTXt: keyword \0 compFlag compMethod langTag\0 transKeyword\0 text(UTF-8)
function iTXtChunk(keyword, text) {
  const kw = strBytes(keyword);
  const body = new TextEncoder().encode(String(text ?? ''));
  const data = new Uint8Array(kw.length + 5 + body.length);
  let o = 0; data.set(kw, o); o += kw.length;
  data[o++] = 0;   // keyword終端
  data[o++] = 0;   // compression flag(無圧縮)
  data[o++] = 0;   // compression method
  data[o++] = 0;   // language tag(空)
  data[o++] = 0;   // translated keyword(空)
  data.set(body, o);
  return buildChunk('iTXt', data);
}
function buildChunk(type, dataU8) {
  const len = dataU8.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(dataU8, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)) >>> 0);
  return out;
}
function insertBeforeIEND(png, chunks) {
  // IEND タイプ(73,69,78,68)の位置を探し、その長さフィールド(4byte前)の手前へ挿入
  let pos = -1;
  for (let i = 8; i + 8 <= png.length; i++) {
    if (png[i] === 73 && png[i + 1] === 69 && png[i + 2] === 78 && png[i + 3] === 68) { pos = i - 4; break; }
  }
  if (pos < 0) pos = png.length;   // 念のため
  const extra = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, pos), 0);
  let o = pos;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  out.set(png.subarray(pos), o);
  return out;
}

// CRC32(PNG用)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
