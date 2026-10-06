# コメント・ユーザーインタラクション API

Issue #4 の実装。既存 API の URL とリクエスト形式は変更せず、以下を `/api` 配下へ追加する。
認証は既存の `Authorization: Bearer <accessToken>`。Swagger の `interactions` タグでも確認できる。

## コメントと承認

| メソッド / パス | 機能 | 権限 |
| --- | --- | --- |
| `GET /posts/:postId/comments` | ルートコメント一覧。`parentId` で返信へ絞り込み | 公開済みは全員。未承認は本人・管理者 |
| `POST /posts/:postId/comments` | `{ "content": "本文", "parentId": 123 }`。`parentId` は省略可能 | 認証必須 |
| `GET /comments/:id` | コメント詳細 | 同上 |
| `GET /comments/:id/replies` | 直下の返信一覧 | 同上 |
| `PUT /comments/:id` | `{ "content": "新しい本文" }` | 本人または管理者 |
| `DELETE /comments/:id` | 本文・リアクション・通知を削除、返信の位置を保持 | 本人または管理者 |
| `GET /moderation/comments` | 管理者の承認キュー。`status=pending` が既定 | 管理者 |
| `PUT /comments/:id/moderation` | `{ "status": "approved", "expectedRevision": 1 }` または `rejected` | 管理者 |

- 新規コメントは管理者の投稿も含めて `pending`。`201` を返す。本文を変更すると再び `pending` になる。内容が同じ編集は状態を変えない。
- `published` は API 上の互換的な派生値で、保存された `status === 'approved'` に対応する。
- 本文はトリム後 1〜5000 文字。HTML として実行・変換しない。表示するクライアントは必ずテキストとして扱うか、適切にエスケープする。
- 返信先は同じ投稿の承認済みコメントのみ。ルートの `depth=0` から最大 `depth=5`。API は無制限の再帰ツリーを返さず、各階層を個別にページ取得する。
- 親が未承認になった場合、その配下は一般公開・リアクション・公開件数・第三者向け通知から隠れる。本人は自分のコメント、管理者はキューを確認できる。
- 削除済みの承認コメントは `deleted: true, content: null, author: null` の墓石として残る。既存の返信は維持するが、削除済みコメントへの新規返信・編集・リアクションは不可。
- 非公開に戻った投稿では、コメントを含む公開インタラクションを表示しない。本人による削除と管理者のキュー確認は可能。

## リアクション・ブックマーク・フォロー

| メソッド / パス | 機能 |
| --- | --- |
| `GET /posts/:postId/reactions` | 種類別 `counts` と認証本人の `mine` |
| `PUT /posts/:postId/reactions` | `{ "type": "like" }` を追加 |
| `DELETE /posts/:postId/reactions/:type` | 本人の選択を解除 |
| `GET /comments/:id/reactions` | コメントの集計 |
| `PUT /comments/:id/reactions` | コメントに追加 |
| `DELETE /comments/:id/reactions/:type` | コメントの選択を解除 |
| `PUT /posts/:postId/bookmark` | ブックマーク追加 |
| `DELETE /posts/:postId/bookmark` | 本人のブックマーク解除。投稿非公開後も解除可能 |
| `GET /me/bookmarks` | 本人の保存一覧。現在非公開の投稿は隠す |
| `PUT /users/:id/follow` | フォロー追加 |
| `DELETE /users/:id/follow` | 本人のフォロー解除 |
| `GET /me/following` | 本人のフォロー一覧 |
| `GET /me/followers` | 本人のフォロワー一覧 |

変更操作と `/me/*` は認証必須。リアクションは `like / love / laugh / wow / sad`。
同一利用者・対象・種類への追加は冪等で、種類ごとに一件。非公開化後も本人のリアクションは解除可能。自分自身へのフォローは禁止する。
ブックマーク・フォロー関係・リアクションした利用者の全一覧は公開しない。利用者情報は ID と表示名だけを返し、メールや認証関連情報を含めない。

## 閲覧数と人気順

- `POST /posts/:postId/views`：認証済み利用者の閲覧を明示的に記録する。`{ "views": 3 }` を返す。
- `GET /posts/:postId/interactions`：`{ "views": 3, "reactions": 2, "comments": 1 }`。コメント件数は現在公開できる非削除コメントだけ。
- `GET /posts/popular`：現在公開されている投稿を「日次ユニーク閲覧の累計 → 投稿リアクション数 → ID」の降順で返す。`_count.views / _count.reactions` がランキング指標。

閲覧は利用者・投稿・UTC 日付の組み合わせで一件。再送・並列リクエストを重複計上しない。別の日の閲覧は一件追加する。
既存の投稿 GET に副作用を加えず、匿名アクセス・クローラーは数えない。IP・端末識別子は保存しない。
この指標は同一アカウント内の重複を抑える簡易人気指標であり、複数アカウントによる不正の完全防止を保証しない。
公開予約は共通の `publicPostWhere` に従い、予定時刻を過ぎた投稿は公開として扱う。

