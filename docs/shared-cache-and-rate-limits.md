# 共有キャッシュと階層型レート制限

## 接続と障害時の動作

`REDIS_URL` を設定すると開発・テスト・本番の区別なく ioredis を利用します。
未設定時のみ、開発用の上限付きメモリストアを使用します。
`docker compose up -d redis` はローカルホスト限定の Redis を起動します。
本番は専用Redis、認証、TLS（rediss）、閉じたネットワークを設定してください。
URL・トークン・個人識別子はログや管理画面に返しません。

- 接続待ち200ms、コマンド待ち250ms、オフラインキュー無効。再接続は最大2秒のバックオフです。
- キャッシュ障害はDB読み取りへフォールバックします。内容キャッシュを各プロセスの別々なメモリに切り替えません。
- 分散レート制限障害は503とRetry-Afterを返します。独立した枠へ切り替えて上限を突破するfail-openは行いません。
- Redisのnoevictionを使用します。満杯時はキャッシュDBバイパス／制限503となります。レート制限キーを追い出す設定は不可です。
- 旧固定窓ストアも単一Luaによる不可分consume、ミリ秒TTL、短い接続待ちを維持します。

## 認証キャッシュ

JWTの署名、access種別、有効期限、正の整数userIdを先に検証します。
プロフィールTTLは全バックエンド共通の5分です。キーは `cms:v1:cache:auth:<世代>:<userId>`。
パスワード、リフレッシュトークン、JWT本体は保存しません。

全ヒットでDBの存在・role・updatedAtを確認します。その組み合わせが一致する場合だけ
上限付きの5分L1プロフィールを使い、L1ミス時はRedisを共有します。
Redis無効化に失敗しても削除済みユーザーや降格前の管理者権限は復活しません。
同じミリ秒のupdatedAtを強制してもrole変更は検出します。
通常のプロフィール変更はupdatedAtにより無効化されます。DB外部ツールでupdatedAtを
意図的に保存したまま名前・メールだけを変更した場合、プロフィール表示は最長5分遅れるため、
その場合は `sharedCache.invalidate('auth')` も実行してください。

各MemoryCacheStoreは1000件かつ8,388,608 UTF-16文字、1値1Mi文字以下です。
文字列表現により最大約16MiB相当の値にMap等の管理領域が加わります。
L1と共有メモリキャッシュにはそれぞれこの上限があります。

## 公開レスポンスキャッシュ

`createContentCache({nextPublication})` をAPIルーターの前に適用します。
匿名GETの `/api/posts[/数値ID]` と `/api/categories[/数値ID]` だけを対象とし、
Authorization/Cookie、認証系、エラー、ストリーム、private/no-store、Set-Cookieを除外します。
キーはパス、完全なクエリ文字列、DB版、次の公開時刻を含みます。TTLは最大60秒で
次の公開時刻までに短縮し、毎回スケジュールを再確認します。取得に失敗するとバイパスします。
JSONをレスポンス境界で保存し、Date等のサービス型を変えません。

成功した変更APIはcontent世代を無効化します。サービスを直接呼ぶ経路も
成功した変更後に `sharedCache.invalidate('content')` をawaitしてください。
更新前に開始したキャッシュfillは古い世代にしか書き込めません。

Redis切断中の変更や直接DB変更による古い公開内容の漏洩を防ぐため、SQLiteの
CacheRevisionと36トリガーによる版を毎回読みます。変更と版更新は同一トランザクションです。
`20261006190000_content_cache_revision` マイグレーションにモデルと36トリガーを含めています。
新規環境は `prisma migrate deploy` で適用してください。既存 db-push 環境は
[移行ガイド](migrations.md) に従って検証し、未確認の DB を自動リセットしないでください。
対象モデルはPost,Category,CategoryOnPost,Tag,TagOnPost,Comment,Reaction,Bookmark,
Follow,PostView,Notification,Userです。User更新はname/email/roleに限定します。
テーブル、content行、必要なトリガーのいずれかが欠ける場合はキャッシュを使いません。
`prisma db push` だけではトリガーは入りません。運用・CIとも `prisma migrate deploy` が必要です。

## 階層とアルゴリズム

