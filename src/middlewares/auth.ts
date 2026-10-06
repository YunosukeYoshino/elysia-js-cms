import { jwt } from '@elysiajs/jwt';
import { type Context, Elysia } from 'elysia';
import { getAuthenticatedUser } from '../lib/auth-cache';
import { getJwtSecret } from '../lib/jwt-config';

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

const requestUsers: WeakMap<Request, Promise<User | null>> = new WeakMap();

/** 検証済みIDをリクエスト内だけで共有し、早期制限とルートで二重認証しない。 */
export function authenticateRequest(
  request: Request,
  verify: (token: string) => Promise<unknown>,
): Promise<User | null> {
  const existing: Promise<User | null> | undefined = requestUsers.get(request);
  if (existing) return existing;
  const pending: Promise<User | null> = (async (): Promise<User | null> => {
    const authorization: string | null = request.headers.get('authorization');
    if (!authorization) return null;
    const parts: string[] = authorization.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return null;
    const payload: unknown = await verify(parts[1]);
    if (!payload || typeof payload !== 'object' || !('userId' in payload)) return null;
    const userId: unknown = payload.userId;
    if (
      typeof userId !== 'number' ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      !('type' in payload) ||
      payload.type !== 'access' ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number'
    )
      return null;
    return getAuthenticatedUser(userId);
  })();
  requestUsers.set(request, pending);
  return pending;
}

/** JWTで認証し、DBで検証したユーザーをコンテキストへ注入する。 */
export const authMiddleware = new Elysia({ name: 'auth-context' })
  .use(jwt({ name: 'jwt', secret: getJwtSecret() }))
  .derive(
    { as: 'scoped' },
    async ({ jwt, request }): Promise<AuthContext> => ({
      user: await authenticateRequest(request, jwt.verify),
    }),
  );

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
