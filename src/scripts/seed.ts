import type { Prisma, User } from '@prisma/client';
import { assertDemoSeedEnvironment } from '../lib/demo-seed';
import { hashPassword } from '../lib/password';
import prisma from '../lib/prisma';

// 初期データをデータベースに追加するシードスクリプト
async function main(): Promise<void> {
  assertDemoSeedEnvironment(process.env);
  const rootHash = (await hashPassword('DemoRoot-Only42!')).hash;
  const userHash = (await hashPassword('DemoUser-Only42!')).hash;
  console.log('🌱 データベースのシード処理を開始します...');
  await prisma.$transaction(async (client: Prisma.TransactionClient): Promise<void> => {
    await seedDemoContent(client, rootHash, userHash);
  });
  console.log('🎉 シード処理が完了しました!');
}

/** キーのない既存ユーザーをデモアカウントとして流用しない。 */
async function createDemoUser(
  client: Prisma.TransactionClient,
  data: { demoSeedKey: string; email: string; password: string; name: string; role: string },
): Promise<User> {
  const owned: User | null = await client.user.findUnique({
    where: { demoSeedKey: data.demoSeedKey },
  });
  if (owned) return owned;
  const collision: User | null = await client.user.findUnique({ where: { email: data.email } });
  if (collision) {
    throw new Error(`Demo seed refuses to adopt an unmarked existing user: ${data.email}`);
  }
  return client.user.create({ data });
}

