import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import prisma from '../lib/prisma';

// JWTで認証を行うミドルウェア
export const authMiddleware = new Elysia()
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET || 'default-secret-for-testing-please-change-in-prod',
    })
  )
  .derive(async ({ jwt, headers }) => {
    const authorization = headers.authorization;
    
    // ヘッダーからトークンを取得
    const token = authorization?.split(' ')[1];
    if (!token) {
      return {
        user: null,
      };
    }

    // トークンを検証
    const payload = await jwt.verify(token);
    if (!payload || !payload.userId) {
      return {
        user: null,
      };
    }

    // トークンからユーザーIDを取得し、データベースでユーザーを検索
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true, role: true },
    });

    return {
      user,
    };
  });

// 認証済みユーザーのみアクセスを許可する
export const authenticated = (app: Elysia) =>
  app.derive({ as: 'global' }, async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    
    return { isAuthenticated: true };
  });

// 管理者ユーザーのみアクセスを許可する
export const isAdmin = (app: Elysia) =>
  app.derive({ as: 'global' }, async ({ user, set }) => {
    if (!user || user.role !== 'admin') {
      set.status = 403;
      return { error: 'Forbidden: Admin access required' };
    }
    
    return { isAdmin: true };
  });