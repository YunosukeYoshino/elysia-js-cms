import { PrismaClient } from '@prisma/client';

// PrismaClient インスタンスをエクスポート
// 接続プールの設定を追加
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // ログ設定
  log:
    process.env.NODE_ENV === 'development'
      ? ['query', 'info', 'warn', 'error']
      : process.env.NODE_ENV === 'test'
        ? ['error']
        : ['error'],
  // 接続プールの設定
  transactionOptions: {
    timeout: 10000, // 10秒
    maxWait: 5000, // 5秒
    isolationLevel: 'Serializable',
  },
});

// アプリケーション終了時のクリーンアップ
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export default prisma;
