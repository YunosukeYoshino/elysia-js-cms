import { Elysia, t } from 'elysia';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';
import { authRateLimit, registerRateLimit } from '../middlewares/rate-limit';
import {
  AUTH_CONFIG,
  checkAccountLockByEmail,
  createRefreshToken,
  incrementLoginAttempts,
  resetLoginAttempts,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  validateRefreshToken,
} from '../utils/auth-security';
import {
  generateSecureToken,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../utils/password';

/**
 * 認証関連のルーティング定義
 * DDDアプローチに基づき、プレゼンテーション層としてのルーティングを実装
 */
export const authRouter = new Elysia({ prefix: '/auth' })
  .use(authMiddleware)
  // ユーザー登録エンドポイント
  .use(registerRateLimit)
  .post(
    '/register',
    async ({ body, set }) => {
      const { email, password, name } = body;

      // 既存ユーザーの確認
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        set.status = 400;
        return { error: 'すでに登録されているメールアドレスです' };
      }

      // パスワード強度チェック
      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.isValid) {
        set.status = 400;
        return {
          error: 'パスワードが要件を満たしていません',
          details: passwordValidation.errors,
        };
      }

      try {
        // パスワードをハッシュ化
        const { hash } = await hashPassword(password);

        const user = await prisma.user.create({
          data: {
            email,
            password: hash,
            name,
            role: 'user',
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
        });

        return {
          message: 'ユーザー登録が完了しました',
          user,
        };
      } catch (_error) {
        set.status = 500;
        return { error: 'ユーザー登録に失敗しました' };
      }
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
    async ({ body, set, jwt }) => {
      const { email, password } = body;

      // ユーザーの存在確認
      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        set.status = 401;
        return { error: 'メールアドレスまたはパスワードが正しくありません' };
      }

      // アカウントロック状態をチェック
      const { isLocked, lockedUntil } = await checkAccountLockByEmail(email);
      if (isLocked && lockedUntil) {
        set.status = 423;
        return {
          error: `アカウントがロックされています。${lockedUntil.toLocaleString('ja-JP')}以降に再試行してください。`,
        };
      }

      // パスワード検証
      const passwordValid = await verifyPassword(password, user.password);

      if (!passwordValid) {
        // ログイン失敗時の処理
        await incrementLoginAttempts(user.id);
        set.status = 401;
        return { error: 'メールアドレスまたはパスワードが正しくありません' };
      }

      // ログイン成功時の処理
      await resetLoginAttempts(user.id);

      // アクセストークンを生成（短い有効期限）
      const accessToken = await jwt.sign(
        {
          userId: user.id,
          role: user.role,
          type: 'access',
        },
        {
          expiresIn: `${AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES}m`,
        },
      );

      // リフレッシュトークンを生成
      const refreshToken = generateSecureToken(64);
      await createRefreshToken(user.id, refreshToken);

      return {
        accessToken,
        refreshToken,
        expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60, // 秒単位
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
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
    async ({ body, set, jwt }) => {
      const { refreshToken } = body;

      // リフレッシュトークンを検証
      const tokenData = await validateRefreshToken(refreshToken);
      if (!tokenData) {
        set.status = 401;
        return { error: '無効なリフレッシュトークンです' };
      }

      // ユーザー情報を取得
      const user = await prisma.user.findUnique({
        where: { id: tokenData.userId },
        select: { id: true, email: true, name: true, role: true },
      });

      if (!user) {
        set.status = 401;
        return { error: 'ユーザーが見つかりません' };
      }

      // 新しいアクセストークンを生成
      const accessToken = await jwt.sign(
        {
          userId: user.id,
          role: user.role,
          type: 'access',
        },
        {
          expiresIn: `${AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES}m`,
        },
      );

      // 古いリフレッシュトークンを削除し、新しいものを生成
      await revokeRefreshToken(refreshToken);
      const newRefreshToken = generateSecureToken(64);
      await createRefreshToken(user.id, newRefreshToken);

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: AUTH_CONFIG.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
      };
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
    async ({ body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const { refreshToken, logoutAll } = body;

      if (logoutAll) {
        // 全デバイスからログアウト
        await revokeAllRefreshTokens(user.id);
      } else if (refreshToken) {
        // 特定のリフレッシュトークンのみ削除
        await revokeRefreshToken(refreshToken);
      }

      return { message: 'ログアウトしました' };
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
