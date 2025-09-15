import { jwt } from '@elysiajs/jwt';
import { type DefaultContext, Elysia } from 'elysia';
import prisma from '../lib/prisma';

/**
 * ユーザーエンティティの型定義
 */
export interface User {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

/**
 * 認証コンテキストの型定義
 * @description ドメイン層で使用する認証関連の情報を定義
 */
export interface AuthContext {
  user: User | null;
}

/**
 * エラーレスポンスの型定義
 * @description プレゼンテーション層で使用するエラーレスポンスの形式
 */
type ErrorResponse = {
  error: string;
};

/**
 * 認証レスポンスの型定義
 * @description プレゼンテーション層で使用する認証結果のレスポンス形式
 */
type AuthResponse =
  | {
      isAuthenticated: true;
    }
  | ErrorResponse;

/**
 * 管理者認証レスポンスの型定義
 * @description プレゼンテーション層で使用する管理者認証結果のレスポンス形式
 */
type AdminResponse =
  | {
      isAdmin: true;
    }
  | ErrorResponse;

/**
 * JWTで認証を行うミドルウェア
 * @description ユーザーの認証状態を検証し、コンテキストにユーザー情報を注入する
 */
export const authMiddleware = new Elysia()
  .use(
    jwt({
      name: 'jwt',
      secret: process.env.JWT_SECRET || 'default-secret-for-testing-please-change-in-prod',
    }),
  )
  .derive(async ({ jwt, headers }): Promise<AuthContext & { set: { status: number } }> => {
    const authorization = headers.authorization;

    if (!authorization) {
      return {
        user: null,
        set: { status: 401 },
      };
    }

    const [bearer, token] = authorization.split(' ');

    if (bearer !== 'Bearer' || !token) {
      return {
        user: null,
        set: { status: 401 },
      };
    }

    const payload = await jwt.verify(token);

    if (!payload || typeof payload !== 'object' || !('userId' in payload)) {
      return {
        user: null,
        set: { status: 401 },
      };
    }

    const user = await prisma.user.findUnique({
      where: { id: Number(payload.userId) },
      select: { id: true, email: true, name: true, role: true },
    });

    return {
      user: user as User | null,
      set: { status: user ? 200 : 401 },
    };
  });

/**
 * 認証済みユーザーのみアクセスを許可するミドルウェア
 * @description ユーザーが認証済みであることを確認する
 */
export const authenticated = new Elysia().derive(
  async ({ user, set }: AuthContext & DefaultContext): Promise<AuthResponse> => {
    if (!user) {
      set.status = 401;
      return { error: '認証されていないユーザーです' };
    }

    set.status = 200;
    return { isAuthenticated: true };
  },
);

/**
 * 管理者ユーザーのみアクセスを許可するミドルウェア
 * @description ユーザーが管理者権限を持っていることを確認する
 */
export const isAdmin = new Elysia().derive(
  async ({ user, set }: AuthContext & DefaultContext): Promise<AdminResponse> => {
    if (!user) {
      set.status = 401;
      return { error: '認証されていないユーザーです' };
    }

    if (user.role !== 'admin') {
      set.status = 403;
      return { error: '管理者権限が必要です' };
    }

    set.status = 200;
    return { isAdmin: true };
  },
);
