import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import app from '../index';
import prisma from '../lib/prisma';

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
  const client: string = `composed-${crypto.randomUUID()}`;
  const send = (path: string): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': client },
        body: JSON.stringify({ email, password: 'weak-password' }),
      }),
    );
  for (let attempt: number = 0; attempt < 3; attempt++) {
    const response: Response = await send('register');
    expect(response.status).toBe(400);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
  }
  const blockedRegistration: Response = await send('register');
  expect(blockedRegistration.status).toBe(429);
  expect(await blockedRegistration.json()).toMatchObject({ code: 'RATE_LIMITED' });
  for (let attempt: number = 0; attempt < 5; attempt++) {
    const response: Response = await send('login');
    expect(response.status).toBe(401);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
  }
  const blockedLogin: Response = await send('login');
  expect(blockedLogin.status).toBe(429);
  expect(await blockedLogin.json()).toMatchObject({ code: 'RATE_LIMITED' });
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
});
