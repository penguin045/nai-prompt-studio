// naimeta.js — NAI(NovelAI)生成画像からプロンプト等のメタデータを読み込む
//
// 対応フォーマット: PNG / WebP / JPEG
// 取得経路(順に試行):
//   1) PNG  : tEXt/zTXt/iTXt チャンクの "Comment"(JSON)
//   2) WebP : RIFFの EXIF / XMP チャンク
//   3) JPEG : APP1(EXIF / XMP)/ COM
//   4) 生バイト走査: ファイル全体から NAIのJSON(v4_prompt等)を探す
//   5) stealth pnginfo: αチャンネルLSB → magic "stealth_pngcomp"(gzip)/"stealth_pnginfo"
//
// V4/V4.5: v4_prompt.caption.base_caption + char_captions[].{char_caption,centers}
//          v4_negative_prompt.caption.* / use_coords。legacy: prompt / uc。
// API連携なし。ユーザーが渡す画像ファイルを解析するだけ。

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
const idxOf = (u8, b, from = 0) => { for (let i = from; i < u8.length; i++) if (u8[i] === b) return i; return -1; };

async function inflate(u8, format = 'deflate') {
  if (typeof DecompressionStream === 'undefined') throw new Error('解凍に未対応のブラウザです');
  const ds = new DecompressionStream(format);
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ============ PNG ============
export function parsePngChunks(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < 8; i++) if (u8[i] !== PNG_SIG[i]) throw new Error('PNG形式ではありません');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = []; let off = 8;
  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off); off += 4;
    const type = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]); off += 4;
    chunks.push({ type, data: u8.subarray(off, off + len) }); off += len + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}
export async function readTextChunks(chunks) {
  const map = {};
  for (const c of chunks) {
    try {
      if (c.type === 'tEXt') {
        const z = idxOf(c.data, 0);
        map[latin1(c.data.subarray(0, z))] = latin1(c.data.subarray(z + 1));
      } else if (c.type === 'zTXt') {
        const z = idxOf(c.data, 0);
        map[latin1(c.data.subarray(0, z))] = utf8(await inflate(c.data.subarray(z + 2), 'deflate'));
      } else if (c.type === 'iTXt') {
        const z1 = idxOf(c.data, 0); const compFlag = c.data[z1 + 1];
        let p = z1 + 3; const z2 = idxOf(c.data, 0, p); p = z2 + 1; const z3 = idxOf(c.data, 0, p); p = z3 + 1;
        const body = c.data.subarray(p);
        map[latin1(c.data.subarray(0, z1))] = compFlag ? utf8(await inflate(body, 'deflate')) : utf8(body);
      }
    } catch (e) { /* skip */ }
  }
  return map;
}

// ============ EXIF(TIFF)文字列抽出 ============
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
export function readExifStrings(exif) {
  const out = [];
  if (exif.length < 8) return out;
  const head = String.fromCharCode(exif[0], exif[1]);
  const le = head === 'II'; if (!le && head !== 'MM') return out;
  const dv = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 0x002A) return out;
  const seen = new Set();
  function ifd(off) {
    if (off <= 0 || off + 2 > exif.length || seen.has(off)) return; seen.add(off);
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12; if (e + 12 > exif.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (valOff + size > exif.length) continue;
      if (type === 2) { // ASCII
        let s = ''; for (let k = 0; k < count; k++) { const ch = exif[valOff + k]; if (ch === 0) break; s += String.fromCharCode(ch); }
        if (s.length > 4) out.push(s);
      } else if (tag === 0x9286) { // UserComment
        const charset = latin1(exif.subarray(valOff, valOff + 8));
        const body = exif.subarray(valOff + 8, valOff + count);
        if (charset.startsWith('UNICODE')) { let s = ''; const dv2 = new DataView(body.buffer, body.byteOffset, body.byteLength); for (let k = 0; k + 1 < body.length; k += 2) s += String.fromCharCode(dv2.getUint16(k, le)); out.push(s); }
        else out.push(utf8(body));
      } else if (tag === 0x8769) { ifd(u32(e + 8)); } // Exif SubIFD
    }
  }
  ifd(u32(4));
  return out;
}

