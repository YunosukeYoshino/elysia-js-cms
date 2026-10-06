# ElysiaJS CMS API

<img width="1918" height="1068" alt="image" src="https://github.com/user-attachments/assets/e47bab31-458e-4dbe-add6-90ba0f9c06a3" />

<div align="center">

[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)](https://bun.sh)
[![ElysiaJS](https://img.shields.io/badge/ElysiaJS-259dff?style=for-the-badge)](https://elysiajs.com)
[![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)](https://www.prisma.io/)
[![SQLite](https://img.shields.io/badge/sqlite-%2307405e.svg?style=for-the-badge&logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**A high-performance, lightweight CMS API built with ElysiaJS and Bun.**

[Features](#features) • [Tech Stack](#tech-stack) • [Getting Started](#getting-started) • [API Documentation](#api-documentation) • [Development](#development)

</div>

---

## Overview

This project is a robust Content Management System (CMS) backend API designed for speed and developer experience. Built on the modern **Bun** runtime and **ElysiaJS** framework, it provides a complete suite of features for managing content, authentication, and media.

Whether you're building a blog, a documentation site, or a portfolio, this API serves as a solid foundation with built-in type safety and comprehensive documentation.

## Features

- **🔐 Secure Authentication**: robust JWT-based authentication with access and refresh token rotation.
- **📝 Content Management**: Full CRUD operations for Posts and Categories.
- **🏷️ Taxonomy**: Flexible many-to-many relationships between posts and categories.
- **📂 File Management**: Integrated file uploads with automatic thumbnail generation and MIME type validation.
- **🛡️ Rate Limiting**: Built-in protection against abuse with configurable rate limits.
- **📑 API Documentation**: Interactive Swagger/OpenAPI documentation available out-of-the-box.
- **⚡ High Performance**: Powered by Bun and ElysiaJS for sub-millisecond response times.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [ElysiaJS](https://elysiajs.com)
- **Database**: [SQLite](https://www.sqlite.org) (via [Prisma](https://www.prisma.io))
- **ORM**: [Prisma](https://www.prisma.io)
- **Language**: [TypeScript](https://www.typescriptlang.org)
- **Linting & Formatting**: [Biome](https://biomejs.dev)

## Getting Started

### Prerequisites

- **Bun**: You need to have Bun installed on your machine.
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

### Installation

1.  **Clone the repository**
    ```bash
    git clone <your-repo-url>
    cd elysia-js-cms
    ```

2.  **Install dependencies**
    ```bash
    bun install
    ```

3.  **Environment Setup**
    Copy the example environment file and configure your secrets.
    ```bash
    cp .env.example .env
    ```
    > **Note**: Ensure you set a secure `JWT_SECRET` in your `.env` file.

### Database Setup

1.  **Initialize the database**
    This command runs migrations and sets up your SQLite database.
    ```bash
    bun run prepare-db:dev
    ```

2.  **Seed data (Optional)**
    Populate the database with initial test data.
    ```bash
    NODE_ENV=development ALLOW_DEMO_SEED=true bun run seed
    ```

### Running the Application

**Development Mode** (with hot reload)
```bash
bun run dev
```

**Production Mode**
```bash
bun run start
```

The server will start at `http://localhost:3001`.

## API Documentation

Interactive API documentation is automatically generated using Swagger UI.

1.  Start the server (`bun run dev`).
2.  Navigate to `http://localhost:3001/swagger`.

Here you can explore all endpoints, test requests, and view data schemas.

### Key Endpoints

| Category | Endpoint | Description |
|----------|----------|-------------|
| **Auth** | `POST /api/auth/register` | Register a new user |
| | `POST /api/auth/login` | Login and receive tokens |
| **Posts** | `GET /api/posts` | List all published posts |
| | `POST /api/posts` | Create a new post (Auth required) |
| **Categories** | `GET /api/categories` | List all categories |
| **Files** | `POST /api/files/upload` | Upload a file (Auth required) |

## Development

### Code Quality

We use **Biome** for ultra-fast linting and formatting.

- **Format code**:
  ```bash
  bun run format
  ```
- **Lint code**:
  ```bash
  bun run lint
  ```
- **Type Check**:
  ```bash
  bun run typecheck
  ```

### Testing

Run the test suite using Bun's built-in test runner.

```bash
# Run all tests
bun test

# Run tests with coverage
bun run test:coverage

# Watch mode
bun run test:watch
```

## Project Structure

```
src/
├── domain/          # Domain entities and business logic
├── lib/             # Shared utilities (Auth, Network, Prisma)
├── middlewares/     # Application middleware (Auth, Rate Limit)
├── routes/          # API Route handlers
├── scripts/         # Database maintenance scripts
├── tests/           # Integration and Unit tests
└── types/           # TypeScript type definitions
```

---

<div align="center">
  <sub>Built with ❤️ using <a href="https://elysiajs.com">ElysiaJS</a> and <a href="https://bun.sh">Bun</a></sub>
</div>
### 本番環境のJWT設定

NODE_ENV=production では JWT_SECRET が必須です。未設定・空白・既定のテスト値なら起動を停止します。開発・テストの既定値は維持されます。

bun run start は本番モードで起動します。開発には bun run dev を使用してください。

### Rate-limit policy

POST /api/auth/register is limited to 3 requests per hour per client key.
POST /api/auth/login is independently limited to 5 requests per 15 minutes.
Successful and failed attempts both count. Refresh, logout, and profile routes
consume neither quota. The general API limiter is opt-in; it is not attached
by default. A limiter plugin applies to its immediate consumer's routes;
use separate groups to isolate policies from sibling routes.

時間窓の更新・上限判定・加算はストアの `consume` で不可分に実行します。メモリ版は
同一プロセス内、Redis版は同じキーを共有する複数プロセス間で上限を保証します。
拒否したリクエストではカウントや期限を延長せず、Redis障害時に非アトミックな処理へ
フォールバックしません。カスタムストアもアトミックな `consume` を実装してください。

並列リクエストの回帰テストは `bun test src/tests/atomic-rate-limits.test.ts` で実行します。
実RedisのLua・TTL・複数接続も検証する場合は、ローカルのテスト用Redisを起動し、
`REDIS_TEST_URL=redis://127.0.0.1:6379 bun test src/tests/atomic-rate-limits.test.ts`
を実行してください。専用のランダムなキープレフィックスを使い、終了時に削除します。
`REDIS_TEST_URL` 未設定時はRedisの統合テストのみスキップします。

### デモシードの安全設定

開発・テスト専用の公開デモです。破棄可能なローカルSQLiteを明示し、32文字以上の固定JWT_SECRET（未設定・空白・サンプル値ならPEPPER_SECRET）を設定してください。公開済みのテスト用秘密値は使用できません。本番では実行できません。
初期ログイン: admin@example.com / DemoRoot-Only42!、user@example.com / DemoUser-Only42!。既存ユーザーのパスワード・権限は変更しません。
既存投稿のID衝突対策は未完了のため、既存コンテンツを含むDBには実行しないでください。

### 開発用パスワードのフォールバック

- 公開フォールバックを許可するのは、NODE_ENV が明示的に development または test の場合だけです。bun run dev は development を設定するため、秘密値がないローカル開発でも再起動後に照合できます。NODE_ENV の未設定・空値・staging・未知の値・production では有効な固定秘密値が必須です。公開済みのサンプル値や開発用フォールバック文字列を秘密値に設定しても、この制限は解除されません。
- 既存ハッシュとの互換性のため、有効な JWT_SECRET を PEPPER_SECRET より優先します。JWT_SECRET が未設定・空白・your-secret-key-for-jwt-tokens の場合は PEPPER_SECRET を使用します。実際の秘密値の前後の空白はハッシュとの互換性のため削除しません。
- 以前 JWT_SECRET=your-secret-key-for-jwt-tokens と PEPPER_SECRET を併用した場合、PEPPER_SECRET は無視され、公開フォールバックでハッシュ化されていました。新規ハッシュには PEPPER_SECRET を使用します。旧ハッシュの追加照合は、このプレースホルダー設定を維持した明示的な development/test のみで行います。staging/production などでは決して照合しません。

移行時は有効な JWT_SECRET と PEPPER_SECRET を無計画に変更しないでください。有効な JWT_SECRET が使われていた既存ハッシュはその値を維持すれば引き続き照合できます。JWT_SECRET を外して専用 PEPPER_SECRET に移す場合は、まず以前の JWT_SECRET と同じ値を PEPPER_SECRET に設定する必要があります。独立した値への変更や秘密値のローテーションには、元のパスワードからの再ハッシュまたは適切なパスワード再設定が必要です。

公開フォールバックで作ったアカウントは本番へ持ち込まず、破棄可能なローカルDBを作り直すか、本人確認を伴う再設定で固定秘密値からハッシュを作り直してください。ハッシュ済みデータは平文移行用の migrate-passwords では変換できません。以前のランダムフォールバックで作られたパスワードも自動復旧しません。本番アプリの JWT_SECRET 必須チェックは別途維持され、PEPPER_SECRET の設定だけでは回避できません。

### ページ指定の検証

takeは符号付き10進整数、skipは0以上の10進整数です。安全整数範囲外・小数・空値・不正な文字列は422で拒否します。省略時の10/0、take=0、負のtakeによる逆順取得は維持します。

### ビルド配布物の検証

`bun run test:artifact` はビルド後、ソースコードのない一時ディレクトリで
`dist/` と実体コピーした `node_modules/` を配置し、`dist/index.js` を起動します。
一時 SQLite DB を使い、HTTP 経由の認証、投稿一覧、
画像アップロード・サムネイル生成・削除を検証します。既存 DB は変更しません。
配布時は Bun、インストール済みの実行依存、生成済み Prisma Client とネイティブ依存
（Sharp、Prisma エンジン）が必要です。`@prisma/client` と `sharp` はバンドルせず、
配布先の `node_modules/` から読み込みます。`dist/` 単体の静的配信には対応していません。
CI は `.bun-version` のランタイムを使用し、型チェックとこの配布物テストも実行します。
