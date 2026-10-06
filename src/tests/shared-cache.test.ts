import { describe, expect, it } from 'bun:test';
import Redis from 'ioredis';
import {
  AUTH_CACHE_TTL_MS,
  MemoryCacheStore,
  RedisCacheStore,
  SharedCache,
} from '../lib/shared-cache';

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

it('uses the unified five minute auth TTL and bounded memory entries', async () => {
  let now: number = 0;
  const store: MemoryCacheStore = new MemoryCacheStore(2, () => now);
  const cache: SharedCache = new SharedCache(store);
  let loads: number = 0;
  const get = (key: string): Promise<number> =>
    cache.getOrLoad('auth', key, AUTH_CACHE_TTL_MS, isNumber, async () => ++loads);
  expect(await get('a')).toBe(1);
  expect(await get('a')).toBe(1);
  expect(cache.stats().hits).toBe(1);
  expect(await get('b')).toBe(2);
  expect(await get('c')).toBe(3);
  expect(await get('a')).toBe(4);
  now = AUTH_CACHE_TTL_MS;
  expect(await get('a')).toBe(5);
  await cache.destroy();
});

it('invalidates existing values and prevents a stale in-flight fill becoming current', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  let release: (value: number) => void = () => {};
  const pending: Promise<number> = new Promise((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const ready: Promise<void> = new Promise((resolve) => {
    started = resolve;
  });
  const first: Promise<number> = cache.getOrLoad('posts', 'public', 1000, isNumber, async () => {
    started();
    return pending;
  });
  await ready;
  await cache.invalidate('posts');
  release(1);
  expect(await first).toBe(1);
  expect(await cache.getOrLoad('posts', 'public', 1000, isNumber, async () => 2)).toBe(2);
  expect(await cache.getOrLoad('posts', 'public', 1000, isNumber, async () => 3)).toBe(2);
  await cache.destroy();
});

it('coalesces concurrent fills and never shares distinct keys', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  let loads: number = 0;
  const results: number[] = await Promise.all(
    Array.from({ length: 30 }, () =>
      cache.getOrLoad('posts', 'one', 1000, isNumber, async () => {
        loads++;
        await Bun.sleep(5);
        return 7;
      }),
    ),
  );
  expect(loads).toBe(1);
  expect(results.every((value: number): boolean => value === 7)).toBe(true);
  expect(await cache.getOrLoad('posts', 'two', 1000, isNumber, async () => 8)).toBe(8);
  await cache.destroy();
});

it('treats malformed cached JSON as a miss and bypasses outages', async () => {
  const store: MemoryCacheStore = new MemoryCacheStore();
  const cache: SharedCache = new SharedCache(store);
  await store.put('auth:0:1', '{invalid', 1000);
  expect(await cache.getOrLoad('auth', '1', 1000, isNumber, async () => 9)).toBe(9);
  expect(cache.stats().errors).toBe(1);
  await cache.destroy();
  const unavailable: SharedCache = new SharedCache(
    new RedisCacheStore('redis://127.0.0.1:1'),
    'redis',
  );
  const start: number = performance.now();
  expect(await unavailable.getOrLoad('auth', '1', 1000, isNumber, async () => 11)).toBe(11);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(unavailable.stats().bypasses).toBe(1);
  await unavailable.destroy();
});

describe.skipIf(!process.env.REDIS_TEST_URL)('shared Redis cache', () => {
  it('shares values and invalidation across two clients with millisecond TTL', async () => {
    const url: string = process.env.REDIS_TEST_URL ?? '';
    const prefix: string = `cache-test:${crypto.randomUUID()}:`;
    const first: SharedCache = new SharedCache(new RedisCacheStore(url, prefix), 'redis');
    const second: SharedCache = new SharedCache(new RedisCacheStore(url, prefix), 'redis');
    const observer: Redis = new Redis(url);
    try {
      expect(await first.getOrLoad('auth', 'one', 300, isNumber, async () => 1)).toBe(1);
      expect(await second.getOrLoad('auth', 'one', 300, isNumber, async () => 2)).toBe(1);
      const ttl: number = await observer.pttl(prefix + 'auth:0:one');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      await second.invalidate('auth');
      expect(await first.getOrLoad('auth', 'one', 100, isNumber, async () => 3)).toBe(3);
      await Bun.sleep(110);
      expect(await second.getOrLoad('auth', 'one', 100, isNumber, async () => 4)).toBe(4);
    } finally {
      const keys: string[] = await observer.keys(prefix + '*');
      if (keys.length) await observer.del(...keys);
      await Promise.all([first.destroy(), second.destroy(), observer.quit()]);
    }
  });
});
