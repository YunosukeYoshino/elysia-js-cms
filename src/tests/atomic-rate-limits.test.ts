import { describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import Redis from 'ioredis';
import {
  MemoryRateLimitStore,
  type RateLimitResult,
  type RateLimitStore,
  RedisRateLimitStore,
} from '../lib/rate-limit-store';
import { createRateLimit } from '../middlewares/rate-limit';

interface StoreFixture {
  stores: [RateLimitStore, RateLimitStore];
  destroy(): Promise<void>;
}

const client: string = '192.0.2.101';
const otherClient: string = '192.0.2.102';

function createMemoryFixture(): StoreFixture {
  const store: MemoryRateLimitStore = new MemoryRateLimitStore();
  return { stores: [store, store], destroy: () => store.destroy() };
}

function createRedisFixture(): StoreFixture {
  const prefix: string = `rate-limit-test:${crypto.randomUUID()}:`;
  const first: RedisRateLimitStore = new RedisRateLimitStore(process.env.REDIS_TEST_URL, prefix);
  const second: RedisRateLimitStore = new RedisRateLimitStore(process.env.REDIS_TEST_URL, prefix);
  return {
    stores: [first, second],
    async destroy(): Promise<void> {
      try {
        await Promise.all([first.delete(client), first.delete(otherClient)]);
      } finally {
        await Promise.all([first.destroy(), second.destroy()]);
      }
    },
  };
}

function testConcurrentAdmission(createFixture: () => StoreFixture): void {
  for (const warmup of [0, 2]) {
    it(`allows only the remaining quota with ${warmup} prior requests`, async () => {
      const fixture: StoreFixture = createFixture();
      let calls: number = 0;
      const apps = fixture.stores.map((store: RateLimitStore) =>
        new Elysia().use(
          new Elysia()
            .use(createRateLimit({ max: 3, windowMs: 60000 }, store))
            .get('/limited', () => {
              calls++;
              return 'ok';
            }),
        ),
      );
      const send = (index: number, ip: string = client): Promise<Response> =>
        apps[index % apps.length].handle(
          new Request('http://localhost/limited', { headers: { 'X-Forwarded-For': ip } }),
        );

      try {
        for (let index: number = 0; index < warmup; index++) {
          expect((await send(index)).status).toBe(200);
        }

        const responses: Response[] = await Promise.all(
          Array.from({ length: 20 }, (_, index: number) => send(index)),
        );
        const allowed: Response[] = responses.filter(
          (response: Response) => response.status === 200,
        );
        const denied: Response[] = responses.filter(
          (response: Response) => response.status === 429,
        );

        expect(allowed).toHaveLength(3 - warmup);
        expect(denied).toHaveLength(17 + warmup);
        expect(calls).toBe(3);
        expect(
          allowed
            .map((response: Response) => Number(response.headers.get('X-RateLimit-Remaining')))
            .sort(),
        ).toEqual(Array.from({ length: 3 - warmup }, (_, index: number) => index));

        const resetHeaders: Set<string | null> = new Set();
        for (const response of responses) {
          expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
          expect(response.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
          resetHeaders.add(response.headers.get('X-RateLimit-Reset'));
        }
        expect(resetHeaders.size).toBe(1);
        for (const response of denied) {
          expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
        }

        const isolated: Response = await send(0, otherClient);
        expect(isolated.status).toBe(200);
        expect(isolated.headers.get('X-RateLimit-Remaining')).toBe('2');
        expect((await send(1)).status).toBe(429);
        expect(calls).toBe(4);
      } finally {
        await fixture.destroy();
      }
    });
  }

  it('admits exactly one new quota after the middleware resets a client', async () => {
    const fixture: StoreFixture = createFixture();
    const app = new Elysia().use(
      new Elysia()
        .use(createRateLimit({ max: 3, windowMs: 60000 }, fixture.stores[0]))
        .get('/limited', () => 'ok')
        .post('/reset', async ({ rateLimit }) => {
          await rateLimit.reset();
          return 'reset';
        }),
    );
    const send = (path: string = '/limited', method: string = 'GET'): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { 'X-Forwarded-For': client },
        }),
      );

    try {
      expect((await send()).status).toBe(200);
      expect((await send('/reset', 'POST')).status).toBe(200);
      const responses: Response[] = await Promise.all(Array.from({ length: 20 }, () => send()));
      expect(responses.filter((response: Response) => response.status === 200)).toHaveLength(3);
      expect(responses.filter((response: Response) => response.status === 429)).toHaveLength(17);
    } finally {
      await fixture.destroy();
    }
  });
}

