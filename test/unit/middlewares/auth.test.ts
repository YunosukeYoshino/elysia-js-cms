import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import { authMiddleware, authenticated, isAdmin } from '../../../src/middlewares/auth';

// Prismaクライアントのモック
const mockPrisma = {
  user: {
    findUnique: mock((query) => {
      const userId = query.where.id;

      if (userId === 1) {
        return {
          id: 1,
          email: 'admin@example.com',
          name: 'Admin User',
          role: 'admin',
        };
      }
      if (userId === 2) {
        return {
          id: userId,
          email: 'user@example.com',
          name: 'Test User',
          role: 'user',
        };
      }

      return null;
    }),
  },
};

// prismaモジュールのモック
mock.module('../../../src/lib/prisma', () => {
  return { default: mockPrisma };
});

describe('Auth Middleware', () => {
  let testApp: Elysia;
  let adminToken: string;
  let userToken: string;
  let invalidToken: string;

  beforeAll(async () => {
    // テスト用のトークン生成
    const jwtInstance = jwt({
      name: 'jwt',
      secret: 'test-secret',
    });

    const jwtApp = new Elysia().use(jwtInstance);
    adminToken = await jwtApp.jwt.sign({ userId: 1 });
    userToken = await jwtApp.jwt.sign({ userId: 2 });
    invalidToken = await jwtApp.jwt.sign({ foo: 'bar' });

    // テスト用アプリケーション作成
    testApp = new Elysia()
      .use(authMiddleware)
      .get('/public', () => 'Public route')
      .get('/protected', ({ user }) => ({ user }), {
        beforeHandle: [authenticated],
      })
      .get('/admin', ({ user }) => ({ user }), { beforeHandle: [isAdmin] });
  });

  describe('authMiddleware', () => {
    it('should attach user object when valid admin token is provided', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/public', {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );

      const user = await testApp.handle.store.user;
      expect(user).toBeDefined();
      expect(user?.id).toBe(1);
      expect(user?.role).toBe('admin');
    });

    it('should attach user object when valid user token is provided', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/public', {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );

      const user = await testApp.handle.store.user;
      expect(user).toBeDefined();
      expect(user?.id).toBe(2);
      expect(user?.role).toBe('user');
    });

    it('should return null user when no token is provided', async () => {
      const result = await testApp.handle(new Request('http://localhost/public'));

      const user = await testApp.handle.store.user;
      expect(user).toBeNull();
    });

    it('should return null user when invalid token is provided', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/public', {
          headers: { Authorization: `Bearer ${invalidToken}` },
        }),
      );

      const user = await testApp.handle.store.user;
      expect(user).toBeNull();
    });
  });

  describe('authenticated middleware', () => {
    it('should allow access to authenticated endpoints with valid token', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/protected', {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );

      expect(result.status).toBe(200);
    });

    it('should deny access to authenticated endpoints without token', async () => {
      const result = await testApp.handle(new Request('http://localhost/protected'));

      expect(result.status).toBe(401);
    });
  });

  describe('isAdmin middleware', () => {
    it('should allow access to admin endpoints with admin token', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/admin', {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );

      expect(result.status).toBe(200);
    });

    it('should deny access to admin endpoints with regular user token', async () => {
      const result = await testApp.handle(
        new Request('http://localhost/admin', {
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );

      expect(result.status).toBe(403);
    });

    it('should deny access to admin endpoints without token', async () => {
      const result = await testApp.handle(new Request('http://localhost/admin'));

      expect(result.status).toBe(403);
    });
  });
});