## 永続化された通知

- `GET /notifications?unread=true`：本人宛のみ。`data, meta, unread` を返す。`unread` は現在アクセス可能な未読総数。
- `PUT /notifications/:id/read`：本人宛の一件を既読化する。再送も成功する。他人の通知 ID は `404`。
- 通知種別は `comment / reply / reaction / follow / moderation`。
- コメントは承認後に投稿者へ、返信は返信先の著者へ通知する。同じ相手が投稿者と返信先を兼ねる場合は返信通知一件だけ。管理者による承認・却下はコメント著者に結果通知を保存する。
- 管理者の新規承認依頼は `/moderation/comments?status=pending` の永続キューで確認する。管理者人数に比例する無制限の通知展開は行わない。
- 自分自身の操作による通知は省略する。再送・解除再追加・再承認でも同じコメント／返信／リアクション／フォローイベントの通知は増やさない。編集後の承認結果はリビジョンごとに保存する。
- 通知にコメント本文のコピーは保存しない。取得・既読時には関連投稿・コメントと祖先の公開状態も検証するため、承認取消・投稿非公開後に古い通知から情報が漏れない。
- コメント削除時は関連通知も消す。投稿削除時はすべての関連インタラクションを外部キーで削除する。

### リアルタイム通知の設計範囲

この実装は永続 REST 通知と認証付きポーリングを提供する。WebSocket は技術検討事項として、認可失効・JWT 更新・複数プロセスへの配信・再接続時の欠落防止を安全に解決してから追加する。
初期クライアントは表示中のみ 30〜60 秒間隔で `/notifications?unread=true` を取得し、バックグラウンドでは停止する。未読状態は DB が正本であり、プロセス再起動でも失わない。
WebSocket を後から導入する場合も通知 ID の更新シグナルだけを送り、本文は同じ認証済み REST API から再取得する。

## 制限・整合性・キャッシュ

- 新しい一覧の `take` は 1〜50（既定 20）、`skip` は 0〜10000（既定 0）、`sort` は `newest / oldest`（既定 newest）。人気順のみ `sort` にかかわらず指標の降順。ID は同時刻の安定順序を保証する。
- アカウントごとの書き込み上限は 1 分間にコメント作成 10、編集・削除 20、リアクション／ブックマーク／フォロー／閲覧は各 60、モデレーション 100、既読 120。`429` と `Retry-After: 60` を返す。
- 制限状態は各アカウント・操作につき一行で DB に保存する。プロセス再起動・複数インスタンスでも共有する。同じ本文の同一投稿・返信先への 1 分以内の再送は `409`。
- 変更・通知・制限カウンターは一つのトランザクション。失敗は一括ロールバックする。同時変更の一部だけが残る状態を作らない。SQLite 競合のみロールバック後に限定回数再試行する。
- 参照用 API には `Cache-Control: private, no-store`。未承認コメントや通知を CDN の共有キャッシュへ保存しない。人気順はまず索引付き DB 集計を使う。将来共有キャッシュを追加する場合は公開状態の変更・予約時刻到達・削除を失効条件とし、利用者固有データは混ぜない。
- 反応の nullable target に対する単一複合 unique では SQLite の NULL 比較により重複を防げないため、投稿用・コメント用の二つの unique 制約を採用する。

## マイグレーションと検証

`20261006183000_comments_interactions` は新しいテーブル・索引・外部キーを追加する。既存投稿と利用者を消去しない。
SQL には Prisma schema だけで表現できない制約も含まれる：リアクション対象は厳密に一つ、許可された種類、自己フォロー禁止、コメント状態・深さ・本文・親投稿の整合性、スレッドの付け替え禁止。

通常のデプロイはバックアップと既存マイグレーション履歴の確認後に `bun prisma migrate deploy`、次に `bun prisma generate` を実行する。
`prisma db push` は開発用スキーマ同期で、SQL の CHECK・トリガーを作成しない。実環境ではマイグレーションを正本とし、後続マイグレーションのテーブル再構築時にも CHECK・トリガーを保持する。

検証コマンド：

```bash
bun prisma validate
bun run typecheck
bun run check
bun test src/tests/interactions.test.ts src/tests/interactions-migration.test.ts
bun test
```

API の認可・公開境界・承認と再承認・多階層返信・墓石・通知所有者・同時再送・DB 制約・ロールバック・Cascade を回帰テストする。DB 制約のテストは実際の SQL マイグレーションをメモリ内 SQLite に適用し、開発用 `db push` だけでは検証できない制約も確認する。

承認キューが返す `revision` を `expectedRevision` に指定してください。内容編集・状態変更後の古い承認は409になり、再取得・再確認が必要です。