共通の全サーバー枠、接続元IP、認証済みユーザー、認証・アップロードAPI、短期バースト、
設定した制限対象IPの全階層を同じLuaで判定し、許可時だけ全ての枠を記録します。
Redis TIMEを基準にしたSliding Window Log（sorted set）です。拒否は他階層を消費しません。
全体の上限は管理者にも適用し、ユーザー等の枠だけadminMultiplierで緩和します。
認証成功したユーザーにはIP/短期枠を2倍、管理者は設定倍率まで緩和します。
認証失敗や上限超過アップロードは3回目から1/2/4/.../60秒の一時制限となり、
15分間再発しなければ失効します。エラー例外からの401/423も計測します。

Token Bucketは継続的な補充が必要な用途では有効ですが、厳密な任意の時間窓の上限を
守るため採用せず、1秒の短期Sliding Windowを重ねてバースト量を明示的に制限しています。
MemoryHierarchicalStoreは最大10000窓/10000ペナルティで、満杯時は拒否します。
設定値のmaxは10000、倍率は10、窓は最大24時間です。Redisは専用のmaxmemoryで制御します。

`RATE_LIMIT_POLICY` はJSONでglobal,ip,user,auth,upload,burstの `{max,windowMs}`、
adminMultiplier、trustedProxies配列、restrictedIPsのIP別設定を受け付けます。
不明なキー、不正な窓、無制限値は起動時に拒否します。
trustedProxiesの初期値は空です。Bunの実際の接続元を使用し、明示したプロキシだけの
X-Forwarded-Forを右端から検証します。IP表記を正規化し、不正ヘッダーや任意のJWT roleで回避できません。

## 観測と管理画面

各応答にX-RateLimit-Limit/Remaining/Reset/Policy、拒否にはRetry-Afterを返します。
拒否・障害ログは最初と100回ごとに集計し、IPやユーザー情報は含めません。
`/api/admin/rate-limits/status` はDBで検証済み管理者だけにno-storeで集計を返します。
`/api/admin/rate-limits/dashboard` は静的なフォームです。入力したアクセストークンは
同一オリジンのstatus取得だけに使用し、ブラウザ永続領域に保存せず取得後に消去します。
数値は明記したとおりプロセス単位です。Redis共通枠そのものは全サーバーで共有されます。

## 検証と性能

`REDIS_TEST_URL=redis://127.0.0.1:6379 bun test` で実Redisの複数クライアント・TTL・Luaを検証します。
`REDIS_TEST_SERVER=/path/to/redis-server bun test src/tests/redis-recovery.test.ts` は
専用Redisを起動・停止・再起動し、永続化された制限と失敗した無効化の回復を検証します。
共有テストサーバーは停止しません。

`REDIS_TEST_URL=redis://127.0.0.1:6379 BENCH_SAMPLES=3000 bun src/scripts/benchmark-cache.ts`
で同じJWT付きリクエストをDB直接／メモリ／Redis構成の順序を交替して測定します。
既存のマイグレーション済みテストDBをDATABASE_URLに指定してください。
壁時計性能はCIの合否条件にしません。詳細はcache-benchmark-2026-10-06.jsonに保存しています。

2026-10-06、Bun1.4.2/SQLite/ローカルRedis7.2.5、3回各3000リクエストのウォーム中央値:

- DB直接: 0.5823 / 0.5959 / 0.6038 ms
- メモリ構成: 0.5899 / 0.5878 / 0.6178 ms（各回+1.31% / -1.35% / +2.31%）
- Redis構成: 0.5926 / 0.5789 / 0.6152 ms（各回+1.77% / -2.85% / +1.89%）

この条件のウォーム経路は±10%以内でした。DB検証済みL1が効いた結果であり、ネットワーク越しの
Redisミスやコールド経路まで±10%とする保証ではありません。コールド結果・p95もJSONに含みます。
初期のL1なし実装はRedis往復で+80%となったため、原本DBの検証を省略せずL1で改善しました。
3000個の16Ki文字列を投入しても512個/8Mi文字で上限となり、実測ヒープ増加は約8.5MBでした。

CDN、DB分割、読み書き分離は現在のSQLite単一書き込み構成には適用していません。
将来DB移行時は同じトランザクション版更新の仕組みを移植し、公開キャッシュの安全性を保持してください。

レート制限の拒否は `code: RATE_LIMITED`、Redis 制限サービスの障害は
`code: RATE_LIMIT_UNAVAILABLE` を返します。本文キャッシュのキーには DTO 版も含め、
異なるレスポンス形式の混在を避けます。
