# 作者トラッカー

XやPixivで気に入った作者を管理するツールです。  
作者を追加すると GitHub Actions が自動でプロフィール（表示名・アイコン）を取得します。

## セットアップ

### 1. リポジトリを作成してファイルを配置

```
your-repo/
├── .github/workflows/fetch_artist.yml
├── scripts/fetch_artist.py
├── data/artists.json
└── index.html
```

### 2. GitHub Pages を有効化（任意）

Settings → Pages → Branch: main / root  
これで `https://<owner>.github.io/<repo>/` からアクセスできます。

### 3. Personal Access Token を発行

Settings → Developer settings → Personal access tokens → Fine-grained tokens

必要な権限：
- **Contents**: Read and write
- **Actions**: Read and write（repository_dispatch のトリガーに必要）

### 4. index.html の⚙設定画面に入力

| 項目 | 内容 |
|------|------|
| Personal Access Token | 上で発行したトークン |
| owner | GitHubユーザー名 |
| リポジトリ名 | このリポジトリ名 |
| ファイルパス | `data/artists.json`（デフォルト） |

## 使い方

1. 「＋ 作者を追加」→ Xアカウント名を入力して追加
2. GitHub Actions が自動でプロフィールを取得（数分かかります）
3. 「GitHubから読込」ボタンで最新データを反映
4. 作者カードを開いて作品URLを貼り付けて保存

## 既存ツールとの統合

`data/artists.json` の `x_account` フィールドを既存の監視ツールの `accounts.json` と突き合わせることで、  
BANチェック対象への自動追加などが可能です。

## artists.json のスキーマ

```json
{
  "artists": [
    {
      "id": "一意ID",
      "name": "表示名（自動取得）",
      "x_account": "Xアカウント名（@なし）",
      "pixiv_user": "Pixivユーザー名またはID",
      "avatar_url": "アイコン画像URL（自動取得）",
      "note": "メモ",
      "added_at": "2026-06-29",
      "fetch_status": "pending | done | error | none",
      "profile_fetched_at": "2026-06-29",
      "works": [
        {
          "url": "https://x.com/...",
          "type": "x_post | pixiv | other",
          "memo": "メモ",
          "saved_at": "2026-06-29"
        }
      ]
    }
  ]
}
```
