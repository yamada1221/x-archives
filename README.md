# X アーカイブ・アカウントトラッカー

Xアカウントを「監視のみ」と「記録対象」に分けて管理するツールです。GitHub Actionsでプロフィール取得と死活監視を行い、記録対象についてはブラウザからarchive.md保存とはてなブックマーク登録を行います。

## 運用区分

- **監視のみ (`monitor_only`)**: 定期的な死活監視のみ。archive.md保存・はてブは行いません。
- **記録対象 (`record`)**: 死活監視に加えて、archive.md保存とはてなブックマーク用の導線を表示します。

## 完成済み

- ブラウザ上でのXアカウント追加・編集・削除、関連URLとメモの管理
- `data/artists.json` の GitHub Contents API 経由での読み書き
- 個別プロフィール取得と一括プロフィール取得
- 一括取得の `missing_only`（取得済みはスキップ）/ `all` モード
- ログインやX Developer APIを使わない公開プロフィールの定期確認
- `active` / `unavailable` の状態変化と時刻・理由の履歴記録
- 通信失敗・レート制限を `unknown` とし、明示的な未検出が3回連続するまで状態を変えない保守的な判定
- `tracking_mode` による「監視のみ」「記録対象」の分離
- 記録対象だけに `archive_helper.html` への導線を表示
- archive保存済み状態を `data/artists.json` に記録し、一覧で「保存済み」と表示
- 保存済みのGitHub設定がある場合、ページ起動時に最新の `data/artists.json` を自動読込

## archive.md・はてなブックマークの仕様

GitHub-hosted Actionsからarchive.mdへ保存するとHTTP 429になったため、archive.md保存は通常ブラウザから行います。

- **archive.mdの既定対象**: `https://x.com/<ユーザー名>` の通常プロフィール
- **archive.mdの任意対象**: 必要な場合だけ `https://x.com/<ユーザー名>/with_replies` へ切り替え可能
- **はてなブックマークの既定対象**: 常に `https://x.com/<ユーザー名>` の通常プロフィール
- **archive URLのはてブ**: 通常は行わず、必要な場合だけ任意で利用

`archive_helper.html?x=<Xアカウント名>` を使うと、通常プロフィールのはてブ、archive対象URLの切替、archive.md起動を1画面で行えます。

例:

```text
archive_helper.html?x=tawakenai_marou
```

ブラウザ側からarchive.mdへ自動POSTはせず、利用者の通常ブラウザ操作で保存します。これはGitHub Actionsの共有IPからレート制限を受け続けることを避けるためです。

保存後は `archive_helper.html` から保存済み状態をGitHubへ反映できます。一度保存済みになれば完了扱いとし、定期的な再保存は要求しません。

## 制約

- はてなブックマークへの最終登録は利用者が行います。ログイン情報やOAuth認証をリポジトリに要求しません。
- `unavailable` は公開プロフィールを取得できない状態です。現時点では凍結と削除を完全には区別できないため、`suspended` / `deleted` と断定して記録しません。
- GitHub設定はブラウザのlocalStorageに保存されるため、PCとスマホでは別々に設定が必要です。

## セットアップ

### GitHub Pages

Settings → Pages → Branch: `main` / root

### Personal Access Token

Fine-grained PATを使用します。

必要な権限:

- **Contents**: Read and write
- **Actions**: Read and write

`index.html` の設定画面にPAT、owner、repo、`data/artists.json` を入力します。設定はブラウザのlocalStorageに保存されます。

## 使い方

1. 「＋ アカウントを追加」からXアカウントを登録
2. `監視のみ` または `記録対象` を選択
3. GitHubへ保存し、プロフィール取得を実行
4. 保存済みのGitHub設定があれば、次回以降はページ起動時に最新データを自動読込
5. 記録対象の場合は「アーカイブ・はてブ」を開く
6. 通常プロフィール、または必要に応じてリプライ欄をarchive.mdへ保存
7. 保存完了後、保存済み状態をGitHubへ反映
8. はてブは通常プロフィールURLを対象に登録
9. `Monitor X accounts` が定期的に死活監視

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
      "archive_status": "done",
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
