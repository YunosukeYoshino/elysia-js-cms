import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import app from '../index';
import prisma from '../lib/prisma';
import { hierarchicalRateLimiter } from '../lib/rate-limit-policy';

describe('ElysiaJS CMS API', () => {
  beforeAll(() => {
    // 環境変数がテスト用に設定されているか確認
    expect(process.env.NODE_ENV).toBe('test');
  });

  afterAll(async () => {
    // Prismaの接続をクローズ
    await prisma.$disconnect();
  });

  // 基本的なヘルスチェック
  it('should return welcome message on root endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/'));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('ElysiaJS CMS API');
  });
});

it('keeps registration and login admission enabled in the composed application', async () => {
  const email: string = `composed-admission-${crypto.randomUUID()}@example.invalid`;
  const send = (path: string): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'weak-password' }),
      }),
    );
  for (let attempt: number = 0; attempt < 10; attempt++) {
    const response = await send('register');
    expect(response.status).toBe(400);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
  }
  const registration = await send('register');
  expect(registration.status).toBe(429);
  expect(await registration.json()).toMatchObject({ code: 'RATE_LIMITED' });
  await hierarchicalRateLimiter.destroy();
  for (let attempt: number = 0; attempt < 3; attempt++)
    expect((await send('login')).status).toBe(401);
  const login = await send('login');
  expect(login.status).toBe(429);
  expect(await login.json()).toMatchObject({ code: 'RATE_LIMITED' });
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
});
