import { Prisma, type PrismaClient } from '@prisma/client';
import {
  type Actor,
  commentContent,
  InteractionError,
  MAX_COMMENT_DEPTH,
  type ModerationStatus,
  type Page,
  type PageOptions,
  type ReactionType,
  requireAdmin,
  requireOwner,
} from '../domain/interactions/policy';
import type {
  BookmarkView,
  CommentView,
  FollowView,
  InteractionStats,
  NotificationView,
  PopularPost,
  ReactionSummary,
} from '../domain/interactions/views';
import { publicPostWhere } from '../lib/post-visibility';

const authorSelect = { id: true, name: true } satisfies Prisma.UserSelect;
const commentInclude = { author: { select: authorSelect } } satisfies Prisma.CommentInclude;
type CommentRecord = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;
type Transaction = Prisma.TransactionClient;
type Target = { kind: 'post' | 'comment'; id: number };

/** 公開済みの祖先だけを辿る条件。非承認の親を経由した情報流出を防ぐ。 */
export function approvedThreadWhere(depth: number = MAX_COMMENT_DEPTH): Prisma.CommentWhereInput {
  return {
    status: 'approved',
    ...(depth === 0
      ? { parentId: null }
      : {
          OR: [{ parentId: null }, { parent: { is: approvedThreadWhere(depth - 1) } }],
        }),
  };
}

