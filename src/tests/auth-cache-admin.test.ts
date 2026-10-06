import { afterAll, beforeAll, expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import { getAuthenticatedUser } from '../lib/auth-cache';
import { MemoryHierarchicalStore } from '../lib/hierarchical-rate-limit-store';
import { getJwtSecret } from '../lib/jwt-config';
import prisma from '../lib/prisma';
import { DEFAULT_RATE_LIMIT_POLICY, HierarchicalRateLimiter } from '../lib/rate-limit-policy';
import { MemoryCacheStore, SharedCache } from '../lib/shared-cache';
import { authMiddleware } from '../middlewares/auth';
import { createRateLimitAdminRouter } from '../routes/rate-limit-admin';

let userId: number = 0;
const email: string = `cache-admin-${crypto.randomUUID()}@example.com`;
const cache: SharedCache = new SharedCache(new MemoryCacheStore());
beforeAll(async () => {
  await import('../scripts/prepare-db').then((module) => module.default('test'));
  userId = (
    await prisma.user.create({
      data: { email, name: 'Before', password: 'never-cached', role: 'admin' },
    })
  ).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await cache.destroy();
});

it('shares repeated auth profiles and invalidates by DB version without caching secrets', async () => {
  expect((await getAuthenticatedUser(userId, cache))?.name).toBe('Before');
  const hit = await getAuthenticatedUser(userId, cache);
  expect(hit).toEqual({ id: userId, email, name: 'Before', role: 'admin' });
  expect(cache.stats().hits).toBe(1);
  await Bun.sleep(2);
  await prisma.user.update({ where: { id: userId }, data: { name: 'After' } });
  expect((await getAuthenticatedUser(userId, cache))?.name).toBe('After');
  expect(cache.stats().hits).toBeGreaterThanOrEqual(1);
});

it('never lets stale cached admin roles override an authoritative demotion or deletion', async () => {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await prisma.user.update({
    where: { id: userId },
    data: { role: 'user', updatedAt: before.updatedAt },
  });
  expect((await getAuthenticatedUser(userId, cache))?.role).toBe('user');
  await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
  const temporary = await prisma.user.create({
    data: { email: `temporary-${email}`, password: 'never-cached', role: 'admin' },
  });
  expect((await getAuthenticatedUser(temporary.id, cache))?.role).toBe('admin');
  await prisma.user.delete({ where: { id: temporary.id } });
  expect(await getAuthenticatedUser(temporary.id, cache)).toBeNull();
});

it('guards status against anonymous and ordinary users and returns no client identifiers', async () => {
  const signer = jwt({ secret: getJwtSecret() }).decorator.jwt;
  const token: string = await signer.sign({
    userId,
    role: 'user',
    type: 'access',
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const limiter: HierarchicalRateLimiter = new HierarchicalRateLimiter(
    new MemoryHierarchicalStore(),
    DEFAULT_RATE_LIMIT_POLICY,
    'memory',
    () => {},
  );
  const app = new Elysia().use(createRateLimitAdminRouter(limiter, cache));
  const request = (authorization?: string): Request =>
    new Request('http://localhost/admin/rate-limits/status', {
      headers: authorization ? { authorization } : {},
    });
  expect((await app.handle(request())).status).toBe(401);
  const response: Response = await app.handle(request(`Bearer ${token}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body: string = await response.text();
  expect(body).not.toContain(email);
  expect(body).not.toContain('redis://');
  expect(body).toContain('"scope":"process"');
  await prisma.user.update({ where: { id: userId }, data: { role: 'user' } });
  // JWTのroleは利用せず、同じトークンの管理権限が即時失効する。
  expect((await app.handle(request(`Bearer ${token}`))).status).toBe(403);
  await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
  await limiter.destroy();
});

it('checks JWT expiry and token type before accessing a cached user', async () => {
  const signer = jwt({ secret: getJwtSecret() }).decorator.jwt;
  const app = new Elysia().use(authMiddleware).get('/', ({ user }) => ({ user }));
  for (const claims of [
    { userId, type: 'access', exp: Math.floor(Date.now() / 1000) - 1 },
    { userId, type: 'refresh', exp: Math.floor(Date.now() / 1000) + 60 },
    { userId: -1, type: 'access', exp: Math.floor(Date.now() / 1000) + 60 },
  ]) {
    const token: string = await signer.sign(claims);
    const response: Response = await app.handle(
      new Request('http://localhost/', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(await response.json()).toEqual({ user: null });
  }
});

it.skipIf(!process.env.REDIS_TEST_URL)(
  'shares auth profiles across Redis clients while authoritative changes invalidate local copies',
  async () => {
    const { RedisCacheStore } = await import('../lib/shared-cache');
    const prefix: string = `auth-cache-test:${crypto.randomUUID()}:`;
    const first: SharedCache = new SharedCache(
      new RedisCacheStore(process.env.REDIS_TEST_URL ?? '', prefix),
      'redis',
    );
    const second: SharedCache = new SharedCache(
      new RedisCacheStore(process.env.REDIS_TEST_URL ?? '', prefix),
      'redis',
    );
    try {
      expect((await getAuthenticatedUser(userId, first))?.role).toBe('admin');
      expect((await getAuthenticatedUser(userId, second))?.role).toBe('admin');
      expect(second.stats().hits).toBe(1);
      expect(second.stats().localHits).toBe(0);
      const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      // Redisの無効化を意図的に実施しない。DBの権限比較だけで両方のL1を失効させる。
      await prisma.user.update({
        where: { id: userId },
        data: { role: 'user', updatedAt: before.updatedAt },
      });
      expect((await getAuthenticatedUser(userId, first))?.role).toBe('user');
      expect((await getAuthenticatedUser(userId, second))?.role).toBe('user');
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { role: 'admin' } });
      await Promise.all([first.destroy(), second.destroy()]);
    }
  },
);
