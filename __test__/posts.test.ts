import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { App } from '../src/index';
import app from '../src/index';
import prisma from '../src/lib/prisma';

describe('Posts Routes', () => {
  let server: ReturnType<App['listen']>;
  const testEmail = `test-posts-${Date.now()}@example.com`;
  const testPassword = 'password123';
  const testName = 'Post Test User';
  let userId: number;

  beforeAll(async () => {
    // テスト用にサーバーを起動
    server = app.listen(0);

    // テストユーザーを作成
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        password: testPassword,
        name: testName,
        role: 'user',
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    // テスト終了後にテストデータをクリーンアップ
    try {
      // 投稿を削除
      await prisma.post.deleteMany({
        where: { authorId: userId },
      });

      // ユーザーを削除
      await prisma.user.delete({
        where: { id: userId },
      });
    } catch (error) {
      console.error('Error cleaning up test data:', error);
    }

    // サーバーを停止
    server.stop();

    // Prismaの接続をクローズ
    await prisma.$disconnect();
  });

  // 投稿一覧取得のテスト
  it('should get a list of posts', async () => {
    const response = await app.handle(new Request('http://localhost/api/posts'));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.meta).toBeDefined();
  });

  // 投稿作成のテスト - 認証が必要
  it('should require authentication to create a post', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Test Post Title',
          content: 'This is a test post content',
          published: true,
        }),
      }),
    );

    expect(response.status).toBe(401);
    
    // TODO: 追加すべきテスト:
    // - 異なるユーザーロール（一般ユーザー、管理者）での投稿作成テスト
    // - 権限のないユーザーによる管理者専用機能へのアクセス試行テスト
    // - ユーザーが自分の投稿のみを編集/削除できることの検証
  });

  // 存在しない投稿へのアクセステスト
  it('should handle non-existent post', async () => {
    const response = await app.handle(new Request('http://localhost/api/posts/999999'));

    expect(response.status).toBe(404);
  });

  // 認証なしでの投稿更新失敗のテスト
  it('should not update a post without authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/posts/1', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'This should fail',
          content: 'This update should fail',
        }),
      }),
    );

    expect(response.status).toBe(401);
  });

  // 認証なしでの投稿削除失敗のテスト
  it('should not delete a post without authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/posts/1', {
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(401);
  });
});