/** 全データを単一トランザクションで追加し、衝突時には変更を取り消す。 */
async function seedDemoContent(
  client: Prisma.TransactionClient,
  rootHash: string,
  userHash: string,
): Promise<void> {
  // 初期カテゴリの作成
  console.log('📁 カテゴリを作成中...');
  const categories = await Promise.all([
    client.category.upsert({
      where: { slug: 'technology' },
      update: {},
      create: {
        name: 'テクノロジー',
        slug: 'technology',
      },
    }),
    client.category.upsert({
      where: { slug: 'design' },
      update: {},
      create: {
        name: 'デザイン',
        slug: 'design',
      },
    }),
    client.category.upsert({
      where: { slug: 'programming' },
      update: {},
      create: {
        name: 'プログラミング',
        slug: 'programming',
      },
    }),
    client.category.upsert({
      where: { slug: 'web' },
      update: {},
      create: {
        name: 'Web開発',
        slug: 'web',
      },
    }),
    client.category.upsert({
      where: { slug: 'mobile' },
      update: {},
      create: {
        name: 'モバイル開発',
        slug: 'mobile',
      },
    }),
  ]);

  const getCategoryId = (slug: string): number => {
    const category = categories.find((entry) => entry.slug === slug);
    if (!category) throw new Error(`Missing seed category: ${slug}`);
    return category.id;
  };
  const linkCategories = async (data: { postId: number; categoryId: number }[]): Promise<void> => {
    for (const row of data) {
      await client.categoryOnPost.upsert({
        where: { postId_categoryId: row },
        update: {},
        create: row,
      });
    }
  };

  console.log(`✅ ${categories.length}件のカテゴリを作成しました`);

  // 初期ユーザーの作成
  console.log('👤 ユーザーを作成中...');
  const admin: User = await createDemoUser(client, {
    demoSeedKey: 'cms-demo:v1:admin',
    email: 'admin@example.com',
    password: rootHash,
    name: '管理者',
    role: 'admin',
  });

  const user: User = await createDemoUser(client, {
    demoSeedKey: 'cms-demo:v1:user',
    email: 'user@example.com',
    password: userHash,
    name: '一般ユーザー',
    role: 'user',
  });

  console.log(`✅ ユーザーを作成しました: 管理者(${admin.email})と一般ユーザー(${user.email})`);

  // 初期投稿の作成
  console.log('📝 投稿を作成中...');
  const post1 = await client.post.upsert({
    where: { demoSeedKey: 'cms-demo:v1:elysia-api' },
    update: {},
    create: {
      demoSeedKey: 'cms-demo:v1:elysia-api',
      title: 'ElysiaJSによるAPIの構築',
      content: `
# ElysiaJSとは

ElysiaJSは、Bunランタイム向けに最適化された高速なWebフレームワークです。TypeScriptでの開発を前提としており、型安全なAPIを簡単に構築できます。

## 特徴

- 高速なパフォーマンス
- TypeScriptによる型安全性
- シンプルで直感的なAPI
- ミドルウェアのサポート
- プラグインによる拡張性

## サンプルコード

\`\`\`typescript
import { Elysia } from 'elysia';

const app = new Elysia()
  .get('/', () => 'Hello, World!')
  .listen(3000);

console.log(\`Server is running at \${app.server?.hostname}:\${app.server?.port}\`);
\`\`\`

このシンプルな例からでも、ElysiaJSの簡潔さがわかります。
      `,
      published: true,
      authorId: admin.id,
    },
  });

  // カテゴリを投稿に関連付け
  await linkCategories([
    {
      postId: post1.id,
      categoryId: getCategoryId('technology'),
    },
    {
      postId: post1.id,
      categoryId: getCategoryId('programming'),
    },
    {
      postId: post1.id,
      categoryId: getCategoryId('web'),
    },
  ]);

  const post2 = await client.post.upsert({
    where: { demoSeedKey: 'cms-demo:v1:prisma-orm' },
    update: {},
    create: {
      demoSeedKey: 'cms-demo:v1:prisma-orm',
      title: 'Prisma ORMでデータベース操作を簡単に',
      content: `
# Prisma ORMとは

Prisma は次世代の Node.js および TypeScript 向け ORM (Object-Relational Mapping) です。データベース操作を簡単かつ型安全に行うことができます。

## Prismaの特徴

- 型安全なデータベース操作
- マイグレーション管理
- スキーマ定義
- クエリビルダー
- リレーション管理

## 導入方法

\`\`\`bash
# Prismaのインストール
npm install prisma --save-dev
npm install @prisma/client

# Prismaの初期化
npx prisma init
\`\`\`

## スキーマ例

\`\`\`prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id])
  authorId  Int
}
\`\`\`

Prismaを使うことで、データベース操作がTypeScriptの型システムと統合され、開発効率と信頼性が向上します。
      `,
      published: true,
      authorId: admin.id,
    },
  });

  // カテゴリを投稿に関連付け
  await linkCategories([
    {
      postId: post2.id,
      categoryId: getCategoryId('programming'),
    },
    {
      postId: post2.id,
      categoryId: getCategoryId('web'),
    },
  ]);

  const post3 = await client.post.upsert({
    where: { demoSeedKey: 'cms-demo:v1:mobile-trends' },
    update: {},
    create: {
      demoSeedKey: 'cms-demo:v1:mobile-trends',
      title: 'モバイルアプリ開発の最新トレンド',
      content: `
# モバイルアプリ開発の最新トレンド

モバイルアプリ開発は常に進化し続けています。以下に、2025年の最新トレンドをまとめました。

## クロスプラットフォーム開発

React NativeやFlutterなどのフレームワークを使ったクロスプラットフォーム開発がますます一般的になっています。

## AI/ML統合

多くのアプリが人工知能や機械学習機能を統合し、ユーザーエクスペリエンスを向上させています。

## サーバーレスバックエンド

サーバーレスアーキテクチャを活用したバックエンドにより、スケーラビリティが向上し、運用コストが削減されています。

## プライバシーとセキュリティ

ユーザーデータの保護が最優先事項となり、セキュリティ機能が強化されています。
      `,
      published: true,
      authorId: user.id,
    },
  });

  // カテゴリを投稿に関連付け
  await linkCategories([
    {
      postId: post3.id,
      categoryId: getCategoryId('technology'),
    },
    {
      postId: post3.id,
      categoryId: getCategoryId('mobile'),
    },
  ]);

  const post4 = await client.post.upsert({
    where: { demoSeedKey: 'cms-demo:v1:ui-design' },
    update: {},
    create: {
      demoSeedKey: 'cms-demo:v1:ui-design',
      title: 'UIデザインのベストプラクティス',
      content: `
# UIデザインのベストプラクティス

効果的なユーザーインターフェースデザインは、ユーザーエクスペリエンスの鍵です。以下に、現代のUIデザインのベストプラクティスをご紹介します。

## シンプルさを重視する

ユーザーが迷わないよう、シンプルで直感的なデザインを心がけましょう。不要な要素は排除し、必要な情報のみを表示することが重要です。

## 一貫性のあるデザイン

アプリケーション全体で一貫したデザイン言語を使用することで、ユーザーの学習コストを下げることができます。

## アクセシビリティへの配慮

様々なユーザーが利用できるよう、アクセシビリティ標準に準拠したデザインを心がけましょう。

## 適切なフィードバック

ユーザーのアクションに対して適切なフィードバックを提供することで、操作感を向上させることができます。
      `,
      published: false,
      authorId: user.id,
    },
  });

  // カテゴリを投稿に関連付け
  await linkCategories([
    {
      postId: post4.id,
      categoryId: getCategoryId('design'),
    },
  ]);

  console.log(`✅ ${4}件の投稿を作成しました`);
}

// シードスクリプトを実行
main()
  .catch((e) => {
    console.error('❌ シード処理中にエラーが発生しました:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // データベース接続を閉じる
    await prisma.$disconnect();
  });
