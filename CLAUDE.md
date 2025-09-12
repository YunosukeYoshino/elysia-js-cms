# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

ElysiaJS を使用した軽量な CMS API です。JWT 認証、ユーザー管理、投稿、カテゴリ、ファイルアップロード機能を提供し、Swagger UI によるAPI ドキュメントを備えています。Bun ランタイム、Prisma ORM、SQLite データベースを使用しています。

## 基本コマンド

### 開発環境
```bash
bun install                    # 依存関係のインストール
bun run dev                    # 開発サーバーの起動（自動リロード、ポート3001）
bun run start                  # 本番サーバーの起動
bun run build                  # プロジェクトをdist/にビルド
```

### データベース
```bash
bun prisma db push             # スキーマ変更をデータベースに反映
bun run seed                   # テストデータの投入
bun run prepare-db:test        # テストデータベースのリセット（テスト用）
```

### テスト・品質管理
```bash
bun test                       # 全テストの実行
bun test:coverage              # カバレッジレポート付きでテスト実行
bun test:watch                 # 監視モードでテスト実行
bun run check                  # Biome リンターとフォーマッターのチェック
bun run lint:fix               # Biome による自動修正
```

### 開発ワークフロー
```bash
bun run pre-commit            # lint-staged とテストの実行（husky で使用）
```

## アーキテクチャ

### ドメイン駆動設計の構造
- `src/domain/entities/` - ビジネスエンティティ（User, Post, Category）
- `src/routes/` - ドメイン別に分類されたAPI ルートハンドラ
- `src/middlewares/` - 共有ミドルウェア（認証など）
- `src/lib/` - データベース接続とユーティリティ
- `src/scripts/` - データベースシード・メンテナンススクリプト

### API 構造
すべての API エンドポイントは `/api` プレフィックスが付き、ドメイン別にグループ化されています：
- `/api/auth` - 認証（ログイン、登録、プロフィール）
- `/api/posts` - 投稿管理とカテゴリとの関連付け
- `/api/categories` - カテゴリのCRUD操作
- `/api/files` - ファイルアップロードとサムネイル生成を含む管理

### データベーススキーマ
- **User**: email, password, name, role（admin/user）
- **Post**: title, content, published（公開状態）, author（作成者）との関連
- **Category**: name, slug, CategoryOnPost を介した投稿との多対多関係
- **File**: fileName（UUID）, originalName, mimeType, filePath, thumbnailPath, fileSize, user との関連

### 主要な依存関係
- **ElysiaJS**: OpenAPI/Swagger サポート内蔵の Web フレームワーク
- **Prisma**: SQLite データベースとの ORM
- **@elysiajs/jwt**: JWT 認証ミドルウェア
- **sharp**: サムネイル生成用の画像処理
- **Biome**: リントとフォーマット（ESLint/Prettier の代替）

## 開発ノート

### 環境設定
`.env.example` を `.env` にコピーして設定：

#### 基本設定
- `DATABASE_URL`: SQLite データベースのパス
- `JWT_SECRET`: JWT トークンの秘密鍵（本番環境では強力なランダム秘密鍵を使用）
- `PORT`: サーバーポート（デフォルト3001）

#### 本番環境セキュリティ設定
```bash
# 強力なJWT秘密鍵（256bit推奨）
JWT_SECRET=<strong-random-secret-minimum-32-characters>

# 分散レートリミッター用Redis（オプション）
REDIS_URL=redis://localhost:6379

# バックアップ暗号化キー（パスワード移行時）
BACKUP_ENCRYPTION_KEY=<32-byte-hex-encryption-key>

# ログレベル設定（本番環境）
LOG_LEVEL=info
```

#### セキュリティ注意事項
- **JWT_SECRET**: 本番環境では最低32文字の強力なランダム文字列を使用
- **REDIS_URL**: 本番環境でのスケーラブルなレート制限に推奨
- **BACKUP_ENCRYPTION_KEY**: パスワード移行時のバックアップ暗号化用

### API ドキュメント
サーバー実行中は `http://localhost:3001/swagger` で Swagger UI にアクセス可能

### テスト環境
テストは `NODE_ENV=test` と `.env.test` ファイルで設定された別のテストデータベースを使用

### ファイルアップロード
ファイルは UUID 名でファイルシステムに保存され、メタデータはデータベースで管理されます。画像は Sharp を使用して自動的にサムネイルを生成します。