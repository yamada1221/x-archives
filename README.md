# X アーカイブ・アカウントトラッカー

Xアカウントを「監視のみ」と「記録対象」に分けて管理するツールです。GitHub Actionsでプロフィール取得と死活監視を行い、記録対象についてはブラウザからarchive.md / archive.li保存とはてなブックマーク登録を行います。

## 運用区分

- **監視のみ (`monitor_only`)**: 定期的な死活監視のみ。Archive保存・はてブは行いません。
- **記録対象 (`record`)**: 死活監視に加えて、archive.md / archive.li保存とはてなブックマーク用の導線を表示します。

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

## Xアカウント監視の取得経路

FxTwitterの公開プロフィールAPI (`https://api.fxtwitter.com/2/profile/{handle}`) を優先します。Xのログイン、X Developer APIトークン、PCの常時起動は不要です。取得はGitHub Actionsから行います。

- プロフィールのユーザー名・数値IDが照会対象と一致した場合だけ存在確認として扱います。非公開アカウントも存在確認に含みます。
- 初回取得時に `x_user_id` を保存し、次回から数値IDで同じアカウントを追跡します。ユーザー名が変わった場合は一覧に表示し、`monitoring.observed_username` に現在の名前を記録します。登録名や過去のアーカイブURLは自動変更しません。
- 明示的な `reason: suspended` は凍結の根拠、`User not found` は未検出の根拠として別々に記録します。未検出だけで削除とは断定しません。
- 同じ理由の利用不可が3回蓄積するまで確定しません。途中で存在確認できた場合、または理由が変わった場合はカウントをリセットします。通信失敗・取得制限は `unknown` として保留します。
- 最初の1〜2回は「凍結の疑い」「消失の疑い」、確定後は「凍結」「見つからない」を表示します。現在の運用は日次監視なので確定まで数日かかる場合があります。
- 毎回、既知の正常アカウントを数値IDで確認し、取得経路全体の異常を検出します。FxTwitterで判定できず、まだ数値IDがない場合だけ従来のX公開エンドポイントへフォールバックします。ID取得後は別人に再利用されたユーザー名へ追従しません。
- 全件判定不能の場合も記録を保存し、その後Actionsを失敗にします。件数と取得経路の確認結果はActionsの実行サマリーで確認できます。

2026-09-23のGitHub Actions実測で、正常・凍結・未検出と数値ID照会を確認しました。外部サービスの仕様変更やキャッシュによる遅延はあり得るため、各記録に最終試行日時と最終確定日時を保持します。

今回の変更は監視結果の記録・一覧表示までです。メール等への状態変化通知と短い間隔での再確認は未実装です。

## archive.md / archive.li・はてなブックマークの仕様

GitHub-hosted ActionsからArchive系サービスへ保存すると制限を受ける場合があるため、archive.md / archive.li保存は通常ブラウザから行います。

- **Archiveの既定対象**: `https://x.com/<ユーザー名>` の通常プロフィール
- **Archiveの任意対象**: 必要な場合だけ `https://x.com/<ユーザー名>/with_replies` へ切り替え可能
- **はてなブックマークの既定対象**: 常に `https://x.com/<ユーザー名>` の通常プロフィール
- **archive URLのはてブ**: 通常は行わず、必要な場合だけ任意で利用

`archive_helper.html?x=<Xアカウント名>` を使うと、通常プロフィールのはてブ、archive対象URLの切替、archive.md / archive.li起動を1画面で行えます。

例:

```text
archive_helper.html?x=tawakenai_marou
```

ブラウザ側からArchive系サービスへ自動POSTはせず、利用者の通常ブラウザ操作で保存します。これはGitHub Actionsの共有IPからレート制限を受け続けることを避けるためです。

保存後は `archive_helper.html` から保存済み状態をGitHubへ反映できます。一度保存済みになれば完了扱いとし、定期的な再保存は要求しません。

## 制約

- はてなブックマークへの最終登録は利用者が行います。ログイン情報やOAuth認証をリポジトリに要求しません。
- `unavailable` の詳細は `monitoring.last_reason` / `confirmed_reason` に記録します。明示的な凍結と未検出を区別しますが、削除・一時停止などを未検出だけで断定しません。
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
6. 通常プロフィール、または必要に応じてリプライ欄をarchive.mdまたはarchive.liへ保存
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
      "x_user_id": "数値ユーザーID（文字列、取得後に追加）",
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
        "last_source": "fxtwitter | x_public",
        "last_reason": "suspended | not_found | 空文字列",
        "confirmed_reason": "suspended | not_found | 空文字列",
        "last_confirmed_at": "2026-08-19T00:00:00+00:00",
        "consecutive_unavailable": 0
      },
      "status_history": [],
      "works": []
    }
  ]
}
```
