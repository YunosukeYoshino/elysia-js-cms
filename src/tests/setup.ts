import { rmSync } from 'node:fs';
import prepareDatabase, { configureTestDatabase } from '../scripts/prepare-db';

// 開発者の通常環境にある本番 Redis や署名秘密をテストへ引き継がない。
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.PEPPER_SECRET = '';
process.env.REDIS_URL = '';
process.env.RATE_LIMIT_POLICY = '';

// Prisma を import する前にプロセス専用 DB を選び、開発・本番の URL を無視する。
const configuration = configureTestDatabase();
if (configuration.ownedDirectory) {
  const directory: string = configuration.ownedDirectory;
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
}
await prepareDatabase('test');
