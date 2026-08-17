# X アーカイブ・作者トラッカー

XやPixivで気に入った作者を管理するツールです。  
作者を追加すると GitHub Actions が自動でプロフィール（表示名・アイコン）を取得します。

## 実装状況（2026-08-17 調査）

### 完成済み

- ブラウザ上での作者追加・編集・削除、作品 URL とメモの管理
- `data/artists.json` の GitHub Contents API 経由での読み書き
- `repository_dispatch` による公開プロフィール取得
- ログインや X Developer API を使わない公開プロフィールの定期確認
- `active` / `unavailable` の状態変化と時刻・理由の履歴記録
- 通信失敗・レート制限を `unknown` とし、明示的な未検出が 3 回連続するまで状態を変えない保守的な判定
- `data/archives.json` の既存作者を、X アカウント名または ID で重複判定しながら `data/artists.json` へ互換移行

### archive.md 保存方針

GitHub-hosted Actions から archive.md へ保存を試すと HTTP 429 が発生した一方、通常のブラウザからは保存できることを確認しました。そのため、役割を次のように分離します。

- **GitHub Actions**: X アカウントの生存確認・状態履歴更新のみ
- **ブラウザ**: archive.md への保存操作
- **利用者**: 保存後の archive URL を使って、はてなブックマーク追加画面から登録

`archive_helper.html` を使うと、X URL のコピー、archive.md の起動、保存後 URL からはてブ追加画面を開く操作をまとめて行えます。

例:

```text
archive_helper.html?x=tawakenai_marou
```

ブラウザ側から archive.md へ自動 POST はせず、利用者の通常ブラウザ操作で保存します。これは GitHub Actions の共有 IP からレート制限を受け続けることを避けるためです。

### 制約・未実装

- はてなブックマークへの最終登録は利用者が行います。ログイン情報や OAuth 認証をリポジトリに要求しないため、無人での登録は行いません。
- `unavailable` は公開プロフィールを取得できない状態です。現時点では凍結と削除を区別できないため、`suspended` / `deleted` と断定して記録・表示しません。
- `data/archives.json` は削除・変更せず保持します。定期処理の開始時に既存作者を正規データである `data/artists.json` へ安全かつ冪等に取り込みます。
- `archive_helper.html` で作成した archive URL を `data/artists.json` に自動反映する処理は、現時点では未実装です。

### 調査時点で壊れていた部分と修正

- プロフィール取得は `twscrape` に存在しないゲストアカウントでログインしようとしており、実質的にフォールバック頼みでした。公開ページを使う保守的な確認へ変更しました。
- 取得後も `fetch_status` が `pending` のままでした。成功時 `done`、失敗時 `error` を保存します。
- 新規作者を GitHub に保存する前に Actions を起動していたため、Actions 側で作者を見つけられませんでした。保存成功後にプロフィール取得を依頼する順序へ修正しました。

## セットアップ

### 1. リポジトリを作成してファイルを配置

```text
your-repo/
├── .github/workflows/fetch_artist.yml
├── .github/workflows/monitor_accounts.yml
├── scripts/fetch_artist.py
├── scripts/monitor_accounts.py
├── data/artists.json
├── archive_helper.html
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

### 4. index.html の設定画面に入力

| 項目 | 内容 |
|------|------|
| Personal Access Token | 上で発行したトークン |
| owner | GitHubユーザー名 |
| リポジトリ名 | このリポジトリ名 |
| ファイルパス | `data/artists.json`（デフォルト） |

## 使い方

1. 「＋ 作者を追加」から X アカウント名を入力して追加
2. GitHub Actions がプロフィールを取得
3. 「GitHubから読込」で最新データを反映
4. `archive_helper.html?x=<Xアカウント名>` を開く
5. 「X URLをコピー」→「archive.mdを開く」でブラウザ保存
6. 保存された archive URL をヘルパーへ貼り付ける
7. 「はてブ追加画面を開く」からブックマーク登録
8. 定期監視は `Monitor X accounts` workflow が毎日実行

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
      "works": []
    }
  ]
}
```
