import { jwt } from '@elysiajs/jwt';
import { Elysia, t } from 'elysia';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';

/**
 * 認証関連のルーティング定義
 * DDDアプローチに基づき、プレゼンテーション層としてのルーティングを実装
 */
export const authRouter = new Elysia({ prefix: '/auth' })
  .use(authMiddleware)
  // ユーザー登録エンドポイント
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

      try {
        // ハッシュ化はバックエンドで行うべきですが、デモなので簡略化
        // 実際の実装では bcrypt や Argon2 などを使用してください
        const user = await prisma.user.create({
          data: {
            email,
            password, // 本番では必ずハッシュ化してください！
            name,
            role: 'user', // デフォルトロールを明示的に設定
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
      } catch (error) {
        set.status = 500;
        return { error: 'ユーザー登録に失敗しました' };
      }
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 6 }),
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
  .post(
    '/login',
    async ({ body, set, jwt }) => {
      const { email, password } = body;

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        set.status = 401;
        return { error: 'メールアドレスまたはパスワードが正しくありません' };
      }

      // 実際の実装ではハッシュを検証します
      // このデモでは簡略化のため平文で比較しています
      const passwordValid = user.password === password;

      if (!passwordValid) {
        set.status = 401;
        return { error: 'メールアドレスまたはパスワードが正しくありません' };
      }

      // JWTトークンを生成
      const token = await jwt.sign({
        userId: user.id,
        role: user.role,
      });

      return {
        token,
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
