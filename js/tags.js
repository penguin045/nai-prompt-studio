// tags.js — NAI(NovelAI/Danbooru系)タグ辞書(カテゴリ別・日本語ラベル付き)
// 各タグ: { t: 英語タグ(出力値), j: 日本語ラベル(検索/表示用) }
// カスタムタグは IndexedDB(customTags)からマージされる。

// モデル一覧。weightMode: 数値強調(numeric)はV4+専用、負値はV4.5専用。
export const MODELS = [
  { id: 'v45-full',    label: 'NAI Diffusion V4.5 Full',    family: 'v4', weightMode: 'numeric', negative: true,  multichar: true },
  { id: 'v45-curated', label: 'NAI Diffusion V4.5 Curated', family: 'v4', weightMode: 'numeric', negative: true,  multichar: true },
  { id: 'v4-full',     label: 'NAI Diffusion V4 Full',      family: 'v4', weightMode: 'numeric', negative: false, multichar: true },
  { id: 'v4-curated',  label: 'NAI Diffusion V4 Curated',   family: 'v4', weightMode: 'numeric', negative: false, multichar: true },
  { id: 'v3',          label: 'NAI Diffusion V3 (Anime)',   family: 'v3', weightMode: 'bracket', negative: false, multichar: false },
];
export const DEFAULT_MODEL = 'v45-full';
export function getModel(id) { return MODELS.find(m => m.id === id) || MODELS[0]; }

export const QUALITY_PRESETS = {
  'v45': {
    label: 'V4.5 推奨(例)',
    models: ['v45-full', 'v45-curated'],
    positive: 'very aesthetic, masterpiece, best quality, very detailed, amazing quality',
    negative: 'lowres, worst quality, bad quality, bad anatomy, bad hands, missing fingers, extra fingers, extra digits, fewer digits, jpeg artifacts, signature, watermark, username, blurry, artistic error, scan, abstract',
  },
  'v45-curated': {
    label: 'V4.5 Curated(例)',
    models: ['v45-curated'],
    positive: 'very aesthetic, masterpiece, best quality',
    negative: 'lowres, worst quality, bad quality, displeasing, bad anatomy, jpeg artifacts, signature, watermark',
  },
  'nai-modern': {
    label: 'NAI v4 推奨',
    positive: 'very aesthetic, masterpiece, best quality, very detailed',
    negative: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
  },
  'nai-classic': {
    label: 'NAI v3 推奨',
    positive: 'masterpiece, best quality, amazing quality',
    negative: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  },
  'minimal': {
    label: '最小',
    positive: 'best quality',
    negative: 'lowres, worst quality, bad anatomy',
  },
};

