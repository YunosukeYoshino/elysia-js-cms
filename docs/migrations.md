# SQLite マイグレーションの運用

新規環境では、秘密値と DATABASE_URL を設定して `bunx prisma migrate deploy` を実行し、
`bunx prisma generate` でクライアントを生成します。CI の migrations.test.ts は最初の
スキーマに実データを入れた一時 DB を最新まで移行し、ハッシュ・投稿の保持と
`prisma migrate diff --exit-code` によるスキーマ一致を検証します。

20261006000000_auth_security は、これまで db push でしか作成されていなかった
認証失敗回数・ロック・パスワードリセット列と RefreshToken を補います。
既存マイグレーションの内容やチェックサムは変更していません。

## 過去に db push した既存 DB

この DB には履歴と実スキーマのずれがあり得ます。新規向けの migrate deploy を
そのまま実行したり、reset/db push --accept-data-loss で解決したりしないでください。
まず停止計画と検証済みバックアップを用意し、そのコピーで次を確認します。

1. `_prisma_migrations` と `PRAGMA table_info` / sqlite_master を読み、どの変更が既に
   存在するか確認します。コピー以外を操作しません。
2. 各移行後スキーマとの `prisma migrate diff` を確認します。既に完全に一致する
   マイグレーションだけ、検証用コピーで `prisma migrate resolve --applied <名前>` により
   適用済みとして記録します。名前だけで判断せず、列・制約・インデックスも比較します。
3. 未適用分をコピーに deploy し、このリポジトリのテストと認証・投稿・ファイルの
   業務確認を行います。途中までの列追加など部分的な状態は自動で推測修復しません。
4. 差分と復旧手順をレビューし、運用責任者の承認後に本番のメンテナンスを計画します。

この変更およびテストは本番 DB のベースライン設定や移行を自動実行しません。
