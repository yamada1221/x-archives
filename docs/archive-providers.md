# アーカイブ先・API調査

最終確認: 2026-10-17（日本時間）。公開仕様と少数の実測による確認です。1件の成功を全アカウント・全投稿への対応保証とは扱いません。

## Xプロフィールの実測

対象: `https://x.com/X`

- ウェブ魚拓: 2026-10-17 05:47取得。人間確認後に保存が完了し、自己紹介文、アイコン、フォロー数・フォロワー数、直近5件の投稿本文を結果画面で確認。全投稿・動画の保存は未検証。
  - 結果: https://megalodon.jp/2026-1017-0547-37/https://x.com:443/X
- Wayback Machine: Save Page Nowでサイトの保存制限を示す画面となり失敗。原因の詳細は表示されず。
- Ghostarchive: 結果URLは発行されたが、後日の再確認でも処理中。本文保存の成功は未確認。

魚拓を半自動保存先として追加。対象URLを入力済みの取得確認画面へ移動し、人間確認・取得操作は利用者が行います。取得開始後はタブを閉じても魚拓側で継続します。結果URLは処理中でも同じなので、本文確認チェックなしでは「内容未確認」、チェックありで「保存済み」と記録します。登録後の本文検証はGitHub Actionsで自動実行します。保存開始の人間確認・取得操作は手動です。

| 保存先 | 今回の対応 | API・運用条件 |
| --- | --- | --- |
| ウェブ魚拓 | URLを入力済みの取得画面を開く。日時付きの結果URLと本文確認を記録 | 無料版で1プロフィール保存を実測。人間確認あり。公式の保存作成API仕様は確認できず |
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

## その他の候補（新規保存は未検証）

- Arquivo.pt ArchivePageNow: URLを入力して閲覧しながら記録。X取得の成功は未確認。
  https://sobre.arquivo.pt/en/savepagenow-to-record-webpages-immediately-on-arquivo-pt/
- ArchiveWeb.page: PCのChromium拡張・デスクトップアプリで閲覧中の内容を記録。自前の記録方式であり、無料公開URL発行サービスとは異なります。
  https://archiveweb.page/
- Conifer: 新規保存終了への移行が告知されているため新規導入候補から除外。
  https://blog.conifer.rhizome.org/2025/12/15/twilight-announcement.html
- ウェブ魚拓FAQ: https://megalodon.jp/pc/page/qa

## 魚拓プロフィールの自動確認

`verify_gyotaku.yml` はデータ更新時と6時間おきに実行。1回最大10件を、最終確認が古い順に確認します。GitHub Actionsの起動遅延やアクセス制限時は未確認のまま残ります。

- 新規保存要求は出さず、登録済みの `megalodon.jp` の結果HTMLと、その結果ページが参照する同じ魚拓の `/ref/` 本文だけを取得します。リダイレクトや任意の外部リンクは追いません。
- 対象プロフィールURL・ハンドル・フォロー一覧リンク・自己紹介文が保存HTML本文内に揃う場合だけ `done` にします。メタデータだけ、HTTP 200だけ、結果URL発行だけでは成功扱いにしません。
- 空の自己紹介、個別投稿、リプライ欄、HTML構造変更、取得制限、タイムアウトは自動成功判定できません。「内容未確認」のままにし、任意の手動確認を残します。全投稿・画像・動画の完全保存を保証する判定ではありません。
- 成功時は `content_verified_at` / `verification_method`、試行時は `verification_checked_at` / `verification_result` を記録します。既存の完成アーカイブやアカウント監視状態を未確認結果で上書きしません。
- 2026-10-17取得のX公式プロフィールについて、実際の保存HTMLで `profile_body_confirmed` を確認しました。
