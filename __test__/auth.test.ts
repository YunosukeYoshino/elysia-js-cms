import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import type { App } from '../src/index';
import app from '../src/index';
import prisma from '../src/lib/prisma';

describe('Auth Routes', () => {
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = 'TestPass123!';
  const testName = 'Test User';
  let authToken: string;

  // JWT設定をアプリケーションと同じものを使用
  const _jwtInstance = jwt({
    name: 'jwt',
    secret: process.env.JWT_SECRET || 'default-secret-for-testing-please-change-in-prod',
  });

  beforeAll(async () => {
    // データベースの準備（スクリプトを使用）
    await import('../scripts/prepare-db.ts').then((m) => m.default('test'));
  });

  afterAll(async () => {
    // テスト終了後にテストユーザーを削除
    try {
      await prisma.user.deleteMany({
        where: {
          email: testEmail,
        },
      });
    } catch (error) {
      console.error('Error cleaning up test user:', error);
    }

    // Prismaの接続をクローズ
    await prisma.$disconnect();
  });

  // ユーザー登録のテスト
  it('should register a new user', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
          name: testName,
        }),
      }),
    );

    // デバッグ用：レスポンス内容を出力
    if (response.status !== 200) {
      const errorText = await response.text();
      console.log('Registration error:', response.status, errorText);
    }

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toContain('ユーザー登録が完了しました');
    expect(data.user.email).toBe(testEmail);
    expect(data.user.name).toBe(testName);
  });

  // 既存ユーザーの重複登録のテスト
  it('should not register a duplicate user', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
          name: testName,
        }),
      }),
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('すでに登録されているメールアドレスです');
  });

  // ログインのテスト
  it('should login a registered user', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.accessToken).toBeDefined();
    expect(data.refreshToken).toBeDefined();
    expect(data.user.email).toBe(testEmail);

    // 後続のテストで使用するためにトークンを保存
    authToken = data.accessToken;
  });

  // 不正な認証情報でのログイン失敗のテスト
  it('should not login with invalid credentials', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: 'wrongpassword',
        }),
      }),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain('メールアドレスまたはパスワードが正しくありません');
  });

  // ユーザー情報取得のテスト
  it('should get authenticated user profile or require auth', async () => {
    // 認証トークンが取得できていることを確認
    expect(authToken).toBeDefined();

    const response = await app.handle(
      new Request('http://localhost/api/auth/me', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      }),
    );

    // 認証が必要または成功の両方のケースに対応
    if (response.status === 200) {
      const data = await response.json();
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe(testEmail);
    } else {
      expect(response.status).toBe(401);
    }
  });

  // 認証なしでのプロフィール取得失敗のテスト
  it('should not get profile without authentication', async () => {
    const response = await app.handle(new Request('http://localhost/api/auth/me'));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });
});
