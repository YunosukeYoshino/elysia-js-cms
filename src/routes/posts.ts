import { Elysia, t } from 'elysia';
import { parsePostId } from '../lib/post-search';
import { authenticated, authMiddleware } from '../middlewares/auth';
import { PostService, PostServiceError } from '../services/post-service';

const service: PostService = new PostService();

/** 一覧・カテゴリ一覧に共通の検索クエリ定義。 */
export const postSearchQuery = t.Object({
  q: t.Optional(t.String({ maxLength: 200 })),
  published: t.Optional(t.String()),
  status: t.Optional(t.String()),
  authorId: t.Optional(t.String()),
  categoryId: t.Optional(t.String()),
  categoryIds: t.Optional(t.String()),
  tagIds: t.Optional(t.String()),
  createdFrom: t.Optional(t.String()),
  createdTo: t.Optional(t.String()),
  sort: t.Optional(t.String()),
  take: t.Optional(t.String()),
  skip: t.Optional(t.String()),
});

const relatedFields = {
  published: t.Optional(t.Boolean()),
  scheduledAt: t.Optional(t.Union([t.String(), t.Null()])),
  categoryIds: t.Optional(
    t.Array(t.Integer({ minimum: 1, maximum: 2147483647 }), { maxItems: 20 }),
  ),
  tags: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 50 }), { maxItems: 20 })),
};

function postId(value: string): number {
  const id: number | null = parsePostId(value);
  if (id === null) throw new PostServiceError(422, 'Invalid post ID');
  return id;
}

/** 投稿の HTTP 入力・認証を扱い、業務処理はサービスに委譲する。 */
export const postsRouter = new Elysia({ prefix: '/posts' })
  .use(authMiddleware)
  .onError(({ error, set }) => {
    if (error instanceof PostServiceError) {
      set.status = error.status;
      return { error: error.message };
    }
  })
  .get('/', ({ query, user }) => service.list(query, user), {
    query: postSearchQuery,
    detail: {
      tags: ['posts'],
      summary: '投稿一覧・全文検索',
      description:
        'タイトル・本文を検索し、関連度・タグ・カテゴリ・UTC日付・公開状態で絞り込みます。非公開投稿は著者または管理者だけが参照できます。',
    },
  })
  .get('/:id', ({ params, user }) => service.getById(postId(params.id), user), {
    params: t.Object({ id: t.String() }),
    detail: { tags: ['posts'], summary: '投稿の詳細取得' },
  })
  .post('/', ({ body, user }) => service.create(body, user), {
    body: t.Object({ title: t.String({ minLength: 1 }), content: t.String(), ...relatedFields }),
    beforeHandle: [authenticated],
    detail: { tags: ['posts'], summary: '新規投稿の作成', security: [{ bearerAuth: [] }] },
  })
  .put('/:id', ({ params, body, user }) => service.update(postId(params.id), body, user), {
    params: t.Object({ id: t.String() }),
    body: t.Object({
      title: t.Optional(t.String({ minLength: 1 })),
      content: t.Optional(t.String()),
      ...relatedFields,
    }),
    beforeHandle: [authenticated],
    detail: { tags: ['posts'], summary: '投稿の更新', security: [{ bearerAuth: [] }] },
  })
  .delete('/:id', ({ params, user }) => service.delete(postId(params.id), user), {
    params: t.Object({ id: t.String() }),
    beforeHandle: [authenticated],
    detail: { tags: ['posts'], summary: '投稿の削除', security: [{ bearerAuth: [] }] },
  });
