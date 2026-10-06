import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { RedisHierarchicalStore } from '../lib/hierarchical-rate-limit-store';
import { DEFAULT_RATE_LIMIT_POLICY, HierarchicalRateLimiter } from '../lib/rate-limit-policy';
import { RedisCacheStore, SharedCache } from '../lib/shared-cache';

/** 各テストが専用のRedisを起動するため、共有Redisサービスを停止しない。 */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

it.skipIf(!process.env.REDIS_TEST_SERVER)(
  'recovers real Redis connections, flushes failed invalidations, and preserves fail-closed quotas',
  async () => {
    const binary: string = process.env.REDIS_TEST_SERVER ?? '';
    const directory: string = await mkdtemp(join(tmpdir(), 'cms-redis-recovery-'));
    const port: number = await unusedPort();
    const url: string = `redis://127.0.0.1:${port}`;
    let serverProcess: Bun.Subprocess | null = null;
    const start = async (): Promise<void> => {
      serverProcess = Bun.spawn(
        [
          binary,
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--dir',
          directory,
          '--save',
          '',
          '--appendonly',
          'yes',
          '--appendfsync',
          'always',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      const observer: Redis = new Redis(url, {
        retryStrategy: () => 10,
        maxRetriesPerRequest: 100,
      });
      observer.on('error', () => {});
      try {
        expect(await observer.ping()).toBe('PONG');
      } finally {
        observer.disconnect();
      }
    };
    const stop = async (): Promise<void> => {
      if (serverProcess) {
        serverProcess.kill('SIGTERM');
        await serverProcess.exited;
        serverProcess = null;
      }
    };
    const cache: SharedCache = new SharedCache(new RedisCacheStore(url), 'redis');
    const other: SharedCache = new SharedCache(new RedisCacheStore(url), 'redis');
    const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
    policy.ip.max = 1;
    const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
      new RedisHierarchicalStore(url),
      policy,
      'redis',
      () => {},
    );
    const isNumber = (value: unknown): value is number => typeof value === 'number';
    try {
      await start();
      expect(await cache.getOrLoad('content', 'post', 60000, isNumber, async () => 1)).toBe(1);
      expect(await other.getOrLoad('content', 'post', 60000, isNumber, async () => 2)).toBe(1);
      expect((await limiter.check({ ip: '192.0.2.1', user: null, endpoint: 'api' })).allowed).toBe(
        true,
      );
      await stop();
      expect(await cache.getOrLoad('content', 'post', 60000, isNumber, async () => 2)).toBe(2);
      await cache.invalidate('content');
      expect(cache.stats().pendingInvalidations).toBe(1);
      const failed = await limiter.check({ ip: '192.0.2.1', user: null, endpoint: 'api' });
      expect(failed.unavailable).toBe(true);
      expect(failed.allowed).toBe(false);
      await start();
      // ioredisの最大バックオフを待ち、実際に同じインスタンスで回復することを確認。
      const deadline: number = Date.now() + 5000;
      while (cache.stats().pendingInvalidations && Date.now() < deadline) {
        expect(await cache.getOrLoad('content', 'post', 60000, isNumber, async () => 2)).toBe(2);
        if (cache.stats().pendingInvalidations) await Bun.sleep(100);
      }
      expect(cache.stats().pendingInvalidations).toBe(0);
      expect(await other.getOrLoad('content', 'post', 60000, isNumber, async () => 2)).toBe(2);
      let recovered = await limiter.check({ ip: '192.0.2.1', user: null, endpoint: 'api' });
      while (recovered.unavailable && Date.now() < deadline) {
        await Bun.sleep(100);
        recovered = await limiter.check({ ip: '192.0.2.1', user: null, endpoint: 'api' });
      }
      expect(recovered.unavailable).toBe(false);
      expect(recovered.allowed).toBe(false);
      expect(recovered.rule).toBe('ip');
    } finally {
      await Promise.all([cache.destroy(), other.destroy(), limiter.destroy()]);
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
