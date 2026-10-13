# アーカイブ先・API調査

調査日: 2026-10-13（日本時間）。サービスの公開説明と公式ドキュメントを確認したものです。各サービスによるXプロフィール本文の保存成功は今回実測していません。

| 保存先 | 今回の対応 | API・運用条件 |
| --- | --- | --- |
| archive.md / archive.li | 既存のブラウザ保存を維持。保存先の選択と結果URLの複数保持 | 同じarchive.today系。ミラーを変えても独立した保存サービスが増えるわけではありません。従来どおり手動保存 |
| Ghostarchive | URLをコピーして保存画面を開く。`/archive/…` の結果を記録 | 公式FAQでは無料・アカウント不要。APIの説明はMemento対応準備中で、安定した保存作成APIの仕様は確認できず。今回はブラウザ操作のみ |
| Wayback Machine | Save Page Nowを開く。過去の保存検索と、日時つきの保存結果URLの記録 | 公式アプリにSPN2連携の実装あり。今回は認証やAPI自動保存を組み込まず、公式保存フォームを利用。取得制限やログイン依存のページでは保存に失敗する可能性あり |
| Perma.cc | URLをコピーしてサービスを開く。`XXXX-XXXX` 形式の結果を記録 | 公式REST APIあり。作成は `POST https://api.perma.cc/v1/archives/` にURLをJSON送信、`Authorization: ApiKey …` で認証。完了判定はCapture Jobs APIで確認。アカウント・保存枠が必要 |
| Browsertrix | 今回は調査のみ | 公式APIとセルフホスト手順あり。継続的なブラウザクロール向け。専用の運用環境・アカウント等を用意してから検討 |

Perma.cc公式ガイドは、一般利用者には10件の試用、その後は保存枠に応じた有料契約が必要と説明しています。契約・課金・APIキーの登録は今回行っていません。

## 保存結果の扱い

- 保存先を開く操作と、保存結果を記録する操作を分離しています。開いただけでは「保存済み」になりません。
- トップページ・検索結果・保存フォームURLは結果として登録できません。Xのログイン画面だけが保存される場合もあるため、利用者が内容を確認してから結果URLを登録します。URL形式の検証は保存内容の検証ではありません。
- `archives` 配列にサービス・URL・対象URL・状態・記録日時を保持します。過去の `archive_url` も保持して表示し、同じ結果URLは重複しません。
- 既に完成したアーカイブがあれば、別の保存が処理中でも「保存済み」を保持します。以前の完成結果は消しません。
- 互換用の `archive_status` / `archive_url` は最新の完成結果を指します。完成結果がなければ直近の処理中の結果を指します。
- アカウント監視（FxTwitter）は保存先とは別機能です。FxTwitterをアーカイブサービスとして扱っていません。

## APIで自動化する場合の次の候補

公式の作成・完了確認APIが明記されているPerma.ccから検証するのが実装上は容易です。ただし、APIがあることとX本文を保存できることは別です。まず1件の取得内容を確認し、保存枠・失敗時の扱いを決めてからGitHub Actionsのsecret等を使う構成に進めます。APIキーをリポジトリのファイルやURLへ埋め込まないでください。

## 参照した一次情報

- Ghostarchive FAQ: https://ghostarchive.org/about.html
- Internet Archive 保存ガイド: https://help.archive.org/help/save-pages-in-the-wayback-machine/
- Internet Archive公式AndroidアプリのSPN2実装履歴: https://github.com/internetarchive/wayback-machine-android/blob/master/CHANGELOG.md
- Perma.cc 保存ガイド・制限: https://perma.cc/docs/perma-link-creation
- Perma.cc API仕様: https://perma.cc/docs/developer
- Browsertrix公式ドキュメント: https://docs.browsertrix.com/
- Browsertrix API: https://app.browsertrix.com/api/docs
