# X アーカイブ・アカウントトラッカー

Xアカウントを「監視のみ」と「記録対象」に分けて管理するツールです。GitHub Actionsでプロフィール取得と死活監視を行い、記録対象についてはブラウザからarchive.md保存とはてなブックマーク登録を行います。

## 運用区分

- **監視のみ (`monitor_only`)**: 定期的な死活監視のみ。archive.md保存・はてブは行いません。
- **記録対象 (`record`)**: 死活監視に加えて、archive.md保存とはてなブックマーク用の導線を表示します。

## 完成済み

- ブラウザ上でのXアカウント追加・編集・削除、関連URLとメモの管理
- `data/artists.json` の GitHub Contents API 経由での読み書き
- 保存済みGitHub設定がある場合、ページ起動時に最新の `data/artists.json` を自動読込
- 個別プロフィール取得と一括プロフィール取得
- 一括取得の `missing_only`（取得済みはスキップ）/ `all` モード
- ログインやX Developer APIを使わない公開プロフィールの定期確認
- `active` / `unavailable` の状態変化と時刻・理由の履歴記録
- 通信失敗・レート制限を `unknown` とし、明示的な未検出が3回連続するまで状態を変えない保守的な判定
- `tracking_mode` による「監視のみ」「記録対象」の分離
- 記録対象だけに `archive_helper.html` への導線を表示
- `archive_helper.html` からarchive.mdの保存結果URLをGitHubへ記録
- archive保存結果を `archive_status: pending | done` として管理し、トラッカー画面へ反映

## archive.md・はてなブックマークの仕様

GitHub-hosted Actionsからarchive.mdへ保存するとHTTP 429になったため、archive.md保存は通常ブラウザから行います。

- **archive.mdの既定対象**: `https://x.com/<ユーザー名>` の通常プロフィール
- **archive.mdの任意対象**: 必要な場合だけ `https://x.com/<ユーザー名>/with_replies` へ切り替え可能
- **はてなブックマークの既定対象**: 常に `https://x.com/<ユーザー名>` の通常プロフィール
- **archive URLのはてブ**: 通常は行わず、必要な場合だけ任意で利用

`archive_helper.html?x=<Xアカウント名>` を使うと、通常プロフィールのはてブ、archive対象URLの切替、archive.md起動、保存結果のGitHub記録を1画面で行えます。

例:

```text
archive_helper.html?x=tawakenai_marou
```

ブラウザ側からarchive.mdへ自動POSTはせず、利用者の通常ブラウザ操作で保存します。archive.mdで保存後、完成したarchive URLをヘルパーへ貼り付けて「保存結果をGitHubへ記録」を押します。

`/wip/` のarchive URLは `archive_status: pending`、完成URLは `archive_status: done` として `data/artists.json` に保存されます。一度 `done` になった記録対象は保存済みとして扱い、定期的な再保存は要求しません。

## 制約

- archive.mdでの保存操作と、はてなブックマークへの最終登録は利用者が行います。ログイン情報やOAuth認証をリポジトリに要求しません。
- `unavailable` は公開プロフィールを取得できない状態です。現時点では凍結と削除を完全には区別できないため、`suspended` / `deleted` と断定して記録しません。
- ブラウザごとのGitHub設定は `localStorage` に保存されるため、PCとスマホではそれぞれ設定が必要です。

## セットアップ

### GitHub Pages

Settings → Pages → Branch: `main` / root

### Personal Access Token

Fine-grained PATを使用します。

必要な権限:

- **Contents**: Read and write
- **Actions**: Read and write

`index.html` の設定画面にPAT、owner、repo、`data/artists.json` を入力します。設定はブラウザのlocalStorageに保存されます。設定済みのブラウザでは、次回以降のページ起動時に最新の `artists.json` を自動で読み込みます。

## 使い方

1. 「＋ アカウントを追加」からXアカウントを登録
2. `監視のみ` または `記録対象` を選択
3. GitHubへ保存し、プロフィール取得を実行
4. 設定済みブラウザではページ起動時に最新データが自動反映される。必要な場合は手動で「GitHubから読込」も可能
5. 記録対象の場合は「アーカイブ・はてブ」を開く
6. 通常プロフィール、または必要に応じてリプライ欄をarchive.mdへ保存
7. 保存後のarchive URLをヘルパーへ貼り付け、「保存結果をGitHubへ記録」を実行
8. `archive_status: done` になれば保存完了
9. はてブは通常プロフィールURLを対象に登録
10. `Monitor X accounts` が定期的に死活監視

## artists.json の主要スキーマ

```json
{
  "artists": [
    {
      "id": "一意ID",
      "name": "表示名",
      "x_account": "Xアカウント名（@なし）",
      "tracking_mode": "monitor_only | record",
      "avatar_url": "プロフィール画像URL",
      "note": "メモ",
      "added_at": "2026-08-19",
      "fetch_status": "pending | done | error | none",
      "profile_fetched_at": "2026-08-19",
      "archive_status": "pending | done",
      "archive_url": "https://archive.md/...",
      "archive_target_url": "https://x.com/<ユーザー名>",
      "archive_checked_at": "2026-08-22T00:00:00.000Z",
      "monitoring": {
        "status": "unknown | active | unavailable",
        "last_checked_at": "2026-08-19T00:00:00+00:00",
        "last_result": "active | unavailable | unknown",
        "consecutive_unavailable": 0
      },
      "status_history": [],
      "works": []
    }
  ]
}
```
