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

## コーディング規約

### 型安全性の厳格なルール

#### 禁止事項
- **`any` 型の使用は完全禁止**: どのような理由があっても `any` を使用しない
- **`unknown` への無理やりなキャストは禁止**: `as unknown as SomeType` のような二重キャストは使用しない
- **`biome-ignore` コメントは禁止**: lint エラーを無視せず、適切に対処する
- **`@ts-ignore` / `@ts-expect-error` は禁止**: TypeScript エラーを無視しない

#### 推奨される対処法
1. **適切な型定義を作成**: ライブラリの型が不足している場合は、型定義ファイルを作成
2. **型ガードを使用**: 型の絞り込みには型ガード関数を実装
3. **ジェネリクスを活用**: 汎用的な処理にはジェネリクスを使用
4. **Union型や交差型を活用**: 複数の型を扱う場合は適切に型を組み合わせる

#### 例外的な対処が必要な場合
外部ライブラリとの互換性で型の問題が発生する場合：
1. 型定義ファイル（`.d.ts`）を作成して型を拡張
2. ラッパー関数を作成して型安全なインターフェースを提供
3. 別のライブラリへの移行を検討

### AIのための自己修正ガイド

コードを生成・修正する際は、以下のステップに従ってください：

1. **コード生成後、必ず `bun run check` を実行する**
   - Biomeのエラー（フォーマット、リント）を確認する。
   - `biome-ignore` を使うのではなく、コードを修正してエラーを解消する。

2. **型エラーを解消する**
   - `any` に逃げず、正しい型定義を行う。
   - 必要であれば `interface` や `type` を定義する。

3. **`bun test` で動作確認をする**
   - 既存のテストが壊れていないか確認する。
   - 新機能を追加した場合は、対応するテストを追加する。

よくあるエラーと対処：
- **Unused variables**: 変数名の先頭に `_` を付ける（例: `_unused`）。
- **Implicit any**: 関数の引数には必ず型を明記する。

**提出前に必ず `bun run lint:fix` を実行して、フォーマットを整えてください。**
