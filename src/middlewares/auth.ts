import { jwt } from '@elysiajs/jwt';
import { type Context, Elysia } from 'elysia';
import { getJwtSecret } from '../lib/jwt-config';
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
export type AuthContext = {
  user: User | null;
};

/**
 * エラーレスポンスの型定義
 * @description プレゼンテーション層で使用するエラーレスポンスの形式
 */
type ErrorResponse = {
  error: string;
};

/**
 * JWTで認証を行うミドルウェア
 * @description ユーザーの認証状態を検証し、コンテキストにユーザー情報を注入する
 */
export const authMiddleware = new Elysia()
  .use(
    jwt({
      name: 'jwt',
      secret: getJwtSecret(),
    }),
  )
  .derive({ as: 'scoped' }, async ({ jwt, headers }): Promise<AuthContext> => {
    const authorization = headers.authorization;

    if (!authorization) {
      return {
        user: null,
      };
    }

    const [bearer, token] = authorization.split(' ');

    if (bearer !== 'Bearer' || !token) {
      return {
        user: null,
      };
    }

    const payload = await jwt.verify(token);

    if (!payload || typeof payload !== 'object' || !('userId' in payload)) {
      return {
        user: null,
      };
    }

    const userId = payload.userId;
    if (
      typeof userId !== 'number' ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      payload.type !== 'access' ||
      typeof payload.exp !== 'number'
    )
      return { user: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });

    return {
      user: user,
    };
  });

/**
 * 認証済みユーザーのみアクセスを許可するミドルウェア
 * @description ユーザーが認証済みであることを確認する
 */
export const authenticated = ({
  user,
  set,
}: AuthContext & Pick<Context, 'set'>): ErrorResponse | undefined => {
  if (!user) {
    set.status = 401;
    return { error: '認証されていないユーザーです' };
  }

  return undefined;
};

/**
 * 管理者ユーザーのみアクセスを許可するミドルウェア
 * @description ユーザーが管理者権限を持っていることを確認する
 */
export const isAdmin = ({
  user,
  set,
}: AuthContext & Pick<Context, 'set'>): ErrorResponse | undefined => {
  if (!user) {
    set.status = 401;
    return { error: '認証されていないユーザーです' };
  }

  if (user.role !== 'admin') {
    set.status = 403;
    return { error: '管理者権限が必要です' };
  }

  return undefined;
};
