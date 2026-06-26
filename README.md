# NAI Prompt Studio

NovelAI Diffusion **V4.5** 向けのプロンプト作成スタジオ。ビルド不要のバニラJS + PWA。

🔗 **公開URL**: https://penguin045.github.io/nai-prompt-studio/

## 主な機能
- **プロンプト作成**: 日本語ラベル付きタグライブラリ、重み調整(`{tag}` / `1.5::tag::`)、ベース + 最大6キャラのマルチキャラクタープロンプト、位置5×5グリッド / AI's Choice、相互作用タグ(`source#` / `target#` / `mutual#`)
- **重複排除**: 最終出力時にタグ正規化して重複を自動除去(記法違いの同一タグも検出)
- **NAI画像読み込み**: 生成画像(PNG / WebP / JPEG)に埋め込まれたプロンプトを解析して復元(tEXt / EXIF / XMP / stealth LSB 対応)
- **データ永続化**: IndexedDB + JSONファイルへのエクスポート/インポート(File System Access API)
- **PWA**: インストール可能・オフライン動作・スマホ対応(レスポンシブ)

## モデル対応
NAI Diffusion V4.5 Full / V4.5 Curated / V4 Full / V4 Curated / V3。数値強調(`weight::tag::`)はV4+、負の重み(除去)はV4.5専用。

## ローカル実行
静的配信すればOK(ES Modules + Service Worker のため `file://` 不可):
```
cd <repo>
python3 -m http.server 8731
# → http://localhost:8731/
```

## ライセンス / 注意
個人用ツール。NovelAI とは無関係の非公式プロジェクトです。
