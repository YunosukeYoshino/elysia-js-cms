import { PrismaClient } from '@prisma/client';

// PrismaClient インスタンスをエクスポート
// 接続プールの設定を追加
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // 接続プールの設定
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
  // 接続タイムアウトの設定
  transactionOptions: {
    timeout: 10000, // 10秒
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
