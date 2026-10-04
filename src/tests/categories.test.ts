import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import app from '../index';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';

describe('Categories Routes', () => {
  const testEmail = `test-admin-${Date.now()}@example.com`;
  const testPassword = 'password123';
  const testName = 'Category Test Admin';
  let userId: number;

  beforeAll(async () => {
    // データベーススキーマをリセット
    await import('../scripts/prepare-db.ts').then((m) => m.default('test'));
    // 管理者ユーザーを作成
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        password: testPassword,
        name: testName,
        role: 'admin', // 管理者権限を持つユーザー
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    try {
      // ユーザーを削除
      await prisma.user.delete({
        where: { id: userId },
      });
    } catch (error) {
      console.error('Error cleaning up test data:', error);
    }

    // Prismaの接続をクローズ
    await prisma.$disconnect();
  });

  // カテゴリ一覧取得のテスト
  it('should get a list of categories', async () => {
    const response = await app.handle(new Request('http://localhost/api/categories'));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
  });

  // カテゴリ作成のテスト - セキュリティ上の問題を特定
  it('should require authentication for category creation', async () => {
    const categoryName = `Test Category ${Date.now()}`;
    const categorySlug = `test-category-${Date.now()}`;

    const response = await app.handle(
      new Request('http://localhost/api/categories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: categoryName,
          slug: categorySlug,
        }),
      }),
    );

    expect(response.status).toBe(401);

    // 成功した場合は作成されたカテゴリを検証し、削除
    if (response.status === 201 || response.status === 200) {
      const data = await response.json();
      expect(data.name).toBe(categoryName);
      expect(data.slug).toBe(categorySlug);

      // 作成されたカテゴリを削除（テスト後のクリーンアップ）
      if (data.id) {
        await prisma.category
          .delete({
            where: { id: data.id },
          })
          .catch((e) => console.log('Cleanup error:', e));
      }
    }
  });

  // 存在しないカテゴリへのアクセステスト
  it('should handle non-existent category', async () => {
    const response = await app.handle(new Request('http://localhost/api/categories/999999'));

    expect(response.status).toBe(404);
  });

  // 認証なしでのカテゴリ更新のテスト - セキュリティ上の問題を特定
  it('should require authentication for category updates', async () => {
    const updatedName = `Updated Category ${Date.now()}`;

    const response = await app.handle(
      new Request('http://localhost/api/categories/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: updatedName,
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  // 認証なしでのカテゴリ削除のテスト - セキュリティ上の問題を特定
  it('should require authentication for category deletion', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/categories/1', {
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(401);
  });
  it('enforces real category role permissions', async () => {
    const slug = 'role-check-' + Date.now();
    const category = await prisma.category.create({ data: { name: slug, slug } });
    const token = await authMiddleware.decorator.jwt.sign({
      userId,
      type: 'access',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    try {
      for (const role of ['user', 'admin']) {
        await prisma.user.update({ where: { id: userId }, data: { role } });
        for (const method of ['POST', 'PUT', 'DELETE']) {
          const url =
            'http://localhost/api/categories' + (method === 'POST' ? '' : '/' + category.id);
          const response = await app.handle(
            new Request(url, {
              method,
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body:
                method === 'DELETE'
                  ? undefined
                  : JSON.stringify({
                      name: slug + method,
                      ...(method === 'POST' ? { slug: slug + '-new' } : {}),
                    }),
            }),
          );
          expect(response.status).toBe(role === 'user' ? 403 : method === 'POST' ? 201 : 200);
        }
      }
    } finally {
      await prisma.category.deleteMany({ where: { slug: { startsWith: slug } } });
    }
  });
});