describe('atomic memory rate limits', () => {
  testConcurrentAdmission(createMemoryFixture);

  it('starts only one new window at the exact expiry boundary', async () => {
    const store: MemoryRateLimitStore = new MemoryRateLimitStore();
    let now: number = 2000000000000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first: RateLimitResult = await store.consume(client, 3, 1000);
      now += 999;
      const beforeExpiry: RateLimitResult = await store.consume(client, 3, 1000);
      expect(beforeExpiry.resetTime).toBe(first.resetTime);

      now++;
      const results: RateLimitResult[] = await Promise.all(
        Array.from({ length: 20 }, () => store.consume(client, 3, 1000)),
      );
      expect(results.filter((result: RateLimitResult) => result.allowed)).toHaveLength(3);
      expect(results.every((result: RateLimitResult) => result.resetTime === now + 1000)).toBe(
        true,
      );
      expect(await store.get(client)).toEqual({ count: 3, resetTime: now + 1000 });

      const denied: RateLimitResult = await store.consume(client, 3, 1000);
      expect(denied).toEqual({ allowed: false, remaining: 0, resetTime: now + 1000 });
    } finally {
      clock.mockRestore();
      await store.destroy();
    }
  });

  it('does not bypass the limit if atomic consumption fails', async () => {
    const store: MemoryRateLimitStore = new MemoryRateLimitStore();
    const consume = spyOn(store, 'consume').mockRejectedValue(new Error('Store unavailable'));
    const get = spyOn(store, 'get');
    const set = spyOn(store, 'set');
    const increment = spyOn(store, 'increment');
    let calls: number = 0;
    const app = new Elysia()
      .use(createRateLimit({ max: 3, windowMs: 60000 }, store))
      .get('/limited', () => {
        calls++;
        return 'ok';
      });
    try {
      const response: Response = await app.handle(new Request('http://localhost/limited'));
      expect(response.status).toBe(500);
      expect(calls).toBe(0);
      expect(consume).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(increment).not.toHaveBeenCalled();
    } finally {
      consume.mockRestore();
      get.mockRestore();
      set.mockRestore();
      increment.mockRestore();
      await store.destroy();
    }
  });
});

// REDIS_TEST_URL で指定したテスト用Redisに対して、実際のLua実行を検証する。
describe.skipIf(!process.env.REDIS_TEST_URL)('atomic Redis rate limits', () => {
  testConcurrentAdmission(createRedisFixture);

  it('preserves millisecond expiry without extending a full window', async () => {
    const prefix: string = `rate-limit-test:${crypto.randomUUID()}:`;
    const store: RedisRateLimitStore = new RedisRateLimitStore(process.env.REDIS_TEST_URL, prefix);
    const observer: Redis = new Redis(process.env.REDIS_TEST_URL ?? 'redis://localhost:6379');
    try {
      // 旧実装の秒単位TTLが残っていても、論理上の期限切れを正しく処理する。
      await observer.hset(prefix + client, 'count', 3, 'resetTime', 1);
      await observer.pexpire(prefix + client, 60000);
      const first: RateLimitResult = await store.consume(client, 1, 250);
      expect(first.allowed).toBe(true);
      const initialTtl: number = await observer.pttl(prefix + client);
      expect(initialTtl).toBeGreaterThan(0);
      expect(initialTtl).toBeLessThanOrEqual(250);
      await Bun.sleep(50);

      const denied: RateLimitResult = await store.consume(client, 1, 250);
      expect(denied).toEqual({ allowed: false, remaining: 0, resetTime: first.resetTime });
      expect(await observer.hget(prefix + client, 'count')).toBe('1');
      const remainingTtl: number = await observer.pttl(prefix + client);
      expect(remainingTtl).toBeLessThan(initialTtl);

      await Bun.sleep(Math.max(0, remainingTtl) + 30);
      expect(await observer.exists(prefix + client)).toBe(0);
      const results: RateLimitResult[] = await Promise.all(
        Array.from({ length: 20 }, () => store.consume(client, 3, 1000)),
      );
      expect(results.filter((result: RateLimitResult) => result.allowed)).toHaveLength(3);
      expect(new Set(results.map((result: RateLimitResult) => result.resetTime)).size).toBe(1);
      expect(results[0].resetTime).toBeGreaterThan(first.resetTime);
    } finally {
      try {
        await store.delete(client);
      } finally {
        await Promise.all([store.destroy(), observer.quit()]);
      }
    }
  });
});
