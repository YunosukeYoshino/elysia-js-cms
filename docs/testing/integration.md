# サービス統合テストと再現可能な実行環境

## 実行

```sh
bun install --frozen-lockfile
bun prisma generate
bun run typecheck
bun run check
bun run test:ci
```

`test:ci` は全テストを一度だけ実行し、LCOV と表示用レポートを `coverage/` に出力する。
実行時間が 300 秒以上、テスト失敗、サービス未計測、サービスごとの行または関数カバレッジが
90% 未満の場合、非ゼロで終了する。対象は `src/domain/services/*.ts` と `src/services/*.ts`。
テストされない新規サービスを追加してもゲートから漏れない。

`bun test` と `bun run test:integration` でも `bunfig.toml` の preload を使う。
`DATABASE_URL` は開発・本番の値を参照せず、一時ディレクトリの専用 SQLite に置き換える。
`CMS_TEST_DATABASE_URL` を指定する場合は、システムの一時領域内の
`cms-full-suite-*/test.db` または `cms-test-run-*/test.db` だけを許可する。
通常は指定不要で、CI ランナー自身が作成・回収する。
既存 DB の削除、`--accept-data-loss`、開発 DB への schema push は行わない。

`prepareDatabase('test')` は同じプロセスでは `prisma migrate deploy` を共有し、接続中の DB を再作成しない。
DB の CHECK 制約・トリガーも migration を通じて本番と同じように検証する。
サービス統合テストはさらにスイートごとに `createTestDatabase()` を用いて DB を分離する。
`seedUser()` と `seedPosts()` は架空データを生成し、各スイートが所有する一時領域のみを後片付けする。

## Docker

```sh
docker compose -f compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f compose.test.yml down --volumes
```

Bun バージョンを固定し、SQLite と一時ファイルをコンテナ内に閉じ込める。
Redis 7 を同じ使い捨てネットワークで起動し、`REDIS_TEST_URL` で共有キャッシュ／Lua を検証する。
イメージ内の redis-server は停止・再起動テスト専用に利用する。
ホストの DB・アップロード・秘密情報はマウントしない。`.dockerignore` でも除外する。
Docker 実行そのものは Docker が利用できる環境で確認する必要がある。

## 検証範囲

- AuthService: 登録、重複・弱いパスワード、実際の Argon2 検証、ログイン、ロックと失効、
  同時失敗数更新、同時 refresh の一回限り消費、ログアウトと所有者検証。
- 認証トランザクション: refresh の置換失敗で元トークンを復元、ログインでセッション作成が
  失敗した場合にログイン失敗数のリセットもロールバック。
- CategoryService: CRUD、一意制約競合、投稿関連付けの削除禁止、DB エラー、コミット後の無効化通知。
- PostService: 別の検索・投稿テストで CRUD、カテゴリ／タグ関連付け更新のロールバック、公開境界、
  検索・フィルター・ページングを検証。カテゴリ配下でも同じ公開条件を使用する。
- FileService: 本物のディスクと SQLite を使うアップロード、読み取り、縮小画像、所有者・管理者削除、
  DB／画像／書き込み失敗の補償、削除退避・DB 失敗時の復元、復元失敗、削除確定後の掃除失敗。
- HTTP エラー: 名前付き `domainErrorPlugin` を実際の Elysia lifecycle で使い、業務コードと
  400/401/403/404/413/422/423/500 の対応、入力検証、内部情報の非公開を検証。
- 負荷回帰: 1,000 件のカテゴリ依存投稿、2,000 件のファイルに対する 200 回のページ取得。
  GC 後の保持ヒープ増分が 32 MiB 未満であることを確認する。これは無限時間の漏洩不存在の証明ではなく、
  再現可能な保持メモリ回帰チェックである。
- 認証キャッシュ・TTL・容量・共有 Redis の検証はキャッシュ専用テストで行う。

## ファイルと DB の整合性の境界

DB とファイルシステムは分散トランザクションを共有しない。実装は次の補償手順を使う。

1. アップロードの DB 保存に失敗したら原本・縮小版を削除する。
2. 削除は原本・縮小版を同じファイルシステム内の `.delete-*` 名に退避する。
3. DB 削除に失敗したら退避ファイルを復元する。
4. DB コミット後は退避ファイルを削除する。掃除失敗時は `cleanupPending: true` を返す。

確定後に退避ファイルだけが残っても、DB 参照がないため配信エンドポイントからは取得できない。
`UPLOAD_CLEANUP_FAILED` / `FILE_RESTORE_FAILED` はストレージの復旧が必要であることを明示する。
プロセス強制終了やディスク全損を含めた完全な原子性は保証しない。
復旧時は書き込みを止め、DB の fileName と退避ファイルを照合し、DB が残るものを復元、
DB がないものを削除する。DB バックアップとファイルの両方を保全してから実施する。

## 設計

[Elysia の公式ベストプラクティス](https://elysiajs.com/essential/best-practice) に従い、
ルートは Elysia インスタンスとして連結し、ハンドラーの型推論を維持する。
サービスに Context を渡さず、必要な入力・認証済みユーザー・署名関数だけを渡す。
サービスは Elysia を import せず、DB リポジトリ契約・ストレージ・時計・暗号処理を注入できる。
HTTP 入力スキーマと認証はルート／ミドルウェア、業務処理と整合性はサービスで管理する。
`AuthService` の署名関数はリクエストの JWT プラグインから渡すため、暗黙の Context キャストを必要としない。

## 実測値の扱い

実測値は実行時のログの `Full test suite` とサービス別カバレッジ一覧を参照する。
CI は閾値を毎回検証するため、ドキュメント上のチェックリストだけを成功の証拠にしない。

`createAuthRouter()` は単独利用では従来の認証用レート制限を有効にする。
メインアプリ用の `authRouter` は `externalRateLimit: true` で作成されるため、
アプリ側の階層型リミッターと組み合わせる。両方式を重ねて設定値を無効化しない。

通常の `DATABASE_URL` / `REDIS_URL` / JWT・ペッパー秘密値はテストへ引き継ぎません。
Redis を使うテストは使い捨てサーバーを `REDIS_TEST_URL` で明示します。
既存の本番 Redis や本番認証設定をテスト用途に指定しないでください。
