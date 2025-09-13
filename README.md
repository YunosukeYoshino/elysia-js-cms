# ElysiaJS CMS API

<img width="1918" height="1068" alt="image" src="https://github.com/user-attachments/assets/e47bab31-458e-4dbe-add6-90ba0f9c06a3" />

ElysiaJS を使用した軽量な CMS API です。

## 機能

- 認証（JWT）
- ユーザー管理
- 投稿管理
- カテゴリ管理
- ファイルアップロード
- Swagger UI によるAPI ドキュメント

## 使用技術

- [Bun](https://bun.sh/) - JavaScript ランタイム
- [ElysiaJS](https://elysiajs.com/) - Bun 対応の高速な Web フレームワーク
- [Prisma](https://www.prisma.io/) - Node.js と TypeScript の ORM
- [SQLite](https://www.sqlite.org/) - 埋め込み型データベース

## 開発環境セットアップ

### 前提条件

- [Bun](https://bun.sh/) がインストールされていること

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/YunosukeYoshino/elysiajs-demo.git
cd elysiajs-demo

# 依存関係をインストール
bun install

# 開発データベースを準備
bun prisma db push

# テスト用データを投入
bun run seed
```

### 開発サーバーの起動

```bash
bun run dev
```

サーバーは http://localhost:3001 で起動します。
Swagger UI は http://localhost:3001/swagger でアクセスできます。

## テスト

```bash
# テストを実行
bun test

# カバレッジレポート付きでテストを実行
bun test:coverage

# テストを監視モードで実行
bun test:watch
```

## Git フックの設定（オプション）

このプロジェクトは、コミット前に自動的にリンターチェックとテストを実行するように設定できます：

```bash
# huskyとlint-stagedのインストール
bun add -d husky lint-staged

# huskyの初期化
bun run prepare

# pre-commitフックを作成
mkdir -p .husky
touch .husky/pre-commit
chmod +x .husky/pre-commit
```

`.husky/pre-commit` ファイルの内容：

```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

bun run pre-commit
```

これにより、コミット前に自動的にコードのフォーマットチェックとテストが実行されます。

## ビルドと実行

```bash
# プロジェクトをビルド
bun run build

# 本番環境で実行
bun run start
```

## API ドキュメント

Swagger UI: http://localhost:3001/swagger

## ライセンス

MIT
