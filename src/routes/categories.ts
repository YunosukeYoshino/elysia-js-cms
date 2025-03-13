import { Elysia, t } from 'elysia';
import prisma from '../lib/prisma';
import { authMiddleware, authenticated, isAdmin } from '../middlewares/auth';
import { Prisma } from '@prisma/client';

// カテゴリ関連のルーティング定義
export const categoriesRouter = new Elysia({ prefix: '/categories' })
  .use(authMiddleware)
  // 全てのカテゴリを取得
  .get(
    '/',
    async () => {
      const categories = await prisma.category.findMany({
        orderBy: {
          name: 'asc',
        },
      });

      return { data: categories };
    },
    {
      detail: {
        tags: ['categories'],
        summary: 'カテゴリ一覧の取得',
        description: '全てのカテゴリを取得します',
      },
    }
  )
  // IDでカテゴリを取得
  .get(
    '/:id',
    async ({ params, set }) => {
      const { id } = params;
      const category = await prisma.category.findUnique({
        where: { id: parseInt(id) },
      });

      if (!category) {
        set.status = 404;
        return { error: 'カテゴリが見つかりません' };
      }

      return category;
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
    }
  )
  // 新しいカテゴリを作成（管理者のみ）
  .post(
    '/',
    async ({ body, set }) => {
      const { name, slug } = body;

      // スラッグの重複チェック
      const existingCategory = await prisma.category.findUnique({
        where: { slug },
      });

      if (existingCategory) {
        set.status = 400;
        return { error: 'このスラッグは既に使用されています' };
      }

      try {
        const category = await prisma.category.create({
          data: {
            name,
            slug,
          },
        });

        set.status = 201;
        return category;
      } catch (error) {
        set.status = 400;
        return { error: 'カテゴリの作成に失敗しました', details: error };
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
    }
  )
  // カテゴリを更新（管理者のみ）
  .put(
    '/:id',
    async ({ params, body, set }) => {
      const { id } = params;
      const { name, slug } = body;

      // カテゴリの存在確認
      const category = await prisma.category.findUnique({
        where: { id: parseInt(id) },
      });

      if (!category) {
        set.status = 404;
        return { error: 'カテゴリが見つかりません' };
      }

      // スラッグが変更される場合は重複チェック
      if (slug && slug !== category.slug) {
        const existingCategory = await prisma.category.findUnique({
          where: { slug },
        });

        if (existingCategory) {
          set.status = 400;
          return { error: 'このスラッグは既に使用されています' };
        }
      }

      try {
        const updatedCategory = await prisma.category.update({
          where: { id: parseInt(id) },
          data: {
            name,
            slug,
          },
        });

        return updatedCategory;
      } catch (error) {
        set.status = 400;
        return { error: 'カテゴリの更新に失敗しました', details: error };
      }
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
    }
  )
  // カテゴリを削除（管理者のみ）
  .delete(
    '/:id',
    async ({ params, set }) => {
      const { id } = params;

      // カテゴリの存在確認
      const category = await prisma.category.findUnique({
        where: { id: parseInt(id) },
      });

      if (!category) {
        set.status = 404;
        return { error: 'カテゴリが見つかりません' };
      }

      // このカテゴリに関連付けられた投稿の確認
      const postsWithCategory = await prisma.categoryOnPost.findFirst({
        where: { categoryId: parseInt(id) },
      });

      if (postsWithCategory) {
        set.status = 400;
        return { error: 'このカテゴリは投稿に使用されているため削除できません' };
      }

      try {
        await prisma.category.delete({
          where: { id: parseInt(id) },
        });

        return { message: 'カテゴリを削除しました' };
      } catch (error) {
        set.status = 400;
        return { error: 'カテゴリの削除に失敗しました', details: error };
      }
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
    }
  )
  // 特定カテゴリの投稿を取得
  .get(
    '/:id/posts',
    async ({ params, query, set }) => {
      const { id } = params;
      const { published, take = 10, skip = 0 } = query;

      // カテゴリの存在確認
      const category = await prisma.category.findUnique({
        where: { id: parseInt(id) },
      });

      if (!category) {
        set.status = 404;
        return { error: 'カテゴリが見つかりません' };
      }

      const whereClause: Prisma.PostWhereInput = {
        categories: {
          some: {
            categoryId: parseInt(id),
          },
        },
      };

      // 公開状態でフィルタリング
      if (published !== undefined) {
        whereClause.published = published === 'true';
      }

      const [posts, total] = await Promise.all([
        prisma.post.findMany({
          where: whereClause,
          include: {
            author: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            categories: {
              include: {
                category: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: parseInt(take as string),
          skip: parseInt(skip as string),
        }),
        prisma.post.count({ where: whereClause }),
      ]);

      // カテゴリの形式を整える
      const formattedPosts = posts.map((post) => ({
        ...post,
        categories: post.categories.map((c) => c.category),
      }));

      return {
        data: formattedPosts,
        meta: {
          total,
          category,
          skip: parseInt(skip as string),
          take: parseInt(take as string),
        },
      };
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
    }
  );