/** 削除済みコメントは本文と投稿者を隠して返信の位置だけを残す。 */
function presentComment(comment: CommentRecord): CommentView {
  return {
    id: comment.id,
    revision: comment.revision,
    postId: comment.postId,
    parentId: comment.parentId,
    content: comment.deletedAt ? null : comment.content,
    author: comment.deletedAt ? null : comment.author,
    status: comment.status,
    published: comment.status === 'approved',
    deleted: comment.deletedAt !== null,
    depth: comment.depth,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function pageMeta(page: PageOptions, total: number): Page<never>['meta'] {
  return { take: page.take, skip: page.skip, total };
}

function order(page: PageOptions): Prisma.CommentOrderByWithRelationInput[] {
  const direction: Prisma.SortOrder = page.sort === 'oldest' ? 'asc' : 'desc';
  return [{ createdAt: direction }, { id: direction }];
}

/** 永続化・認可・通知を同一トランザクション内で実施するリポジトリ。 */
export class InteractionRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** SQLite の競合はロールバック後に限り再試行する。 */
  private async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt: number = 0; ; attempt++) {
      try {
        return await this.db.$transaction(operation, { maxWait: 5000, timeout: 10000 });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P1008') &&
          attempt < 2
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  }

  /** アカウントごと・操作ごとに固定一行で制限し、削除による制限回避を防ぐ。 */
  private async limit(tx: Transaction, actor: Actor, action: string, max: number): Promise<void> {
    const now: Date = this.clock();
    const key = { userId: actor.id, action };
    // 最初に書き込みを行い、同時トランザクション間の判定を直列化する。
    await tx.interactionLimit.upsert({
      where: { userId_action: key },
      create: { ...key, count: 0, resetAt: new Date(now.getTime() + 60000) },
      update: { count: { increment: 0 } },
    });
    const row = await tx.interactionLimit.findUniqueOrThrow({ where: { userId_action: key } });
    if (row.resetAt <= now) {
      await tx.interactionLimit.update({
        where: { userId_action: key },
        data: { count: 1, resetAt: new Date(now.getTime() + 60000) },
      });
    } else {
      if (row.count >= max)
        throw new InteractionError(429, '操作回数の上限です。1 分後に再試行してください');
      await tx.interactionLimit.update({
        where: { userId_action: key },
        data: { count: { increment: 1 } },
      });
    }
  }

  private async publicPost(tx: Transaction, id: number): Promise<{ id: number; authorId: number }> {
    const post = await tx.post.findFirst({
      where: { id, ...publicPostWhere(this.clock()) },
      select: { id: true, authorId: true },
    });
    if (!post) throw new InteractionError(404, '公開された投稿が見つかりません');
    return post;
  }

  private commentVisibility(actor: Actor | null): Prisma.CommentWhereInput {
    return {
      post: publicPostWhere(this.clock()),
      ...(actor?.role === 'admin'
        ? {}
        : {
            OR: [
              approvedThreadWhere(),
              ...(actor ? [{ authorId: actor.id, deletedAt: null }] : []),
            ],
          }),
    };
  }

  private async readableComment(
    tx: Transaction,
    id: number,
    actor: Actor | null,
  ): Promise<CommentRecord> {
    const comment = await tx.comment.findFirst({
      where: { id, ...this.commentVisibility(actor) },
      include: commentInclude,
    });
    if (!comment) throw new InteractionError(404, 'コメントが見つかりません');
    return comment;
  }

  private async publicComment(tx: Transaction, id: number): Promise<CommentRecord> {
    const comment = await tx.comment.findFirst({
      where: { id, deletedAt: null, post: publicPostWhere(this.clock()), ...approvedThreadWhere() },
      include: commentInclude,
    });
    if (!comment) throw new InteractionError(404, '公開されたコメントが見つかりません');
    return comment;
  }

  private async notify(
    tx: Transaction,
    data: {
      eventKey: string;
      type: string;
      content: string;
      recipientId: number;
      senderId: number;
      postId?: number;
      commentId?: number;
    },
  ): Promise<void> {
    if (data.recipientId === data.senderId) return;
    await tx.notification.upsert({
      where: { eventKey: data.eventKey },
      create: data,
      update: {},
    });
  }

  /** 投稿の直下、または指定した親の返信をページ単位で取得する。 */
  async listComments(
    postId: number,
    parentId: number | null,
    actor: Actor | null,
    page: PageOptions,
  ): Promise<Page<CommentView>> {
    return this.transaction(async (tx) => {
      await this.publicPost(tx, postId);
      if (parentId !== null) {
        const parent = await this.readableComment(tx, parentId, actor);
        if (parent.postId !== postId) throw new InteractionError(422, '返信先が別の投稿です');
      }
      const where: Prisma.CommentWhereInput = {
        postId,
        parentId,
        ...this.commentVisibility(actor),
      };
      const data = await tx.comment.findMany({
        where,
        include: commentInclude,
        orderBy: order(page),
        take: page.take,
        skip: page.skip,
      });
      return {
        data: data.map(presentComment),
        meta: pageMeta(page, await tx.comment.count({ where })),
      };
    });
  }

  /** コメント詳細を取得する。未承認の本文は所有者と管理者だけに返す。 */
  async getComment(id: number, actor: Actor | null): Promise<CommentView> {
    return this.transaction(async (tx) =>
      presentComment(await this.readableComment(tx, id, actor)),
    );
  }

  /** 管理者の承認待ちキュー。下書き投稿のコメントも確認可能。 */
  async moderationQueue(
    actor: Actor,
    status: ModerationStatus,
    page: PageOptions,
  ): Promise<Page<CommentView>> {
    requireAdmin(actor);
    const where: Prisma.CommentWhereInput = { status, deletedAt: null };
    return this.transaction(async (tx) => ({
      data: (
        await tx.comment.findMany({
          where,
          include: commentInclude,
          orderBy: order(page),
          take: page.take,
          skip: page.skip,
        })
      ).map(presentComment),
      meta: pageMeta(page, await tx.comment.count({ where })),
    }));
  }

  /** 本文は必ず承認待ちで保存し、親は同一投稿の公開済みに限定する。 */
  async createComment(
    actor: Actor,
    postId: number,
    content: string,
    parentId: number | null,
  ): Promise<CommentView> {
    const normalized: string = commentContent(content);
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'comment', 10);
      await this.publicPost(tx, postId);
      let depth: number = 0;
      if (parentId !== null) {
        const parent = await this.publicComment(tx, parentId);
        if (parent.postId !== postId) throw new InteractionError(422, '返信先が別の投稿です');
        depth = parent.depth + 1;
        if (depth > MAX_COMMENT_DEPTH) throw new InteractionError(422, '返信は最大 5 階層です');
      }
      const duplicate = await tx.comment.findFirst({
        where: {
          authorId: actor.id,
          postId,
          parentId,
          content: normalized,
          deletedAt: null,
          createdAt: { gte: new Date(this.clock().getTime() - 60000) },
        },
        select: { id: true },
      });
      if (duplicate) throw new InteractionError(409, '同じコメントが既に送信されています');
      const comment = await tx.comment.create({
        data: { content: normalized, postId, parentId, depth, authorId: actor.id },
        include: commentInclude,
      });
      return presentComment(comment);
    });
  }

  /** 内容の変更は再承認が必要。過去の通知も非公開化して本文漏洩を防ぐ。 */
  async updateComment(actor: Actor, id: number, content: string): Promise<CommentView> {
    const normalized: string = commentContent(content);
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'comment-edit', 20);
      const comment = await this.readableComment(tx, id, actor);
      requireOwner(actor, comment.authorId);
      if (comment.deletedAt) throw new InteractionError(409, '削除済みコメントは編集できません');
      if (comment.content === normalized) return presentComment(comment);
      const updated = await tx.comment.update({
        where: { id },
        data: { content: normalized, status: 'pending', revision: { increment: 1 } },
        include: commentInclude,
      });
      return presentComment(updated);
    });
  }

  /** 削除は墓石として残し、返信を巻き込まず本文・リアクション・通知を消す。 */
  async deleteComment(actor: Actor, id: number): Promise<{ deleted: true }> {
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'comment-edit', 20);
      const comment = await tx.comment.findFirst({
        where: {
          id,
          ...(actor.role === 'admin'
            ? {}
            : {
                OR: [
                  { authorId: actor.id },
                  { post: publicPostWhere(this.clock()), ...approvedThreadWhere() },
                ],
              }),
        },
      });
      if (!comment) throw new InteractionError(404, 'コメントが見つかりません');
      requireOwner(actor, comment.authorId);
      await tx.comment.update({
        where: { id },
        data: { content: '', deletedAt: comment.deletedAt ?? this.clock() },
      });
      await tx.reaction.deleteMany({ where: { commentId: id } });
      await tx.notification.deleteMany({ where: { commentId: id } });
      return { deleted: true };
    });
  }

  /** 承認・却下と受信者への通知を原子的に反映する。 */
  async moderateComment(
    actor: Actor,
    id: number,
    status: 'approved' | 'rejected',
    expectedRevision: number,
  ): Promise<CommentView> {
    requireAdmin(actor);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new InteractionError(422, '承認対象のリビジョンが必要です');
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'moderation', 100);
      const comment = await tx.comment.findUnique({ where: { id }, include: commentInclude });
      if (!comment || comment.deletedAt)
        throw new InteractionError(404, 'コメントが見つかりません');
      if (comment.revision !== expectedRevision)
        throw new InteractionError(409, 'コメントが変更されています。再確認してください');
      if (comment.status === status) return presentComment(comment);
      if (status === 'approved') {
        await this.publicPost(tx, comment.postId);
        if (comment.parentId !== null) {
          const parent = await tx.comment.findFirst({
            where: { id: comment.parentId, ...approvedThreadWhere() },
          });
          if (!parent) throw new InteractionError(409, '親コメントの承認が必要です');
        }
      }
      const changed = await tx.comment.updateMany({
        where: { id, revision: expectedRevision, deletedAt: null },
        data: { status, revision: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new InteractionError(409, 'コメントが変更されています。再確認してください');
      const updated = await tx.comment.findUniqueOrThrow({
        where: { id },
        include: commentInclude,
      });
      await this.notify(tx, {
        eventKey: `moderation:${id}:${comment.revision}:${status}`,
        type: 'moderation',
        content: status === 'approved' ? 'コメントが承認されました' : 'コメントが却下されました',
        recipientId: comment.authorId,
        senderId: actor.id,
        postId: comment.postId,
        commentId: id,
      });
      if (status === 'approved') {
        const post = await tx.post.findUniqueOrThrow({ where: { id: comment.postId } });
        await this.notify(tx, {
          eventKey: `comment:${id}:${post.authorId}`,
          type: 'comment',
          content: '投稿に新しいコメントがあります',
          recipientId: post.authorId,
          senderId: comment.authorId,
          postId: post.id,
          commentId: id,
        });
        if (comment.parentId !== null) {
          const parent = await tx.comment.findUniqueOrThrow({ where: { id: comment.parentId } });
          // 投稿者が返信先と同一でも「返信」を一件だけ送る。
          if (parent.authorId === post.authorId)
            await tx.notification.deleteMany({
              where: { eventKey: `comment:${id}:${post.authorId}` },
            });
          await this.notify(tx, {
            eventKey: `reply:${id}:${parent.authorId}`,
            type: 'reply',
            content: 'コメントに新しい返信があります',
            recipientId: parent.authorId,
            senderId: comment.authorId,
            postId: post.id,
            commentId: id,
          });
        }
      }
      return presentComment(updated);
    });
  }

  private async reactionTarget(
    tx: Transaction,
    target: Target,
  ): Promise<{ authorId: number; postId: number; commentId: number | undefined }> {
    if (target.kind === 'post') {
      const post = await this.publicPost(tx, target.id);
      return { authorId: post.authorId, postId: post.id, commentId: undefined };
    }
    const comment = await this.publicComment(tx, target.id);
    return { authorId: comment.authorId, postId: comment.postId, commentId: comment.id };
  }

  /** 一対象・一利用者・一種類に一件だけ保存し、再送で通知を増やさない。 */
  async setReaction(
    actor: Actor,
    target: Target,
    type: ReactionType,
    active: boolean,
  ): Promise<{ active: boolean }> {
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'reaction', 60);
      const where: Prisma.ReactionWhereInput = {
        userId: actor.id,
        type,
        ...(target.kind === 'post' ? { postId: target.id } : { commentId: target.id }),
      };
      if (!active) {
        await tx.reaction.deleteMany({ where });
        return { active: false };
      }
      const recipient = await this.reactionTarget(tx, target);
      const existing = await tx.reaction.findFirst({ where });
      if (!existing) {
        await tx.reaction.create({
          data: {
            userId: actor.id,
            type,
            ...(target.kind === 'post' ? { postId: target.id } : { commentId: target.id }),
          },
        });
        await this.notify(tx, {
          eventKey: `reaction:${actor.id}:${target.kind}:${target.id}:${type}`,
          type: 'reaction',
          content: '新しいリアクションがあります',
          recipientId: recipient.authorId,
          senderId: actor.id,
          postId: recipient.postId,
          commentId: recipient.commentId,
        });
      }
      return { active: true };
    });
  }

  /** 個人一覧を公開せず種類別の集計と自分の選択だけを返す。 */
  async reactions(target: Target, actor: Actor | null): Promise<ReactionSummary> {
    return this.transaction(async (tx) => {
      await this.reactionTarget(tx, target);
      const where: Prisma.ReactionWhereInput =
        target.kind === 'post' ? { postId: target.id } : { commentId: target.id };
      const groups = await tx.reaction.groupBy({
        by: ['type'],
        where,
        _count: { _all: true },
        orderBy: { type: 'asc' },
      });
      const mine = actor
        ? await tx.reaction.findMany({
            where: { ...where, userId: actor.id },
            select: { type: true },
          })
        : [];
      return {
        counts: groups.map((row) => ({ type: row.type, count: row._count._all })),
        mine: mine.map((row) => row.type),
      };
    });
  }

  /** ブックマークの内容・所有者は他ユーザーへ公開しない。 */
  async setBookmark(actor: Actor, postId: number, active: boolean): Promise<{ active: boolean }> {
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'bookmark', 60);
      if (!active) {
        await tx.bookmark.deleteMany({ where: { userId: actor.id, postId } });
        return { active: false };
      }
      await this.publicPost(tx, postId);
      await tx.bookmark.upsert({
        where: { userId_postId: { userId: actor.id, postId } },
        create: { userId: actor.id, postId },
        update: {},
      });
      return { active: true };
    });
  }

  /** 非公開に戻った投稿はブックマーク一覧からも隠す。 */
  async bookmarks(actor: Actor, page: PageOptions): Promise<Page<BookmarkView>> {
    const where: Prisma.BookmarkWhereInput = {
      userId: actor.id,
      post: publicPostWhere(this.clock()),
    };
    return this.transaction(async (tx) => ({
      data: await tx.bookmark.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          post: { select: { id: true, title: true, author: { select: authorSelect } } },
        },
        orderBy: order(page),
        take: page.take,
        skip: page.skip,
      }),
      meta: pageMeta(page, await tx.bookmark.count({ where })),
    }));
  }

  /** 自己フォローを禁止し、追加と通知を同じトランザクションで保存する。 */
  async setFollow(
    actor: Actor,
    followingId: number,
    active: boolean,
  ): Promise<{ active: boolean }> {
    if (actor.id === followingId) throw new InteractionError(422, '自分自身はフォローできません');
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'follow', 60);
      const key = { followerId: actor.id, followingId };
      if (!active) {
        await tx.follow.deleteMany({ where: key });
        return { active: false };
      }
      if (!(await tx.user.findUnique({ where: { id: followingId }, select: { id: true } }))) {
        throw new InteractionError(404, 'ユーザーが見つかりません');
      }
      await tx.follow.upsert({ where: { followerId_followingId: key }, create: key, update: {} });
      await this.notify(tx, {
        eventKey: `follow:${actor.id}:${followingId}`,
        type: 'follow',
        content: '新しいフォロワーがいます',
        recipientId: followingId,
        senderId: actor.id,
      });
      return { active: true };
    });
  }

  /** 自分のフォロー・フォロワーだけをページ単位で返す。 */
  async follows(
    actor: Actor,
    direction: 'followers' | 'following',
    page: PageOptions,
  ): Promise<Page<FollowView>> {
    const where: Prisma.FollowWhereInput =
      direction === 'following' ? { followerId: actor.id } : { followingId: actor.id };
    return this.transaction(async (tx) => {
      const rows = await tx.follow.findMany({
        where,
        include: { follower: { select: authorSelect }, following: { select: authorSelect } },
        orderBy: order(page),
        take: page.take,
        skip: page.skip,
      });
      return {
        data: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          user: direction === 'following' ? row.following : row.follower,
        })),
        meta: pageMeta(page, await tx.follow.count({ where })),
      };
    });
  }

  /** 閲覧数は認証利用者ごと・投稿ごと・UTC 日付ごとに一回。IP は保存しない。 */
  async recordView(actor: Actor, postId: number): Promise<{ views: number }> {
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'view', 60);
      await this.publicPost(tx, postId);
      const day: string = this.clock().toISOString().slice(0, 10);
      const key = { userId: actor.id, postId, day };
      await tx.postView.upsert({ where: { userId_postId_day: key }, create: key, update: {} });
      return { views: await tx.postView.count({ where: { postId } }) };
    });
  }

  /** 非公開投稿の統計は返さない。コメントは祖先の承認まで確認する。 */
  async stats(postId: number): Promise<InteractionStats> {
    return this.transaction(async (tx) => {
      await this.publicPost(tx, postId);
      return {
        views: await tx.postView.count({ where: { postId } }),
        reactions: await tx.reaction.count({ where: { postId } }),
        comments: await tx.comment.count({
          where: { postId, deletedAt: null, ...approvedThreadWhere() },
        }),
      };
    });
  }

  /** 人気順は延べユニーク日次閲覧数、次にリアクション数と ID で安定化する。 */
  async popular(page: PageOptions): Promise<Page<PopularPost>> {
    const where: Prisma.PostWhereInput = publicPostWhere(this.clock());
    return this.transaction(async (tx) => ({
      data: await tx.post.findMany({
        where,
        select: {
          id: true,
          title: true,
          author: { select: authorSelect },
          _count: { select: { views: true, reactions: true } },
        },
        orderBy: [{ views: { _count: 'desc' } }, { reactions: { _count: 'desc' } }, { id: 'desc' }],
        take: page.take,
        skip: page.skip,
      }),
      meta: pageMeta(page, await tx.post.count({ where })),
    }));
  }

  private notificationVisibility(actor: Actor): Prisma.NotificationWhereInput {
    return {
      recipientId: actor.id,
      AND: [
        { OR: [{ postId: null }, { post: publicPostWhere(this.clock()) }] },
        {
          OR: [
            { commentId: null },
            { comment: { is: { deletedAt: null, ...this.commentVisibility(actor) } } },
          ],
        },
      ],
    };
  }

  /** 通知は受信者だけが取得可能で、関連コンテンツの公開状態を毎回再確認する。 */
  async notifications(
    actor: Actor,
    unreadOnly: boolean,
    page: PageOptions,
  ): Promise<Page<NotificationView> & { unread: number }> {
    const where: Prisma.NotificationWhereInput = {
      ...this.notificationVisibility(actor),
      ...(unreadOnly ? { read: false } : {}),
    };
    return this.transaction(async (tx) => ({
      data: await tx.notification.findMany({
        where,
        select: {
          id: true,
          type: true,
          content: true,
          read: true,
          createdAt: true,
          postId: true,
          commentId: true,
          sender: { select: authorSelect },
        },
        orderBy: order(page),
        take: page.take,
        skip: page.skip,
      }),
      meta: pageMeta(page, await tx.notification.count({ where })),
      unread: await tx.notification.count({
        where: { ...this.notificationVisibility(actor), read: false },
      }),
    }));
  }

  /** 単一通知の既読変更に受信者条件を含め、ID の存在も漏らさない。 */
  async readNotification(actor: Actor, id: number): Promise<{ read: true }> {
    return this.transaction(async (tx) => {
      await this.limit(tx, actor, 'notification', 120);
      const result = await tx.notification.updateMany({
        where: { id, ...this.notificationVisibility(actor) },
        data: { read: true },
      });
      if (result.count !== 1) throw new InteractionError(404, '通知が見つかりません');
      return { read: true };
    });
  }
}
