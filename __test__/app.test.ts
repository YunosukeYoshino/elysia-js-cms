import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { App } from '../src/index';
import app from '../src/index';
import prisma from '../src/lib/prisma';

describe('ElysiaJS CMS API', () => {
  let server: ReturnType<App['listen']>;

  beforeAll(() => {
    // テスト用にサーバーを起動
    server = app.listen(0);

    // 環境変数がテスト用に設定されているか確認
    expect(process.env.NODE_ENV).toBe('test');
  });

  afterAll(() => {
    // テスト終了後にサーバーを停止
    server.stop();

    // Prismaの接続をクローズ
    prisma.$disconnect();
  });

  // 基本的なヘルスチェック
  it('should return welcome message on root endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/'));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('ElysiaJS CMS API');
  });
});