// ============ WebP(RIFF)============
export function webpChunks(u8) {
  if (latin1(u8.subarray(0, 4)) !== 'RIFF' || latin1(u8.subarray(8, 12)) !== 'WEBP') throw new Error('WebP形式ではありません');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {}; let off = 12;
  while (off + 8 <= u8.length) {
    const cc = latin1(u8.subarray(off, off + 4)).trim(); off += 4;
    const size = dv.getUint32(off, true); off += 4;
    out[cc] = u8.subarray(off, off + size); off += size + (size & 1);
  }
  return out;
}
function webpStrings(u8) {
  const out = []; const ch = webpChunks(u8);
  if (ch.EXIF) { let e = ch.EXIF; if (latin1(e.subarray(0, 6)) === 'Exif\0\0') e = e.subarray(6); out.push(...readExifStrings(e)); }
  if (ch.XMP) out.push(utf8(ch.XMP));
  return out;
}

// ============ JPEG ============
function jpegStrings(u8) {
  const out = []; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let off = 2;
  while (off + 4 <= u8.length) {
    if (u8[off] !== 0xFF) { off++; continue; }
    const marker = u8[off + 1]; off += 2;
    if (marker === 0xD9 || marker === 0xDA) break;
    if (marker >= 0xD0 && marker <= 0xD7) continue;
    const len = dv.getUint16(off, false); const seg = u8.subarray(off + 2, off + len); off += len;
    if (marker === 0xE1) {
      if (latin1(seg.subarray(0, 6)) === 'Exif\0\0') out.push(...readExifStrings(seg.subarray(6)));
      else out.push(utf8(seg));
    } else if (marker === 0xFE) out.push(utf8(seg));
  }
  return out;
}

// ============ JSON抽出 ============
// テキスト群から NAIのパラメータJSONを探す
export function findNaiParams(strings) {
  for (const s of strings) {
    const p = tryExtractNai(s);
    if (p) return p;
  }
  return null;
}
function unescapeXml(s) { return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

function tryExtractNai(text) {
  if (!text || (text.indexOf('prompt') < 0 && text.indexOf('v4_prompt') < 0 && text.indexOf('Comment') < 0)) {
    if (text && (text.includes('&quot;'))) text = unescapeXml(text); else return null;
  }
  // 候補: バランスした{...}を全部試す
  for (const cand of balancedObjects(text)) {
    try {
      let obj = JSON.parse(cand);
      if (obj && typeof obj.Comment === 'string') { try { obj = { ...obj, ...JSON.parse(obj.Comment) }; } catch (e) {} }
      if (obj && (obj.v4_prompt || obj.prompt != null || obj.uc != null)) return obj;
    } catch (e) { /* next */ }
  }
  return null;
}
// テキスト中のトップレベル{...}を列挙(浅い順)
function* balancedObjects(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { yield text.slice(i, j + 1); break; } }
    }
  }
}

// ============ stealth LSB(αチャンネル)============
class LSBReader {
  // NAI stealth は「列優先(縦スキャン)」: 各列を上から下へ、αのLSBを1ビットずつ。
  constructor(imageData) { this.d = imageData.data; this.w = imageData.width; this.h = imageData.height; this.col = 0; this.row = 0; }
  bit() {
    if (this.col >= this.w) return null;
    const a = this.d[(this.row * this.w + this.col) * 4 + 3];
    this.row++; if (this.row >= this.h) { this.row = 0; this.col++; }
    return a & 1;
  }
  byte() { let b = 0; for (let i = 0; i < 8; i++) { const x = this.bit(); if (x === null) return null; b = (b << 1) | x; } return b; }
  bytes(n) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) { const b = this.byte(); if (b === null) return null; o[i] = b; } return o; }
  uint32() { const b = this.bytes(4); return b ? ((b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0) : null; }
}
async function readStealth(imageData) {
  const r = new LSBReader(imageData);
  const head = r.bytes(15); if (!head) return null;
  const magic = latin1(head);
  let gz;
  if (magic === 'stealth_pngcomp') gz = true;
  else if (magic.startsWith('stealth_pnginfo')) gz = false;
  else return null;
  const bitLen = r.uint32(); if (bitLen == null) return null;
  const payload = r.bytes(Math.floor(bitLen / 8)); if (!payload) return null;
  const jsonStr = gz ? utf8(await inflate(payload, 'gzip')) : utf8(payload);
  return JSON.parse(jsonStr);
}
async function fileToImageData(file) {
  // αのLSBを保つため premultiply / 色変換を無効化
  const bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

// ============ 正規化 ============
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const centerToGrid = (c) => c ? { x: clamp(Math.floor(c.x * 5), 0, 4), y: clamp(Math.floor(c.y * 5), 0, 4) } : null;
function mapModel(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('v4.5') && s.includes('curated')) return 'v45-curated';
  if (s.includes('v4.5')) return 'v45-full';
  if (s.includes('v4') && s.includes('curated')) return 'v4-curated';
  if (s.includes('v4')) return 'v4-full';
  if (s.includes('v3') || s.includes('diffusion 3') || s.includes('anime')) return 'v3';
  return null;
}
// キャプション整形: 改行・トップレベルの | を区切り(,)へ、連続/空の区切りを除去。
// :: 重みブロックと () [] {} の内側は触らない。
export function cleanCaption(s) {
  if (!s) return '';
  s = String(s).replace(/\r?\n/g, ', ');
  let out = '', depth = 0, num = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ':' && s[i + 1] === ':') { num = !num; out += '::'; i++; continue; }
    if (!num) {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    out += (c === '|' && depth === 0 && !num) ? ',' : c;
  }
  return out.replace(/\s*,(?:\s*,)+/g, ', ').replace(/^\s*,+|,+\s*$/g, '').trim();
}

