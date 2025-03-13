import { Elysia, t } from 'elysia';
import prisma from '../lib/prisma';
import { authMiddleware, authenticated } from '../middlewares/auth';
import { Prisma } from '@prisma/client';

// 投稿関連のルーティング定義
export const postsRouter = new Elysia({ prefix: '/posts' })
  .use(authMiddleware)
  // 全ての投稿を取得
  .get(
    '/',
    async ({ query }) => {
      const { published, authorId, categoryId, take = 10, skip = 0 } = query;
      
      const whereClause: Prisma.PostWhereInput = {};
      
      // 公開状態でフィルタリング
      if (published !== undefined) {
        whereClause.published = published === 'true';
      }
      
      // 著者IDでフィルタリング
      if (authorId) {
        whereClause.authorId = parseInt(authorId as string);
      }
      
      // カテゴリIDでフィルタリング
      if (categoryId) {
        whereClause.categories = {
          some: {
            categoryId: parseInt(categoryId as string),
          },
        };
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
          skip: parseInt(skip as string),
          take: parseInt(take as string),
        },
      };
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
    }
  )
  // IDで投稿を取得
  .get(
    '/:id',
    async ({ params, set }) => {
      const { id } = params;
      const post = await prisma.post.findUnique({
        where: { id: parseInt(id) },
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
      });

      if (!post) {
        set.status = 404;
        return { error: '投稿が見つかりません' };
      }

      // カテゴリの形式を整える
      return {
        ...post,
        categories: post.categories.map((c) => c.category),
      };
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
    }
  )
  // 新しい投稿を作成
  .post(
    '/',
    async ({ body, user, set }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const { title, content, published = false, categoryIds = [] } = body;

      try {
        const post = await prisma.post.create({
          data: {
            title,
            content,
            published,
            authorId: user.id,
            categories: {
              create: categoryIds.map((categoryId: number) => ({
                category: {
                  connect: {
                    id: categoryId,
                  },
                },
              })),
            },
          },
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
        });

        // カテゴリの形式を整える
        return {
          ...post,
          categories: post.categories.map((c) => c.category),
        };
      } catch (error) {
        set.status = 400;
        return { error: '投稿の作成に失敗しました', details: error };
      }
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
    }
  )
  // 投稿を更新
  .put(
    '/:id',
    async ({ params, body, user, set }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const { id } = params;
      const { title, content, published, categoryIds } = body;

      // 投稿の存在確認
      const post = await prisma.post.findUnique({
        where: { id: parseInt(id) },
      });

      if (!post) {
        set.status = 404;
        return { error: '投稿が見つかりません' };
      }

      // 権限チェック（管理者または投稿の作成者のみ更新可能）
      if (post.authorId !== user.id && user.role !== 'admin') {
        set.status = 403;
        return { error: 'この操作を行う権限がありません' };
      }

      try {
        // トランザクション内で更新処理
        const updatedPost = await prisma.$transaction(async (tx) => {
          // 既存のカテゴリ関連を削除（もしカテゴリIDが提供されている場合）
          if (categoryIds) {
            await tx.categoryOnPost.deleteMany({
              where: { postId: parseInt(id) },
            });
          }

          // 投稿を更新
          const updated = await tx.post.update({
            where: { id: parseInt(id) },
            data: {
              title,
              content,
              published,
              // カテゴリIDが提供されている場合は新たな関連を作成
              ...(categoryIds && {
                categories: {
                  create: categoryIds.map((categoryId: number) => ({
                    category: {
                      connect: {
                        id: categoryId,
                      },
                    },
                  })),
                },
              }),
            },
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
          });

          return updated;
        });

        // カテゴリの形式を整える
        return {
          ...updatedPost,
          categories: updatedPost.categories.map((c) => c.category),
        };
      } catch (error) {
        set.status = 400;
        return { error: '投稿の更新に失敗しました', details: error };
      }
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
    }
  )
  // 投稿を削除
  .delete(
    '/:id',
    async ({ params, user, set }) => {
      // 認証チェック
      if (!user) {
        set.status = 401;
        return { error: '認証が必要です' };
      }

      const { id } = params;

      // 投稿の存在確認
      const post = await prisma.post.findUnique({
        where: { id: parseInt(id) },
      });

      if (!post) {
        set.status = 404;
        return { error: '投稿が見つかりません' };
      }

      // 権限チェック（管理者または投稿の作成者のみ削除可能）
      if (post.authorId !== user.id && user.role !== 'admin') {
        set.status = 403;
        return { error: 'この操作を行う権限がありません' };
      }

      try {
        // トランザクション内で削除処理
        await prisma.$transaction(async (tx) => {
          // 関連するカテゴリ関連を削除
          await tx.categoryOnPost.deleteMany({
            where: { postId: parseInt(id) },
          });

          // 投稿を削除
          await tx.post.delete({
            where: { id: parseInt(id) },
          });
        });

        return { message: '投稿を削除しました' };
      } catch (error) {
        set.status = 400;
        return { error: '投稿の削除に失敗しました', details: error };
      }
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
    }
  );