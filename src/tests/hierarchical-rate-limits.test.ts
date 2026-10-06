import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import Redis from 'ioredis';
import {
  type HierarchicalResult,
  MemoryHierarchicalStore,
  RedisHierarchicalStore,
  type WindowRule,
} from '../lib/hierarchical-rate-limit-store';
import {
  DEFAULT_RATE_LIMIT_POLICY,
  HierarchicalRateLimiter,
  type LimitIdentity,
  readRateLimitPolicy,
  trustedClientIP,
} from '../lib/rate-limit-policy';
import { createHierarchicalRateLimit } from '../middlewares/hierarchical-rate-limit';

const identity: LimitIdentity = { ip: '192.0.2.1', user: null, endpoint: 'api' };
function rule(key: string, max: number, windowMs: number): WindowRule {
  return { key, name: key, max, windowMs };
}

it('enforces an exact sliding window rather than resetting all requests at the boundary', async () => {
  let now: number = 0;
  const store: MemoryHierarchicalStore = new MemoryHierarchicalStore(() => now);
  const rules: WindowRule[] = [rule('global', 2, 1000)];
  expect((await store.consume(rules, 'ip')).allowed).toBe(true);
  now = 900;
  expect((await store.consume(rules, 'ip')).allowed).toBe(true);
  now = 1000;
  expect((await store.consume(rules, 'ip')).allowed).toBe(true);
  expect(await store.consume(rules, 'ip')).toEqual({
    allowed: false,
    rule: 'global',
    limit: 2,
    remaining: 0,
    resetTime: 1900,
  });
  now = 1900;
  expect((await store.consume(rules, 'ip')).allowed).toBe(true);
});

it('atomically consumes every tier and does not charge other tiers on denial', async () => {
  const store: MemoryHierarchicalStore = new MemoryHierarchicalStore();
  const first: WindowRule[] = [rule('global', 4, 60000), rule('ip:a', 2, 60000)];
  const responses: HierarchicalResult[] = await Promise.all(
    Array.from({ length: 40 }, () => store.consume(first, 'a')),
  );
  expect(
    responses.filter((response: HierarchicalResult): boolean => response.allowed),
  ).toHaveLength(2);
  const second: WindowRule[] = [rule('global', 4, 60000), rule('ip:b', 4, 60000)];
  expect((await store.consume(second, 'b')).allowed).toBe(true);
  expect((await store.consume(second, 'b')).allowed).toBe(true);
  expect((await store.consume(second, 'b')).rule).toBe('global');
});

it('bounds memory, frees expired windows, and validates rules', async () => {
  let now: number = 0;
  const store: MemoryHierarchicalStore = new MemoryHierarchicalStore(() => now, 2);
  await store.consume([rule('a', 1, 1000), rule('b', 1, 1000)], 'a');
  expect(store.consume([rule('c', 1, 1000)], 'c')).rejects.toThrow('capacity');
  now = 1000;
  expect((await store.consume([rule('c', 1, 1000)], 'c')).allowed).toBe(true);
  for (const max of [0, -1, NaN, Infinity, 0.5, 100001])
    expect(store.consume([rule('a', max, 1000)], 'a')).rejects.toThrow('Invalid');
});

it('progressively penalizes failures, caps delay and lets penalties expire', async () => {
  let now: number = 0;
  const store: MemoryHierarchicalStore = new MemoryHierarchicalStore(() => now);
  const rules: WindowRule[] = [rule('global', 100, 1000)];
  await store.penalize('auth:ip');
  await store.penalize('auth:ip');
  expect((await store.consume(rules, 'auth:ip')).allowed).toBe(true);
  await store.penalize('auth:ip');
  expect((await store.consume(rules, 'auth:ip')).resetTime).toBe(1000);
  expect((await store.consume(rules, 'another')).allowed).toBe(true);
  now = 1000;
  await store.penalize('auth:ip');
  expect((await store.consume(rules, 'auth:ip')).resetTime).toBe(3000);
  for (let i: number = 0; i < 30; i++) await store.penalize('auth:ip');
  expect((await store.consume(rules, 'auth:ip')).resetTime).toBe(61000);
  now = 16 * 60000;
  expect((await store.consume(rules, 'auth:ip')).allowed).toBe(true);
});

it('relaxes authenticated and administrator limits but never the absolute global cap', async () => {
  const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  policy.ip.max = 1;
  policy.user.max = 1;
  policy.global.max = 8;
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    policy,
    'memory',
    () => {},
  );
  expect((await limiter.check(identity)).allowed).toBe(true);
  expect((await limiter.check(identity)).allowed).toBe(false);
  const user: LimitIdentity = {
    ...identity,
    ip: '192.0.2.2',
    user: { id: 1, email: 'a@example.com', name: null, role: 'user' },
  };
  expect((await limiter.check(user)).allowed).toBe(true);
  expect((await limiter.check(user)).rule).toBe('user');
  const admin: LimitIdentity = {
    ...identity,
    ip: '192.0.2.3',
    user: { id: 2, email: 'b@example.com', name: null, role: 'admin' },
  };
  for (let i: number = 0; i < 6; i++) expect((await limiter.check(admin)).allowed).toBe(true);
  expect((await limiter.check(admin)).rule).toBe('global');
});