const CATEGORIES = [
  {
    id: 'composition', name: '構図・人数', tags: [
      { t: '1girl', j: '女性1人' }, { t: '2girls', j: '女性2人' },
      { t: '1boy', j: '男性1人' }, { t: 'multiple girls', j: '複数の女性' },
      { t: 'solo', j: 'ソロ' }, { t: 'couple', j: 'カップル' },
      { t: 'upper body', j: '上半身' }, { t: 'full body', j: '全身' },
      { t: 'portrait', j: 'ポートレート' }, { t: 'cowboy shot', j: '腰上' },
      { t: 'close-up', j: 'クローズアップ' }, { t: 'wide shot', j: '引きの絵' },
    ],
  },
  {
    id: 'angle', name: 'アングル・視点', tags: [
      { t: 'from above', j: '俯瞰' }, { t: 'from below', j: 'あおり' },
      { t: 'from side', j: '横から' }, { t: 'from behind', j: '後ろから' },
      { t: 'dutch angle', j: '斜め構図' }, { t: 'pov', j: '主観視点' },
      { t: 'looking at viewer', j: 'カメラ目線' }, { t: 'looking away', j: '目線外し' },
      { t: 'face focus', j: '顔フォーカス' }, { t: 'feet out of frame', j: '足切れ' },
    ],
  },
  {
    id: 'hair', name: '髪', tags: [
      { t: 'long hair', j: 'ロングヘア' }, { t: 'short hair', j: 'ショートヘア' },
      { t: 'twintails', j: 'ツインテール' }, { t: 'ponytail', j: 'ポニーテール' },
      { t: 'braid', j: '三つ編み' }, { t: 'bob cut', j: 'ボブ' },
      { t: 'wavy hair', j: 'ウェーブヘア' }, { t: 'messy hair', j: '乱れ髪' },
      { t: 'blonde hair', j: '金髪' }, { t: 'black hair', j: '黒髪' },
      { t: 'brown hair', j: '茶髪' }, { t: 'silver hair', j: '銀髪' },
      { t: 'pink hair', j: 'ピンク髪' }, { t: 'blue hair', j: '青髪' },
      { t: 'red hair', j: '赤髪' }, { t: 'white hair', j: '白髪' },
      { t: 'gradient hair', j: 'グラデ髪' }, { t: 'hair between eyes', j: '目にかかる前髪' },
    ],
  },
  {
    id: 'eyes', name: '目・表情', tags: [
      { t: 'blue eyes', j: '青い目' }, { t: 'red eyes', j: '赤い目' },
      { t: 'green eyes', j: '緑の目' }, { t: 'golden eyes', j: '金色の目' },
      { t: 'heterochromia', j: 'オッドアイ' }, { t: 'detailed eyes', j: '繊細な目' },
      { t: 'smile', j: '笑顔' }, { t: 'grin', j: 'にやり' },
      { t: 'blush', j: '赤面' }, { t: 'crying', j: '泣き' },
      { t: 'angry', j: '怒り' }, { t: 'embarrassed', j: '照れ' },
      { t: 'expressionless', j: '無表情' }, { t: 'open mouth', j: '口を開ける' },
      { t: 'closed eyes', j: '目を閉じる' }, { t: 'half-closed eyes', j: '半目' },
    ],
  },
  {
    id: 'pose', name: 'ポーズ・動作', tags: [
      { t: 'standing', j: '立ち' }, { t: 'sitting', j: '座り' },
      { t: 'lying', j: '横たわり' }, { t: 'kneeling', j: '膝立ち' },
      { t: 'walking', j: '歩く' }, { t: 'running', j: '走る' },
      { t: 'arms up', j: '両手上げ' }, { t: 'hand on hip', j: '腰に手' },
      { t: 'hands on own face', j: '頬に手' }, { t: 'stretching', j: '伸び' },
      { t: 'looking back', j: '振り返り' }, { t: 'leaning forward', j: '前傾' },
      { t: 'arms behind back', j: '後ろ手' }, { t: 'crossed arms', j: '腕組み' },
    ],
  },
  {
    id: 'outfit', name: '服装', tags: [
      { t: 'school uniform', j: '学生服' }, { t: 'serafuku', j: 'セーラー服' },
      { t: 'sailor collar', j: 'セーラーカラー' }, { t: 'dress', j: 'ドレス' },
      { t: 'maid', j: 'メイド' }, { t: 'kimono', j: '着物' },
      { t: 'hoodie', j: 'パーカー' }, { t: 'sweater', j: 'セーター' },
      { t: 'jacket', j: 'ジャケット' }, { t: 'shirt', j: 'シャツ' },
      { t: 'skirt', j: 'スカート' }, { t: 'pleated skirt', j: 'プリーツスカート' },
      { t: 'shorts', j: 'ショートパンツ' }, { t: 'thighhighs', j: 'サイハイ' },
      { t: 'swimsuit', j: '水着' }, { t: 'bikini', j: 'ビキニ' },
      { t: 'gloves', j: '手袋' }, { t: 'hat', j: '帽子' },
      { t: 'glasses', j: 'メガネ' }, { t: 'ribbon', j: 'リボン' },
    ],
  },
  {
    id: 'background', name: '背景・場所', tags: [
      { t: 'simple background', j: 'シンプル背景' }, { t: 'white background', j: '白背景' },
      { t: 'gradient background', j: 'グラデ背景' }, { t: 'outdoors', j: '屋外' },
      { t: 'indoors', j: '屋内' }, { t: 'classroom', j: '教室' },
      { t: 'bedroom', j: '寝室' }, { t: 'cityscape', j: '街並み' },
      { t: 'forest', j: '森' }, { t: 'beach', j: 'ビーチ' },
      { t: 'night sky', j: '夜空' }, { t: 'sunset', j: '夕暮れ' },
      { t: 'cherry blossoms', j: '桜' }, { t: 'rain', j: '雨' },
      { t: 'snow', j: '雪' }, { t: 'starry sky', j: '星空' },
    ],
  },
  {
    id: 'lighting', name: 'ライティング・効果', tags: [
      { t: 'cinematic lighting', j: '映画的照明' }, { t: 'soft lighting', j: '柔らかい光' },
      { t: 'backlighting', j: '逆光' }, { t: 'rim light', j: 'リムライト' },
      { t: 'god rays', j: '光芒' }, { t: 'bloom', j: 'ブルーム' },
      { t: 'depth of field', j: '被写界深度' }, { t: 'bokeh', j: 'ボケ' },
      { t: 'lens flare', j: 'レンズフレア' }, { t: 'glowing', j: '発光' },
      { t: 'dramatic shadow', j: 'ドラマチックな影' }, { t: 'volumetric lighting', j: 'ボリュメトリックライト' },
    ],
  },
  {
    id: 'style', name: '画風・アーティスト', tags: [
      { t: 'official art', j: '公式絵' }, { t: 'illustration', j: 'イラスト' },
      { t: 'watercolor', j: '水彩' }, { t: 'sketch', j: 'スケッチ' },
      { t: 'lineart', j: '線画' }, { t: 'chibi', j: 'ちびキャラ' },
      { t: 'realistic', j: 'リアル系' }, { t: 'flat color', j: 'フラットカラー' },
      { t: 'impasto', j: '厚塗り' }, { t: 'anime screencap', j: 'アニメ風' },
      { t: 'retro artstyle', j: 'レトロ画風' }, { t: 'pixel art', j: 'ドット絵' },
    ],
  },
  {
    id: 'special', name: '特殊・レーティング(V4.5)', tags: [
      { t: 'fur dataset', j: '獣・ケモノ向けデータセット' },
      { t: 'background dataset', j: '風景・静物向け(人物なし)' },
      { t: 'no text', j: '文字なし' }, { t: 'rating:general', j: 'レーティング:全年齢' },
      { t: 'rating:sensitive', j: 'レーティング:やや過激' },
      { t: 'rating:questionable', j: 'レーティング:際どい' },
      { t: 'rating:explicit', j: 'レーティング:露骨' },
      { t: 'year 2024', j: '年代 2024' }, { t: 'year 2023', j: '年代 2023' },
    ],
  },
  {
    id: 'interaction', name: '相互作用タグ(複数キャラ)', tags: [
      { t: 'source#hug', j: '抱きしめる(能動)' }, { t: 'target#hug', j: '抱きしめられる(受動)' },
      { t: 'mutual#hug', j: '抱き合う(相互)' },
      { t: 'source#holding hands', j: '手をつなぐ(能動)' }, { t: 'target#holding hands', j: '手をつながれる(受動)' },
      { t: 'source#head pat', j: '頭を撫でる(能動)' }, { t: 'target#head pat', j: '撫でられる(受動)' },
      { t: 'source#kiss', j: 'キスする(能動)' }, { t: 'target#kiss', j: 'キスされる(受動)' },
      { t: 'mutual#looking at another', j: '見つめ合う(相互)' },
      { t: 'source#carrying', j: '抱える(能動)' }, { t: 'target#carrying', j: '抱えられる(受動)' },
    ],
  },
];

export default CATEGORIES;

// 全タグをフラットに(検索用)。customTags をマージ可能。
export function flattenTags(categories = CATEGORIES, custom = []) {
  const flat = [];
  for (const cat of categories) {
    for (const tag of cat.tags) flat.push({ ...tag, cat: cat.id, catName: cat.name });
  }
  for (const c of custom) {
    flat.push({ t: c.t, j: c.j || '', cat: 'custom', catName: 'カスタム', custom: true, id: c.id });
  }
  return flat;
}

// 英語/日本語どちらでも部分一致検索
export function searchTags(query, flat) {
  const q = query.trim().toLowerCase();
  if (!q) return flat;
  return flat.filter(tag =>
    tag.t.toLowerCase().includes(q) ||
    (tag.j && tag.j.toLowerCase().includes(q))
  );
}
