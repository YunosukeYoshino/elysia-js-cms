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