export function normalizeParams(params, source) {
  const v4 = params.v4_prompt?.caption, v4n = params.v4_negative_prompt?.caption;
  const useCoords = !!(params.v4_prompt?.use_coords);
  const basePos = cleanCaption(v4?.base_caption ?? params.prompt ?? '');
  const baseNeg = cleanCaption(v4n?.base_caption ?? params.uc ?? params.negative_prompt ?? '');
  const cc = v4?.char_captions || [], ccn = v4n?.char_captions || [];
  const characters = cc.map((c, i) => {
    const center = c.centers?.[0] || null;
    return {
      name: '', positive: cleanCaption(c.char_caption || ''), negative: cleanCaption(ccn[i]?.char_caption || ''),
      position: useCoords ? centerToGrid(center) : null, aiChoice: !(useCoords && center),
    };
  });
  return { model: mapModel(source), base: { positive: basePos, negative: baseNeg }, characters, isV4: !!params.v4_prompt, params };
}

// ============ エントリポイント ============
export async function readNaiFromFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isPng = PNG_SIG.every((b, i) => buf[i] === b);
  const isWebp = latin1(buf.subarray(0, 4)) === 'RIFF' && latin1(buf.subarray(8, 12)) === 'WEBP';
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;

  let params = null, source = '', via = '';

  // 1) フォーマット別メタデータ
  try {
    if (isPng) {
      const text = await readTextChunks(parsePngChunks(buf));
      source = text.Source || text.source || '';
      if (text.Comment) { params = JSON.parse(text.Comment); via = 'PNG tEXt'; }
      else if (text.Description) { params = { prompt: text.Description, uc: text.uc || '' }; via = 'PNG Description'; }
    } else if (isWebp) {
      params = findNaiParams(webpStrings(buf)); if (params) via = 'WebP EXIF/XMP';
    } else if (isJpeg) {
      params = findNaiParams(jpegStrings(buf)); if (params) via = 'JPEG EXIF/XMP';
    }
  } catch (e) { /* fall through */ }

  // 2) 生バイト走査(フォールバック: 形式問わず)
  if (!params) {
    try { params = findNaiParams([utf8(buf)]); if (params) via = '生バイト走査'; } catch (e) {}
  }

  // 3) stealth LSB(canvas)
  if (!params) {
    try {
      const obj = await readStealth(await fileToImageData(file));
      if (obj) { source = obj.Source || source; const cm = obj.Comment ?? obj; params = typeof cm === 'string' ? JSON.parse(cm) : cm; via = 'stealth'; }
    } catch (e) {}
  }

  if (!params) throw new Error('この画像にNAIのメタデータが見つかりませんでした(生成画面の保存ボタンで保存した画像、または可逆WebP/PNGを使ってください)');

  const norm = normalizeParams(params, source);
  norm.via = via; norm.fileName = file.name;
  return norm;
}
