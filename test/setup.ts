// テスト環境用のファイル
// Bunはテスト前に自動的にこのファイルを読み込みます
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll } from 'bun:test';

// テスト用環境変数を設定
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:./test.db';
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.PORT = '3001';

const prisma = new PrismaClient();

// すべてのテスト実行前に実行
beforeAll(async () => {
  try {
    // テスト用DBを初期化
    await prisma.$connect();
    
    // 既存データをクリーンアップ
    await prisma.$transaction([
      prisma.categoryOnPost.deleteMany(),
      prisma.file.deleteMany(),
      prisma.post.deleteMany(),
      prisma.category.deleteMany(),
      prisma.user.deleteMany(),
    ]);
    
    // テスト用の基本データを追加
    await prisma.user.create({
      data: {
        id: 1,
        email: 'test@example.com',
        password: 'hashed_password_example', // 実際には適切なハッシュ化が必要
        name: 'Test User',
        role: 'admin',
      },
    });
    
    await prisma.user.create({
      data: {
        id: 2,
        email: 'regular@example.com',
        password: 'hashed_password_example',
        name: 'Regular User',
        role: 'user',
      },
    });
    
    await prisma.category.create({
      data: {
        id: 1,
        name: 'Test Category',
        slug: 'test-category',
      },
    });
    
    console.log('Test database initialized successfully');
  } catch (error) {
    console.error('Error setting up test database:', error);
    throw error;
  }
});

// すべてのテスト実行後に実行
afterAll(async () => {
  await prisma.$disconnect();
});
