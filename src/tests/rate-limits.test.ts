import { beforeAll, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import prisma from '../lib/prisma';
import { MemoryRateLimitStore } from '../lib/rate-limit-store';
import { createRateLimit } from '../middlewares/rate-limit';
import { createAuthRouter } from '../routes/auth';

beforeAll(async () => {
  await import('../scripts/prepare-db').then((m) => m.default('test'));
});

it('isolates registration, login, refresh and profile quotas', async () => {
  const register = new MemoryRateLimitStore();
  const auth = new MemoryRateLimitStore();
  const app = new Elysia().group('/api', (a) => a.use(createAuthRouter({ register, auth })));
  const email = `quota-${Date.now()}@example.com`;
  const password = 'QuotaTest123!';
  const client = '192.0.2.91';
  const send = (path: string, body?: object, token?: string, ip = client) =>
    app.handle(
      new Request(`http://localhost/api/auth/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': ip,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    expect((await send('register', { email, password })).status).toBe(200);
    expect((await send('register', { email, password })).status).toBe(400);
    const login = await send('login', { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get('X-RateLimit-Remaining')).toBe('4');
    let tokens = await login.json();
    expect((await send('login', { email, password })).status).toBe(200);
    const session = async () => {
      const me = await send('me', undefined, tokens.accessToken);
      expect(me.status).toBe(200);
      expect(me.headers.has('X-RateLimit-Limit')).toBe(false);
      const refresh = await send('refresh', { refreshToken: tokens.refreshToken });
      expect(refresh.status).toBe(200);
      tokens = await refresh.json();
    };
    await session();
    expect((await send('register', { email, password })).status).toBe(400);
    const blocked = await send('register', { email, password });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
    for (let i = 0; i < 3; i++) expect((await send('login', { email, password })).status).toBe(200);
    expect((await send('login', { email, password })).status).toBe(429);
    await session();
    expect((await send('login', { email, password }, undefined, '192.0.2.92')).status).toBe(200);
    expect(
      (await send('logout', { refreshToken: tokens.refreshToken }, tokens.accessToken)).status,
    ).toBe(200);
  } finally {
    await register.destroy();
    await auth.destroy();
    await prisma.user.deleteMany({ where: { email } });
  }
});

it('enforces composed plugin headers, handler short-circuit, reset and expiry', async () => {
  const store = new MemoryRateLimitStore();
  let now = 2000000000000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let calls = 0;
  const limited = new Elysia()
    .use(createRateLimit({ max: 2, windowMs: 1000 }, store))
    .get('/limited', () => {
      calls++;
      return 'ok';
    })
    .post('/reset', async ({ rateLimit }) => {
      await rateLimit.reset();
      return 'reset';
    });
  const root = new Elysia().use(limited).get('/outside', () => 'outside');
  const request = (path = '/limited', method = 'GET') =>
    root.handle(new Request(`http://localhost${path}`, { method }));
  try {
    const first = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('1');
    expect(first.headers.get('X-RateLimit-Reset')).toBe('2000000001');
    expect((await request('/reset', 'POST')).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
    expect(calls).toBe(3);
    expect((await request('/outside')).status).toBe(200);
    now += 1000;
    expect((await request()).status).toBe(200);
    expect(calls).toBe(4);
  } finally {
    clock.mockRestore();
    await store.destroy();
  }
});
