import { Elysia, t } from 'elysia';
import { containerPlugin } from '../container';
import { authMiddleware } from '../middlewares/auth';
import { authRateLimit, registerRateLimit } from '../middlewares/rate-limit';

/**
 * 認証関連のルーティング定義
 * サービス層を使用したプレゼンテーション層の実装
 */
export const authRouter = new Elysia({ prefix: '/auth' })
  .use(containerPlugin)
  .use(authMiddleware)
  // ユーザー登録エンドポイント
  .use(registerRateLimit)
  .post(
    '/register',
    async ({ body, services }) => {
      const user = await services.auth.register(body);
      return {
        message: 'ユーザー登録が完了しました',
        user,
      };
    },
    {
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
    },
  )
  // ログインエンドポイント
  .use(authRateLimit)
  .post(
    '/login',
    async ({ body, services, jwt }) => {
      const loginResponse = await services.auth.login(body, jwt.sign.bind(jwt));
      return loginResponse;
    },
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
  )
  // リフレッシュトークンエンドポイント
  .post(
    '/refresh',
    async ({ body, services, jwt }) => {
      const refreshResponse = await services.auth.refreshToken(body, jwt.sign.bind(jwt));
      return refreshResponse;
    },
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
    async ({ body, services, user }) => {
      if (!user) {
        throw new Error('AUTHENTICATION_REQUIRED');
      }

      const result = await services.auth.logout(body, Number(user.id));
      return result;
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
    async ({ services, user }) => {
      if (!user) {
        throw new Error('AUTHENTICATION_REQUIRED');
      }

      const profile = await services.auth.getProfile(Number(user.id));
      return profile;
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
