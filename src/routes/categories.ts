import { Elysia, t } from 'elysia';
import { containerPlugin, type ServiceContainer } from '../container';
import { authenticated, authMiddleware, isAdmin } from '../middlewares/auth';

/**
 * カテゴリ関連のルーティング定義
 * サービス層を使用したプレゼンテーション層の実装
 */
export const categoriesRouter = new Elysia({ prefix: '/categories' })
  .use(containerPlugin)
  .use(authMiddleware)
  // 全てのカテゴリを取得
  .get(
    '/',
    async ({ services }: { services: ServiceContainer }) => {
      return await services.category.getCategories();
    },
    {
      detail: {
        tags: ['categories'],
        summary: 'カテゴリ一覧の取得',
        description: '全てのカテゴリを取得します',
      },
    },
  )
  // IDでカテゴリを取得
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
      const categoryId = Number.parseInt(params.id, 10);
      const result = await services.category.getCategoryById(categoryId);

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
        tags: ['categories'],
        summary: 'カテゴリの詳細取得',
        description: 'IDを指定して特定のカテゴリを取得します',
      },
    },
  )
  // 新しいカテゴリを作成（管理者のみ）
  .post(
    '/',
    async ({
      body,
      set,
      services,
    }: {
      body: { name: string; slug: string };
      set: { status: number };
      services: ServiceContainer;
    }) => {
      const result = await services.category.createCategory(body);

      if (result.success) {
        set.status = 201;
        return result.data;
      } else {
        set.status = 400;
        return { error: result.error };
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        slug: t.String({ minLength: 1, pattern: '^[a-z0-9-]+$' }),
      }),
      beforeHandle: [authenticated, isAdmin],
      detail: {
        tags: ['categories'],
        summary: '新規カテゴリの作成',
        description: '新しいカテゴリを作成します（管理者権限が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // カテゴリを更新（管理者のみ）
  .put(
    '/:id',
    async ({
      params,
      body,
      set,
      services,
    }: {
      params: { id: string };
      body: { name?: string; slug?: string };
      set: { status: number };
      services: ServiceContainer;
    }) => {
      const categoryId = Number.parseInt(params.id, 10);
      const result = await services.category.updateCategory(categoryId, body);

      if (!result.success) {
        if (result.error === 'カテゴリが見つかりません') {
          set.status = 404;
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
        name: t.Optional(t.String({ minLength: 1 })),
        slug: t.Optional(t.String({ minLength: 1, pattern: '^[a-z0-9-]+$' })),
      }),
      beforeHandle: [authenticated, isAdmin],
      detail: {
        tags: ['categories'],
        summary: 'カテゴリの更新',
        description: '既存のカテゴリを更新します（管理者権限が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // カテゴリを削除（管理者のみ）
  .delete(
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
      const categoryId = Number.parseInt(params.id, 10);
      const result = await services.category.deleteCategory(categoryId);

      if (!result.success) {
        if (result.error === 'カテゴリが見つかりません') {
          set.status = 404;
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
      beforeHandle: [authenticated, isAdmin],
      detail: {
        tags: ['categories'],
        summary: 'カテゴリの削除',
        description: 'カテゴリを削除します（管理者権限が必要）',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // 特定カテゴリの投稿を取得
  .get(
    '/:id/posts',
    async ({
      params,
      query,
      set,
      services,
    }: {
      params: { id: string };
      query: { published?: string; take?: string; skip?: string };
      set: { status: number };
      services: ServiceContainer;
    }) => {
      const categoryId = Number.parseInt(params.id, 10);
      const published =
        query.published === 'true' ? true : query.published === 'false' ? false : undefined;
      const take = Number.parseInt(query.take as string, 10) || 10;
      const skip = Number.parseInt(query.skip as string, 10) || 0;

      const result = await services.category.getPostsByCategory(categoryId, {
        published,
        take,
        skip,
      });

      if (!result.success) {
        set.status = 404;
      }

      return result;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        published: t.Optional(t.String()),
        take: t.Optional(t.String()),
        skip: t.Optional(t.String()),
      }),
      detail: {
        tags: ['categories'],
        summary: 'カテゴリに属する投稿の取得',
        description: '特定のカテゴリに属する投稿を取得します',
      },
    },
  );