it('restricts configured abusive IPs and excessive uploads independently', async () => {
  const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  policy.restrictedIPs[identity.ip] = { max: 1, windowMs: 60000 };
  policy.upload.max = 1;
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    policy,
    'memory',
    () => {},
  );
  expect((await limiter.check(identity)).allowed).toBe(true);
  expect((await limiter.check(identity)).rule).toBe('restricted-ip');
  const upload: LimitIdentity = { ...identity, ip: '192.0.2.2', endpoint: 'upload' };
  expect((await limiter.check(upload)).allowed).toBe(true);
  for (let i: number = 0; i < 3; i++) expect((await limiter.check(upload)).allowed).toBe(false);
  expect((await limiter.check(upload)).rule).toBe('penalty');
  expect((await limiter.check({ ...upload, endpoint: 'api' })).allowed).toBe(true);
});

it('only trusts explicitly configured proxies and canonicalizes IPv6 identities', () => {
  const spoofed: Headers = new Headers({
    'x-forwarded-for': '192.0.2.99',
    'x-real-ip': '192.0.2.98',
  });
  expect(trustedClientIP('192.0.2.1', spoofed, [])).toBe('192.0.2.1');
  expect(trustedClientIP(undefined, spoofed, ['127.0.0.1'])).toBe('unknown');
  expect(trustedClientIP('127.0.0.1', spoofed, ['127.0.0.1'])).toBe('192.0.2.99');
  expect(
    trustedClientIP('127.0.0.1', new Headers({ 'x-forwarded-for': 'attacker, 192.0.2.2' }), [
      '127.0.0.1',
    ]),
  ).toBe('127.0.0.1');
  expect(
    trustedClientIP('127.0.0.1', new Headers({ 'x-forwarded-for': '192.0.2.99, 192.0.2.2' }), [
      '127.0.0.1',
    ]),
  ).toBe('192.0.2.2');
  expect(trustedClientIP('::ffff:192.0.2.1', spoofed, [])).toBe('192.0.2.1');
  expect(trustedClientIP('::FFFF:192.0.2.1', spoofed, [])).toBe('192.0.2.1');
  expect(trustedClientIP('0:0:0:0:0:ffff:c000:201', spoofed, [])).toBe('192.0.2.1');
  expect(trustedClientIP('2001:0db8:0000:0000:0000:0000:0000:0001', spoofed, [])).toBe(
    '2001:db8::1',
  );
});

it('fails startup for malformed or unbounded configuration', () => {
  expect(readRateLimitPolicy('{"auth":{"max":3,"windowMs":1000}}').auth.max).toBe(3);
  for (const raw of [
    '[]',
    '{}oops',
    '{"global":{"max":0,"windowMs":1000}}',
    '{"adminMultiplier":1000}',
    '{"trustedProxies":["*"]}',
    '{"typo":1}',
  ])
    expect(() => readRateLimitPolicy(raw)).toThrow();
});

it('composes middleware with headers, early 429, auth-failure penalties and no trust in request headers', async () => {
  const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  policy.ip.max = 2;
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    policy,
    'memory',
    () => {},
  );
  let calls: number = 0;
  const app = new Elysia().use(createHierarchicalRateLimit(limiter)).get('/api/test', () => {
    calls++;
    return 'ok';
  });
  for (let i: number = 0; i < 2; i++)
    expect(
      (
        await app.handle(
          new Request('http://localhost/api/test', {
            headers: { 'x-forwarded-for': `192.0.2.${i}` },
          }),
        )
      ).status,
    ).toBe(200);
  const denied: Response = await app.handle(new Request('http://localhost/api/test'));
  expect(denied.status).toBe(429);
  expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
  expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
  expect(calls).toBe(2);
  const authLimiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    DEFAULT_RATE_LIMIT_POLICY,
    'memory',
    () => {},
  );
  const auth = new Elysia()
    .use(createHierarchicalRateLimit(authLimiter))
    .post('/api/auth/login', ({ set }) => {
      set.status = 401;
      return { error: 'invalid' };
    });
  for (let i: number = 0; i < 3; i++)
    expect(
      (await auth.handle(new Request('http://localhost/api/auth/login', { method: 'POST' })))
        .status,
    ).toBe(401);
  expect(
    (await auth.handle(new Request('http://localhost/api/auth/login', { method: 'POST' }))).status,
  ).toBe(429);
  expect(authLimiter.stats().penalties).toBe(3);
});

