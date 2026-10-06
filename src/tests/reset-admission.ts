import { beforeEach } from 'bun:test';
import { hierarchicalRateLimiter } from '../lib/rate-limit-policy';

// setup.ts が本番設定を除去した後、テストランナー内だけで各時間窓を分離する。
beforeEach(async (): Promise<void> => {
  await hierarchicalRateLimiter.destroy();
});
