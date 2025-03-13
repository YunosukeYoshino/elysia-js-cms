import { describe, expect, it } from 'bun:test';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { authRouter } from '../../src/routes/auth';
import { categoriesRouter } from '../../src/routes/categories';
import { filesRouter } from '../../src/routes/files';
import { postsRouter } from '../../src/routes/posts';
import { testClient } from '../helpers';

// テスト用にアプリケーションをセットアップ
function setupTestApp() {
  return new Elysia()
    .use(
      swagger({
        documentation: {
          info: {
            title: 'ElysiaJS CMS API Test',
            version: '1.0.0',
            description: 'テスト用API',
          },
          tags: [
            { name: 'auth', description: '認証関連のエンドポイント' },
            { name: 'posts', description: '投稿管理エンドポイント' },
            { name: 'categories', description: 'カテゴリ管理エンドポイント' },
            { name: 'files', description: 'ファイル管理エンドポイント' },
          ],
        },
      }),
    )
    .use(cors())
    .get('/', () => 'ElysiaJS CMS API Test')
    .group('/api', (app) =>
      app.use(authRouter).use(postsRouter).use(categoriesRouter).use(filesRouter),
    );
}

describe('Application Integration Tests', () => {
  let app: Elysia;

  // 各テスト前に新しいアプリインスタンスを作成
  beforeEach(() => {
    app = setupTestApp();
  });

  describe('Base Routes', () => {
    it('should respond to the root endpoint', async () => {
      const client = testClient(app);
      const response = await client.get('/');

      expect(response.status).toBe(200);
      expect(response.text).toContain('ElysiaJS CMS API Test');
    });

    it('should provide swagger documentation', async () => {
      const client = testClient(app);
      const response = await client.get('/swagger');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('API Routes', () => {
    // 各APIルートが正しくグルーピングされているか確認
    it('should route auth endpoints correctly', async () => {
      const client = testClient(app);
      const response = await client.post('/api/auth/login', {
        email: 'test@example.com',
        password: 'invalidpass',
      });

      // 実際のログインは失敗するが、ルートが存在するか確認
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    it('should route post endpoints correctly', async () => {
      const client = testClient(app);
      const response = await client.get('/api/posts');

      // レスポンス内容は空かもしれないが、ルートが存在するか確認
      expect(response.status).toBe(200);
    });

    it('should route category endpoints correctly', async () => {
      const client = testClient(app);
      const response = await client.get('/api/categories');

      expect(response.status).toBe(200);
    });

    it('should route file endpoints correctly', async () => {
      const client = testClient(app);
      const response = await client.get('/api/files');

      expect(response.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent routes', async () => {
      const client = testClient(app);
      const response = await client.get('/non-existent-route');

      expect(response.status).toBe(404);
    });
  });
});
