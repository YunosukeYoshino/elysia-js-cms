import { Elysia, t } from 'elysia';
import { DomainError } from '../domain/errors/domain-error';
import { AuthService } from '../domain/services/auth-service';
import prisma from '../lib/prisma';
import type { RateLimitStore } from '../lib/rate-limit-store';
import { authMiddleware } from '../middlewares/auth';
import { domainErrorPlugin } from '../middlewares/domain-error';
import { createAuthRateLimit, createRegisterRateLimit } from '../middlewares/rate-limit';

/**
 * 認証関連のルーティング定義
 * DDDアプローチに基づき、プレゼンテーション層としてのルーティングを実装
 */
export const createAuthRouter = (
  stores: { register?: RateLimitStore; auth?: RateLimitStore; externalRateLimit?: boolean } = {},
  service: AuthService = new AuthService(prisma),
) =>
  new Elysia({ name: 'cms.auth-routes', prefix: '/auth' })
    .use(domainErrorPlugin)
    .use(authMiddleware)
    // ユーザー登録エンドポイント
    .group(
      '',
      (app) =>
        app
          .use(stores.externalRateLimit ? new Elysia() : createRegisterRateLimit(stores.register))
          .post('/register', ({ body }) => service.register(body), {
            body: t.Object({
              email: t.String({ format: 'email' }),
              password: t.String({ minLength: 8, maxLength: 128 }),
              name: t.Optional(t.String()),
            }),
            detail: {
              tags: ['auth'],
              summary: '新規ユーザー登録',
              description: 'アカウントを作成します',
            },
          }),
      // ログインエンドポイント
    )
    .group(
      '',
      (app) =>
        app
          .use(stores.externalRateLimit ? new Elysia() : createAuthRateLimit(stores.auth))
          .post(
            '/login',
            ({ body, jwt }) => service.login(body, (claims) => jwt.sign({ ...claims })),
            {
              body: t.Object({
                email: t.String({ format: 'email' }),
                password: t.String(),
              }),
              detail: {
                tags: ['auth'],
                summary: 'ログイン',
                description: 'ユーザー認証を行いJWTトークンを取得します',
              },
            },
          ),
      // リフレッシュトークンエンドポイント
    )
    .post(
      '/refresh',
      ({ body, jwt }) => service.refresh(body.refreshToken, (claims) => jwt.sign({ ...claims })),
      {
        body: t.Object({
          refreshToken: t.String(),
        }),
        detail: {
          tags: ['auth'],
          summary: 'トークンリフレッシュ',
          description: 'リフレッシュトークンを使用して新しいアクセストークンを取得します',
        },
      },
    )
    // ログアウトエンドポイント
    .post(
      '/logout',
      ({ body, user }) => {
        if (!user) throw new DomainError('AUTH_REQUIRED', 401, '認証が必要です');
        return service.logout(user.id, body);
      },
      {
        body: t.Object({
          refreshToken: t.Optional(t.String()),
          logoutAll: t.Optional(t.Boolean()),
        }),
        detail: {
          tags: ['auth'],
          summary: 'ログアウト',
          description: 'リフレッシュトークンを無効化してログアウトします',
          security: [{ bearerAuth: [] }],
        },
      },
    )
    // ユーザー情報取得エンドポイント
    .get(
      '/me',
      async ({ user, set }) => {
        if (!user) {
          set.status = 401;
          return { error: '認証が必要です' };
        }

        return { user };
      },
      {
        detail: {
          tags: ['auth'],
          summary: '自分のプロフィール取得',
          description: 'ログインしているユーザー自身の情報を取得します',
          security: [{ bearerAuth: [] }],
        },
      },
    );

// メインアプリでは階層型リミッターだけが admission を担当する。
export const authRouter = createAuthRouter({ externalRateLimit: true });