it('returns 503 during a real connection outage without invoking the handler', async () => {
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new RedisHierarchicalStore('redis://127.0.0.1:1'),
    DEFAULT_RATE_LIMIT_POLICY,
    'redis',
    () => {},
  );
  let calls: number = 0;
  const app = new Elysia().use(createHierarchicalRateLimit(limiter)).get('/api/test', () => {
    calls++;
    return 'ok';
  });
  try {
    const response: Response = await app.handle(new Request('http://localhost/api/test'));
    expect(response.status).toBe(503);
    expect(calls).toBe(0);
    expect(response.headers.get('Retry-After')).toBe('1');
  } finally {
    await limiter.destroy();
  }
});

describe.skipIf(!process.env.REDIS_TEST_URL)('shared Redis sliding window', () => {
  it('admits exactly one common quota across two concurrent clients and expires windows', async () => {
    const url: string = process.env.REDIS_TEST_URL ?? '';
    const prefix: string = `hierarchical-test:${crypto.randomUUID()}:`;
    const stores: RedisHierarchicalStore[] = [
      new RedisHierarchicalStore(url, prefix),
      new RedisHierarchicalStore(url, prefix),
    ];
    const observer: Redis = new Redis(url);
    const rules: WindowRule[] = [rule('global', 5, 250), rule('ip', 3, 250)];
    try {
      const results: HierarchicalResult[] = await Promise.all(
        Array.from({ length: 30 }, (_, i: number) => stores[i % 2].consume(rules, 'auth:ip')),
      );
      expect(results.filter((result: HierarchicalResult): boolean => result.allowed)).toHaveLength(
        3,
      );
      expect(await observer.zcard(prefix + 'global')).toBe(3);
      const ttl: number = await observer.pttl(prefix + 'ip');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(250);
      await Bun.sleep(270);
      expect((await stores[0].consume(rules, 'auth:ip')).allowed).toBe(true);
      await stores[0].penalize('auth:ip');
      await stores[1].penalize('auth:ip');
      await stores[0].penalize('auth:ip');
      expect((await stores[1].consume(rules, 'auth:ip')).rule).toBe('penalty');
    } finally {
      const keys: string[] = await observer.keys(prefix + '*');
      if (keys.length) await observer.del(...keys);
      await Promise.all([
        ...stores.map((store: RedisHierarchicalStore) => store.destroy()),
        observer.quit(),
      ]);
    }
  });
});

it('counts domain exceptions after error mapping and preserves the error envelope', async () => {
  class DomainFailure extends Error {
    readonly status: number = 401;
  }
  const errors = new Elysia().onError({ as: 'global' }, ({ error, set }) => {
    if (error instanceof DomainFailure) {
      set.status = error.status;
      return { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' };
    }
  });
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    DEFAULT_RATE_LIMIT_POLICY,
    'memory',
    () => {},
  );
  const app = new Elysia()
    .use(errors)
    .use(createHierarchicalRateLimit(limiter))
    .post('/api/auth/login', () => {
      throw new DomainFailure();
    });
  for (let i: number = 0; i < 3; i++) {
    const response: Response = await app.handle(
      new Request('http://localhost/api/auth/login', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Invalid credentials',
      code: 'INVALID_CREDENTIALS',
    });
  }
  expect(limiter.stats().penalties).toBe(3);
  expect(
    (await app.handle(new Request('http://localhost/api/auth/login', { method: 'POST' }))).status,
  ).toBe(429);
});

it('uses the socket peer on a live server even when forwarding headers change', async () => {
  const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  policy.ip.max = 2;
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    policy,
    'memory',
    () => {},
  );
  const app = new Elysia()
    .use(createHierarchicalRateLimit(limiter))
    .get('/api/test', () => 'ok')
    .listen({ port: 0, hostname: '127.0.0.1' });
  try {
    const url: string = `http://127.0.0.1:${app.server?.port}/api/test`;
    for (let i: number = 0; i < 2; i++)
      expect(
        (
          await fetch(url, {
            headers: { 'x-forwarded-for': `192.0.2.${i}`, 'x-user-role': 'admin' },
          })
        ).status,
      ).toBe(200);
    expect((await fetch(url, { headers: { 'x-forwarded-for': '192.0.2.99' } })).status).toBe(429);
  } finally {
    await app.stop();
    await limiter.destroy();
  }
});

it('charges invalid schemas and malformed JSON before parsing and validation', async () => {
  const { t } = await import('elysia');
  const policy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  policy.auth.max = 1;
  for (const body of ['{"email":"bad"}', '{broken']) {
    const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
      new MemoryHierarchicalStore(),
      policy,
      'memory',
      () => {},
    );
    const app = new Elysia()
      .use(createHierarchicalRateLimit(limiter))
      .post('/api/auth/login', () => 'ok', {
        body: t.Object({ email: t.String({ format: 'email' }) }),
      });
    const request = (): Request =>
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    expect([400, 422]).toContain((await app.handle(request())).status);
    expect((await app.handle(request())).status).toBe(429);
    expect(limiter.stats().allowed).toBe(1);
    expect(limiter.stats().denied).toBe(1);
  }
});
