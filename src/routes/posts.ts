import type { User } from '@prisma/client';
import { Elysia, t } from 'elysia';
import { containerPlugin, type ServiceContainer } from '../container';
import { authenticated, authMiddleware } from '../middlewares/auth';

/**
 * 投稿関連のルーティング定義
 * サービス層を使用したプレゼンテーション層の実装
 */
export const postsRouter = new Elysia({ prefix: '/posts' })
  .use(containerPlugin)
  .use(authMiddleware)
  // 全ての投稿を取得
  .get(
    '/',
    async ({
      query,
      services,
    }: {
      query: Record<string, string | undefined>;
      services: ServiceContainer;
    }) => {
      const filters = {
        published:
          query.published === 'true' ? true : query.published === 'false' ? false : undefined,
        authorId: query.authorId ? Number.parseInt(query.authorId, 10) : undefined,
        categoryId: query.categoryId ? Number.parseInt(query.categoryId, 10) : undefined,
        take: Number.parseInt(query.take as string, 10) || 10,
        skip: Number.parseInt(query.skip as string, 10) || 0,
      };

      return await services.post.getPosts(filters);
    },
    {
      query: t.Object({
        published: t.Optional(t.String()),
        authorId: t.Optional(t.String()),
        categoryId: t.Optional(t.String()),
        take: t.Optional(t.String()),
        skip: t.Optional(t.String()),
      }),
      detail: {
        tags: ['posts'],
        summary: '投稿一覧の取得',
        description: 'フィルタリングやページネーションオプション付きで投稿を取得します',
      },
    },
  )
  // IDで投稿を取得
  .get(
    '/:id',
    async ({
      params,
      set,
      services,
    }: {
      params: { id: string };
      set: { status: number };
      services: ServiceContainer;
    }) => {
      const postId = Number.parseInt(params.id, 10);
      const result = await services.post.getPostById(postId);

      if (!result.success) {
        set.status = 404;
      }

      return result;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        tags: ['posts'],
        summary: '投稿の詳細取得',
        description: 'IDを指定して特定の投稿を取得します',
      },
    },
  )
  // 新しい投稿を作成
  .post(
    '/',
    async ({
      body,
      user,
      set,
      services,
    }: {
      body: { title: string; content: string; published?: boolean; categoryIds?: number[] };
      user: User | null;
      set: { status: number };
      services: ServiceContainer;
    }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const result = await services.post.createPost({ ...body, authorId: user.id });

      if (!result.success) {
        set.status = 400;
      }

      return result;
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        content: t.String(),
        published: t.Optional(t.Boolean()),
        categoryIds: t.Optional(t.Array(t.Number())),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['posts'],
        summary: '新規投稿の作成',
        description: '新しい投稿を作成します（認証が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // 投稿を更新
  .put(
    '/:id',
    async ({
      params,
      body,
      user,
      set,
      services,
    }: {
      params: { id: string };
      body: { title?: string; content?: string; published?: boolean; categoryIds?: number[] };
      user: User | null;
      set: { status: number };
      services: ServiceContainer;
    }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const postId = Number.parseInt(params.id, 10);
      const result = await services.post.updatePost(postId, body, user.id, user.role);

      if (!result.success) {
        if (result.error === '投稿が見つかりません') {
          set.status = 404;
        } else if (result.error === 'この操作を行う権限がありません') {
          set.status = 403;
        } else {
          set.status = 400;
        }
      }

      return result;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1 })),
        content: t.Optional(t.String()),
        published: t.Optional(t.Boolean()),
        categoryIds: t.Optional(t.Array(t.Number())),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['posts'],
        summary: '投稿の更新',
        description: '既存の投稿を更新します（認証と権限が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // 投稿を削除
  .delete(
    '/:id',
    async ({
      params,
      user,
      set,
      services,
    }: {
      params: { id: string };
      user: User | null;
      set: { status: number };
      services: ServiceContainer;
    }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const postId = Number.parseInt(params.id, 10);
      const result = await services.post.deletePost(postId, user.id, user.role);

      if (!result.success) {
        if (result.error === '投稿が見つかりません') {
          set.status = 404;
        } else if (result.error === 'この操作を行う権限がありません') {
          set.status = 403;
        } else {
          set.status = 400;
        }
      }

      return result;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      beforeHandle: [authenticated],
      detail: {
        tags: ['posts'],
        summary: '投稿の削除',
        description: '投稿を削除します（認証と権限が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  );
