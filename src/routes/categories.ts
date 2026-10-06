import { Elysia, t } from 'elysia';
import { CategoryService } from '../domain/services/category-service';
import prisma from '../lib/prisma';
import { authenticated, authMiddleware, isAdmin } from '../middlewares/auth';
import { domainErrorPlugin } from '../middlewares/domain-error';
import { PostService } from '../services/post-service';
import { postSearchQuery } from './posts';

const categoryParams = t.Object({
  id: t.Numeric({ minimum: 1, maximum: 2147483647, multipleOf: 1 }),
});

/** カテゴリ用コントローラー。依存するサービスを注入して構成する。 */
export const createCategoriesRouter = (
  service: CategoryService = new CategoryService(prisma),
  posts: PostService = new PostService(prisma),
) =>
  new Elysia({ name: 'cms.category-routes', prefix: '/categories' })
    .use(domainErrorPlugin)
    .use(authMiddleware)
    .get('/', async () => ({ data: await service.list() }), {
      detail: { tags: ['categories'], summary: 'カテゴリ一覧の取得' },
    })
    .get('/:id', ({ params }) => service.getById(params.id), {
      params: categoryParams,
      detail: { tags: ['categories'], summary: 'カテゴリの詳細取得' },
    })
    .post(
      '/',
      async ({ body, set }) => {
        const category = await service.create(body);
        set.status = 201;
        return category;
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
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .put('/:id', ({ params, body }) => service.update(params.id, body), {
      params: categoryParams,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        slug: t.Optional(t.String({ minLength: 1, pattern: '^[a-z0-9-]+$' })),
      }),
      beforeHandle: [authenticated, isAdmin],
      detail: { tags: ['categories'], summary: 'カテゴリの更新', security: [{ bearerAuth: [] }] },
    })
    .delete('/:id', ({ params }) => service.delete(params.id), {
      params: categoryParams,
      beforeHandle: [authenticated, isAdmin],
      detail: { tags: ['categories'], summary: 'カテゴリの削除', security: [{ bearerAuth: [] }] },
    })
    .get(
      '/:id/posts',
      async ({ params, query, user }) => {
        const category = await service.getById(params.id);
        const result = await posts.list({ ...query, categoryId: String(params.id) }, user);
        return { data: result.data, meta: { ...result.meta, category } };
      },
      {
        params: categoryParams,
        query: postSearchQuery,
        detail: { tags: ['categories'], summary: 'カテゴリに属する投稿の取得' },
      },
    );

export const categoriesRouter = createCategoriesRouter();
