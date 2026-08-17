# X アーカイブ・作者トラッカー

XやPixivで気に入った作者を管理するツールです。  
作者を追加すると GitHub Actions が自動でプロフィール（表示名・アイコン）を取得します。

## 実装状況（2026-08-17 調査）

### 完成済み

- ブラウザ上での作者追加・編集・削除、作品 URL とメモの管理
- `data/artists.json` の GitHub Contents API 経由での読み書き
- `repository_dispatch` による公開プロフィール取得

### 今回完成した部分

- 登録された X プロフィールを archive.md に一度だけ送信し、アーカイブ URL を作者データに保存
- アーカイブ URL に対する「はてなブックマークに追加」確認 URL の生成と UI 表示
- ログインや X Developer API を使わない公開プロフィールの定期確認
- `active` / `unavailable` の状態変化と時刻・理由の履歴記録
- 通信失敗・レート制限を `unknown` とし、明示的な未検出が 3 回連続するまで状態を変えない保守的な判定

### 制約・未実装

- はてなブックマークへの最終登録は、生成された確認リンクを開いて利用者が行います。ログイン情報や
  OAuth 認証をリポジトリに要求しないため、無人での登録は行いません。
- archive.md や X の公開エンドポイント側の仕様変更・アクセス制限時は、次回の定期実行で再試行します。
- `data/archives.json` は過去のコミットで作られたデータとして保持しています。既存データを消さないため
  自動移行・削除はせず、現在の正規データは従来どおり `data/artists.json` です。

### 調査時点で壊れていた部分と修正

- プロフィール取得は `twscrape` に存在しないゲストアカウントでログインしようとしており、実質的に
  フォールバック頼みでした。公開 syndication エンドポイントを直接利用するようにしました。
- 取得後も `fetch_status` が `pending` のままでした。成功時 `done`、失敗時 `error` を保存します。
- 新規作者を GitHub に保存する前に Actions を起動していたため、Actions 側で作者を見つけられませんでした。
  保存成功後にプロフィール取得を依頼する順序へ修正しました。

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
      "archive": {
        "status": "saved | retry_pending",
        "url": "https://archive.md/...",
        "saved_at": "2026-08-17T00:00:00+00:00",
        "hatena_add_url": "https://b.hatena.ne.jp/add?..."
      },
      "monitoring": {
        "status": "unknown | active | unavailable",
        "last_checked_at": "2026-08-17T00:00:00+00:00",
        "last_result": "active | unavailable | unknown",
        "consecutive_unavailable": 0
      },
      "status_history": [],
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
