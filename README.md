# ElysiaJS CMS Demo

軽量な CMS API の ElysiaJS 実装デモです。Bun ランタイムと Prisma ORM を使用しています。

## 機能

- コンテンツの作成、読み取り、更新、削除（CRUD）
- ユーザー認証（JWT）
- コンテンツタイプの管理
- API ドキュメント（Swagger UI）
- データベース（SQLite）

## 始め方

### 前提条件

- [Bun](https://bun.sh/) がインストールされていること

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/YunosukeYoshino/elysiajs-demo.git
cd elysiajs-demo

# 依存関係をインストール
bun install

# データベースをセットアップ
bun prisma generate
bun prisma migrate dev --name init

# シードデータを挿入 (オプション)
bun seed
```

### 開発サーバーの起動

```bash
bun dev
```

サーバーは http://localhost:3000 で実行されます。

Swagger UI は http://localhost:3000/swagger で確認できます。

## API エンドポイント

- `GET /api/posts` - すべての投稿を取得
- `GET /api/posts/:id` - IDで投稿を取得
- `POST /api/posts` - 新しい投稿を作成
- `PUT /api/posts/:id` - 投稿を更新
- `DELETE /api/posts/:id` - 投稿を削除
- `POST /api/auth/login` - ログイン（JWT トークンを取得）
- `POST /api/auth/register` - 新規ユーザー登録

## 技術スタック

- [ElysiaJS](https://elysiajs.com/) - 高速かつ型安全な Web フレームワーク
- [Bun](https://bun.sh/) - JavaScript/TypeScript ランタイム
- [Prisma](https://www.prisma.io/) - 次世代 ORM
- [JWT](https://jwt.io/) - JSON Web Token 認証
- [SQLite](https://www.sqlite.org/) - 軽量データベース

## ライセンス

MIT