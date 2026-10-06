import { Elysia, t } from 'elysia';
import {
  InteractionError,
  interactionId,
  interactionPage,
  requireActor,
} from '../domain/interactions/policy';
import prisma from '../lib/prisma';
import { authenticated, authMiddleware, isAdmin } from '../middlewares/auth';
import { InteractionRepository } from '../repositories/interactions';

const idSchema = t.String({ pattern: '^[1-9][0-9]*$' });
const idParams = t.Object({ id: idSchema });
const postParams = t.Object({ id: idSchema });
const pageQuery = t.Object({
  take: t.Optional(t.String()),
  skip: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});
const reactionType = t.Union([
  t.Literal('like'),
  t.Literal('love'),
  t.Literal('laugh'),
  t.Literal('wow'),
  t.Literal('sad'),
]);
const contentBody = t.Object(
  { content: t.String({ minLength: 1, maxLength: 5000 }) },
  { additionalProperties: false },
);
const protectedRoute = { beforeHandle: authenticated };

/** コメント・通知・利用者操作の HTTP アダプター。テスト用リポジトリを注入できる。 */
export function createInteractionsRouter(
  repository: InteractionRepository = new InteractionRepository(prisma),
) {
  return new Elysia({ name: 'interactions' })
    .use(authMiddleware)
    .onBeforeHandle(({ set }) => {
      // 所有者専用の保留コメントや通知を共有キャッシュへ保存しない。
      set.headers['Cache-Control'] = 'private, no-store';
    })
    .onError(({ error, set, code }) => {
      if (error instanceof InteractionError) {
        set.status = error.status;
        if (error.status === 429) set.headers['Retry-After'] = '60';
        return { error: error.message };
      }
      if (code === 'VALIDATION' || code === 'PARSE' || code === 'NOT_FOUND') return;
      set.status = 500;
      return { error: 'インタラクション処理に失敗しました' };
    })
    .get('/posts/popular', ({ query }) => repository.popular(interactionPage(query)), {
      query: pageQuery,
      detail: { tags: ['interactions'], summary: '公開投稿の人気順一覧' },
    })
    .get(
      '/posts/:id/comments',
      ({ params, query, user }) =>
        repository.listComments(
          interactionId(params.id),
          query.parentId ? interactionId(query.parentId) : null,
          user,
          interactionPage(query),
        ),
      {
        params: postParams,
        query: t.Object({ ...pageQuery.properties, parentId: t.Optional(idSchema) }),
        detail: { tags: ['interactions'], summary: 'コメント・返信一覧（既定はルート）' },
      },
    )
    .post(
      '/posts/:id/comments',
      async ({ params, body, user, set }) => {
        const comment = await repository.createComment(
          requireActor(user),
          interactionId(params.id),
          body.content,
          body.parentId ?? null,
        );
        set.status = 201;
        return comment;
      },
      {
        ...protectedRoute,
        params: postParams,
        body: t.Object(
          {
            content: contentBody.properties.content,
            parentId: t.Optional(t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
          },
          { additionalProperties: false },
        ),
        detail: { tags: ['interactions'], summary: '承認待ちコメントの追加' },
      },
    )
    .get(
      '/comments/:id',
      ({ params, user }) => repository.getComment(interactionId(params.id), user),
      {
        params: idParams,
        detail: { tags: ['interactions'], summary: 'コメント詳細' },
      },
    )
    .get(
      '/comments/:id/replies',
      async ({ params, query, user }) => {
        const comment = await repository.getComment(interactionId(params.id), user);
        return repository.listComments(comment.postId, comment.id, user, interactionPage(query));
      },
      {
        params: idParams,
        query: pageQuery,
        detail: { tags: ['interactions'], summary: '返信のページ取得' },
      },
    )
    .put(
      '/comments/:id',
      ({ params, body, user }) =>
        repository.updateComment(requireActor(user), interactionId(params.id), body.content),
      {
        ...protectedRoute,
        params: idParams,
        body: contentBody,
        detail: { tags: ['interactions'], summary: 'コメント編集（再承認が必要）' },
      },
    )
    .delete(
      '/comments/:id',
      ({ params, user }) => repository.deleteComment(requireActor(user), interactionId(params.id)),
      {
        ...protectedRoute,
        params: idParams,
        detail: { tags: ['interactions'], summary: 'コメント削除（返信は保持）' },
      },
    )
    .get(
      '/moderation/comments',
      ({ user, query }) =>
        repository.moderationQueue(
          requireActor(user),
          query.status ?? 'pending',
          interactionPage(query),
        ),
      {
        beforeHandle: isAdmin,
        query: t.Object({
          ...pageQuery.properties,
          status: t.Optional(
            t.Union([t.Literal('pending'), t.Literal('approved'), t.Literal('rejected')]),
          ),
        }),
        detail: { tags: ['interactions'], summary: '管理者のコメント承認キュー' },
      },
    )
    .put(
      '/comments/:id/moderation',
      ({ params, body, user }) =>
        repository.moderateComment(
          requireActor(user),
          interactionId(params.id),
          body.status,
          body.expectedRevision,
        ),
      {
        beforeHandle: isAdmin,
        params: idParams,
        body: t.Object(
          {
            status: t.Union([t.Literal('approved'), t.Literal('rejected')]),
            expectedRevision: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          },
          { additionalProperties: false },
        ),
        detail: { tags: ['interactions'], summary: '管理者による承認・却下' },
      },
    )
    .get(
      '/posts/:id/reactions',
      ({ params, user }) =>
        repository.reactions({ kind: 'post', id: interactionId(params.id) }, user),
      {
        params: postParams,
        detail: { tags: ['interactions'], summary: '投稿のリアクション集計' },
      },
    )
    .put(
      '/posts/:id/reactions',
      ({ params, body, user }) =>
        repository.setReaction(
          requireActor(user),
          { kind: 'post', id: interactionId(params.id) },
          body.type,
          true,
        ),
      {
        ...protectedRoute,
        params: postParams,
        body: t.Object({ type: reactionType }, { additionalProperties: false }),
        detail: { tags: ['interactions'], summary: '投稿へのリアクション追加（冪等）' },
      },
    )
    .delete(
      '/posts/:id/reactions/:type',
      ({ params, user }) =>
        repository.setReaction(
          requireActor(user),
          { kind: 'post', id: interactionId(params.id) },
          params.type,
          false,
        ),
      {
        ...protectedRoute,
        params: t.Object({ id: idSchema, type: reactionType }),
        detail: { tags: ['interactions'], summary: '自分の投稿リアクションを解除' },
      },
    )
    .get(
      '/comments/:id/reactions',
      ({ params, user }) =>
        repository.reactions({ kind: 'comment', id: interactionId(params.id) }, user),
      {
        params: idParams,
        detail: { tags: ['interactions'], summary: 'コメントのリアクション集計' },
      },
    )
    .put(
      '/comments/:id/reactions',
      ({ params, body, user }) =>
        repository.setReaction(
          requireActor(user),
          { kind: 'comment', id: interactionId(params.id) },
          body.type,
          true,
        ),
      {
        ...protectedRoute,
        params: idParams,
        body: t.Object({ type: reactionType }, { additionalProperties: false }),
        detail: { tags: ['interactions'], summary: 'コメントへのリアクション追加（冪等）' },
      },
    )
    .delete(
      '/comments/:id/reactions/:type',
      ({ params, user }) =>
        repository.setReaction(
          requireActor(user),
          { kind: 'comment', id: interactionId(params.id) },
          params.type,
          false,
        ),
      {
        ...protectedRoute,
        params: t.Object({ id: idSchema, type: reactionType }),
        detail: { tags: ['interactions'], summary: '自分のコメントリアクションを解除' },
      },
    )
    .put(
      '/posts/:id/bookmark',
      ({ params, user }) =>
        repository.setBookmark(requireActor(user), interactionId(params.id), true),
      {
        ...protectedRoute,
        params: postParams,
        detail: { tags: ['interactions'], summary: '投稿をブックマーク（冪等）' },
      },
    )
    .delete(
      '/posts/:id/bookmark',
      ({ params, user }) =>
        repository.setBookmark(requireActor(user), interactionId(params.id), false),
      {
        ...protectedRoute,
        params: postParams,
        detail: { tags: ['interactions'], summary: '自分のブックマークを解除' },
      },
    )
    .get(
      '/me/bookmarks',
      ({ user, query }) => repository.bookmarks(requireActor(user), interactionPage(query)),
      {
        ...protectedRoute,
        query: pageQuery,
        detail: { tags: ['interactions'], summary: '自分のブックマーク一覧' },
      },
    )
    .put(
      '/users/:id/follow',
      ({ params, user }) =>
        repository.setFollow(requireActor(user), interactionId(params.id), true),
      {
        ...protectedRoute,
        params: idParams,
        detail: { tags: ['interactions'], summary: 'ユーザーをフォロー（冪等）' },
      },
    )
    .delete(
      '/users/:id/follow',
      ({ params, user }) =>
        repository.setFollow(requireActor(user), interactionId(params.id), false),
      {
        ...protectedRoute,
        params: idParams,
        detail: { tags: ['interactions'], summary: 'フォローを解除' },
      },
    )
    .get(
      '/me/following',
      ({ user, query }) =>
        repository.follows(requireActor(user), 'following', interactionPage(query)),
      {
        ...protectedRoute,
        query: pageQuery,
        detail: { tags: ['interactions'], summary: '自分のフォロー一覧' },
      },
    )
    .get(
      '/me/followers',
      ({ user, query }) =>
        repository.follows(requireActor(user), 'followers', interactionPage(query)),
      {
        ...protectedRoute,
        query: pageQuery,
        detail: { tags: ['interactions'], summary: '自分のフォロワー一覧' },
      },
    )
    .post(
      '/posts/:id/views',
      ({ params, user }) => repository.recordView(requireActor(user), interactionId(params.id)),
      {
        ...protectedRoute,
        params: postParams,
        detail: { tags: ['interactions'], summary: 'UTC 日付単位の重複を除外して閲覧記録' },
      },
    )
    .get('/posts/:id/interactions', ({ params }) => repository.stats(interactionId(params.id)), {
      params: postParams,
      detail: { tags: ['interactions'], summary: '公開投稿の閲覧・リアクション・コメント集計' },
    })
    .get(
      '/notifications',
      ({ user, query }) =>
        repository.notifications(
          requireActor(user),
          query.unread === 'true',
          interactionPage(query),
        ),
      {
        ...protectedRoute,
        query: t.Object({
          ...pageQuery.properties,
          unread: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
        }),
        detail: { tags: ['interactions'], summary: '自分への通知と未読件数' },
      },
    )
    .put(
      '/notifications/:id/read',
      ({ params, user }) =>
        repository.readNotification(requireActor(user), interactionId(params.id)),
      {
        ...protectedRoute,
        params: idParams,
        detail: { tags: ['interactions'], summary: '自分への通知を既読化（冪等）' },
      },
    );
}

export const interactionsRouter = createInteractionsRouter();
