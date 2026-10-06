import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import {
  type Actor,
  InteractionError,
  interactionId,
  interactionPage,
} from '../domain/interactions/policy';
import { getJwtSecret } from '../lib/jwt-config';
import prisma from '../lib/prisma';
import { InteractionRepository } from '../repositories/interactions';
import { createInteractionsRouter } from '../routes/interactions';

interface CommentBody {
  id: number;
  revision: number;
  content: string | null;
  status: string;
  published: boolean;
  author: { id: number; name: string | null } | null;
  deleted: boolean;
}
interface ListBody<T> {
  data: T[];
  meta: { total: number; take: number; skip: number };
  unread?: number;
}
interface NotificationBody {
  id: number;
  type: string;
  read: boolean;
  content: string;
  sender: { id: number; name: string | null };
}

const page = { take: 20, skip: 0, sort: 'newest' } as const;
let now: Date = new Date('2026-10-06T12:00:00Z');
const repository = new InteractionRepository(prisma, () => now);
const app = new Elysia().group('/api', (app) => app.use(createInteractionsRouter(repository)));
const ids: number[] = [];
let owner: Actor;
let commenter: Actor;
let other: Actor;
let admin: Actor;
let postId: number;
let draftId: number;
let secondPostId: number;
const tokens: Map<number, string> = new Map();

async function request(
  path: string,
  method: string = 'GET',
  actor: Actor | null = null,
  body?: object,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${tokens.get(actor.id)}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function createApproved(author: Actor = commenter, parentId: number | null = null) {
  const comment = await repository.createComment(
    author,
    postId,
    `comment-${crypto.randomUUID()}`,
    parentId,
  );
  await repository.moderateComment(
    admin,
    comment.id,
    'approved',
    (await repository.getComment(comment.id, admin)).revision,
  );
  return repository.getComment(comment.id, admin);
}

beforeAll(async () => {
  await import('../scripts/prepare-db').then((m) => m.default('test'));
});
beforeEach(async () => {
  now = new Date('2026-10-06T12:00:00Z');
  const users: Actor[] = [];
  for (const role of ['user', 'user', 'user', 'admin']) {
    const user = await prisma.user.create({
      data: {
        name: `Public ${role}`,
        email: `interactions-${crypto.randomUUID()}@example.com`,
        password: 'private-fixture',
        passwordResetToken: `private-${crypto.randomUUID()}`,
        role,
      },
    });
    ids.push(user.id);
    users.push({ id: user.id, role });
    tokens.set(
      user.id,
      await jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
        userId: user.id,
        type: 'access',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }
  [owner, commenter, other, admin] = users;
  const post = await prisma.post.create({
    data: { title: 'Public', content: 'content', published: true, authorId: owner.id },
  });
  postId = post.id;
  draftId = (
    await prisma.post.create({
      data: { title: 'Private', content: 'secret draft', authorId: owner.id },
    })
  ).id;
  secondPostId = (
    await prisma.post.create({
      data: { title: 'Other', content: 'content', published: true, authorId: owner.id },
    })
  ).id;
});
afterAll(async () => {
  await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe('interaction HTTP authorization and moderation', () => {
  it('requires authentication for every mutation and private list', async () => {
    for (const [path, method, body] of [
      [`/posts/${postId}/comments`, 'POST', { content: 'no' }],
      ['/comments/1', 'PUT', { content: 'no' }],
      ['/comments/1', 'DELETE', undefined],
      ['/comments/1/moderation', 'PUT', { status: 'approved', expectedRevision: 1 }],
      [`/posts/${postId}/reactions`, 'PUT', { type: 'like' }],
      ['/comments/1/reactions', 'PUT', { type: 'like' }],
      [`/posts/${postId}/reactions/like`, 'DELETE', undefined],
      ['/comments/1/reactions/like', 'DELETE', undefined],
      [`/posts/${postId}/bookmark`, 'PUT', undefined],
      [`/posts/${postId}/bookmark`, 'DELETE', undefined],
      [`/posts/${postId}/views`, 'POST', undefined],
      [`/users/${owner.id}/follow`, 'PUT', undefined],
      [`/users/${owner.id}/follow`, 'DELETE', undefined],
      ['/notifications/1/read', 'PUT', undefined],
      ['/notifications', 'GET', undefined],
      ['/moderation/comments', 'GET', undefined],
      ['/me/bookmarks', 'GET', undefined],
      ['/me/followers', 'GET', undefined],
      ['/me/following', 'GET', undefined],
    ] as const)
      expect((await request(path, method, null, body)).status).toBe(401);
  });

  it('keeps pending comments private, moderates as admin, and never exposes credentials', async () => {
    const created = await request(`/posts/${postId}/comments`, 'POST', commenter, {
      content: '  pending content  ',
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('private, no-store');
    const comment: CommentBody = await created.json();
    expect(comment.status).toBe('pending');
    expect(comment.content).toBe('pending content');
    expect(comment.published).toBe(false);
    expect((await request(`/comments/${comment.id}`)).status).toBe(404);
    expect((await request(`/comments/${comment.id}`, 'GET', other)).status).toBe(404);
    expect((await request(`/comments/${comment.id}`, 'DELETE', other)).status).toBe(404);
    expect((await request(`/comments/${comment.id}`, 'GET', commenter)).status).toBe(200);
    const publicList: ListBody<CommentBody> = await (
      await request(`/posts/${postId}/comments`)
    ).json();
    expect(publicList.meta.total).toBe(0);
    expect(await prisma.notification.count({ where: { commentId: comment.id } })).toBe(0);
    expect(
      (
        await request(`/comments/${comment.id}/moderation`, 'PUT', owner, {
          status: 'approved',
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
    const queue: ListBody<CommentBody> = await (
      await request('/moderation/comments', 'GET', admin)
    ).json();
    expect(queue.data.some((row) => row.id === comment.id)).toBe(true);
    expect(
      (
        await request(`/comments/${comment.id}/moderation`, 'PUT', admin, {
          status: 'approved',
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    const approved: CommentBody = await (await request(`/comments/${comment.id}`)).json();
    expect(approved.published).toBe(true);
    expect(Object.keys(approved.author ?? {}).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(approved)).not.toMatch(/email|password|ResetToken/);
    const count: number = await prisma.notification.count({ where: { commentId: comment.id } });
    await repository.moderateComment(
      admin,
      comment.id,
      'approved',
      (await repository.getComment(comment.id, admin)).revision,
    );
    expect(await prisma.notification.count({ where: { commentId: comment.id } })).toBe(count);
    expect(
      (await request(`/comments/${comment.id}`, 'PUT', other, { content: 'stolen' })).status,
    ).toBe(403);
    expect((await request(`/comments/${comment.id}`, 'DELETE', other)).status).toBe(403);
    expect(
      (await request(`/comments/${comment.id}`, 'PUT', commenter, { content: 'edited' })).status,
    ).toBe(200);
    expect((await request(`/comments/${comment.id}`)).status).toBe(404);
    const ownerNotifications = await repository.notifications(owner, false, page);
    expect(ownerNotifications.data.some((n) => n.commentId === comment.id)).toBe(false);
    await repository.moderateComment(
      admin,
      comment.id,
      'rejected',
      (await repository.getComment(comment.id, admin)).revision,
    );
    expect((await repository.getComment(comment.id, commenter)).status).toBe('rejected');
  });

  it('rejects stale moderation after edits and concurrent decisions', async () => {
    const comment = await repository.createComment(commenter, postId, 'reviewed benign text', null);
    const edit = await repository.updateComment(commenter, comment.id, 'unreviewed replacement');
    expect(edit.revision).toBeGreaterThan(comment.revision);
    const stale = await request(`/comments/${comment.id}/moderation`, 'PUT', admin, {
      status: 'approved',
      expectedRevision: comment.revision,
    });
    expect(stale.status).toBe(409);
    expect((await repository.getComment(comment.id, admin)).status).toBe('pending');
    expect((await request(`/comments/${comment.id}`)).status).toBe(404);
    expect(
      (await request(`/comments/${comment.id}/moderation`, 'PUT', admin, { status: 'approved' }))
        .status,
    ).toBe(422);
    const results = await Promise.allSettled([
      repository.moderateComment(admin, comment.id, 'approved', edit.revision),
      repository.moderateComment(admin, comment.id, 'rejected', edit.revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ status: 409 });
    const current = await repository.getComment(comment.id, admin);
    expect(current.revision).toBe(edit.revision + 1);
    const status = current.status === 'approved' ? 'approved' : 'rejected';
    const before = await prisma.notification.count({ where: { commentId: comment.id } });
    await repository.moderateComment(admin, comment.id, status, current.revision);
    expect(await prisma.notification.count({ where: { commentId: comment.id } })).toBe(before);
  });

  it('preserves malformed JSON client errors', async () => {
    const response = await app.handle(
      new Request(`http://localhost/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.get(commenter.id)}`,
        },
        body: '{bad json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('validates content, IDs, parent ownership and refuses automatic approval', async () => {
    for (const content of ['', '   ', 'x'.repeat(5001)]) {
      expect(
        (await request(`/posts/${postId}/comments`, 'POST', commenter, { content })).status,
      ).toBe(422);
    }
    const attemptedOverride: CommentBody = await (
      await request(`/posts/${postId}/comments`, 'POST', commenter, {
        content: 'bypass',
        status: 'approved',
        authorId: owner.id,
      })
    ).json();
    expect(attemptedOverride.status).toBe('pending');
    expect(attemptedOverride.author?.id).toBe(commenter.id);
    for (const id of ['0', '-1', '1abc', '9007199254740992'])
      expect((await request(`/comments/${id}`)).status).toBe(422);
    const pending = await repository.createComment(commenter, postId, 'not approved', null);
    await expect(
      repository.createComment(other, postId, 'reply', pending.id),
    ).rejects.toBeInstanceOf(InteractionError);
    await repository.moderateComment(
      admin,
      pending.id,
      'approved',
      (await repository.getComment(pending.id, admin)).revision,
    );
    await expect(
      repository.createComment(other, secondPostId, 'wrong post', pending.id),
    ).rejects.toBeInstanceOf(InteractionError);
    await expect(
      repository.createComment(commenter, postId, 'not approved', null),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('paginates roots and replies, enforces depth, and preserves replies under a deleted parent', async () => {
    const root = await createApproved();
    const reply = await createApproved(other, root.id);
    const roots = await repository.listComments(postId, null, null, page);
    expect(roots.data.map((row) => row.id)).toEqual([root.id]);
    const response: ListBody<CommentBody> = await (
      await request(`/comments/${root.id}/replies`)
    ).json();
    expect(response.data.map((row) => row.id)).toEqual([reply.id]);
    let parentId: number = reply.id;
    for (let depth: number = 2; depth <= 5; depth++)
      parentId = (await createApproved(other, parentId)).id;
    await expect(
      repository.createComment(other, postId, 'too deep', parentId),
    ).rejects.toMatchObject({ status: 422 });
    await repository.deleteComment(commenter, root.id);
    const deleted = await repository.getComment(root.id, null);
    expect(deleted).toMatchObject({ deleted: true, content: null, author: null });
    expect((await repository.listComments(postId, root.id, null, page)).data[0].id).toBe(reply.id);
    await expect(repository.updateComment(commenter, root.id, 'resurrect')).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      repository.setReaction(other, { kind: 'comment', id: root.id }, 'like', true),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('hides approved descendants when an ancestor becomes pending or rejected', async () => {
    const root = await createApproved(commenter);
    const reply = await createApproved(other, root.id);
    await repository.setReaction(owner, { kind: 'comment', id: reply.id }, 'love', true);
    await repository.updateComment(commenter, root.id, 'changed root');
    expect((await request(`/comments/${reply.id}`)).status).toBe(404);
    expect((await request(`/comments/${reply.id}/reactions`)).status).toBe(404);
    expect((await repository.stats(postId)).comments).toBe(0);
    expect(
      (await repository.notifications(commenter, false, page)).data.some((n) => n.type === 'reply'),
    ).toBe(false);
    await repository.moderateComment(
      admin,
      root.id,
      'approved',
      (await repository.getComment(root.id, admin)).revision,
    );
    expect((await request(`/comments/${reply.id}`)).status).toBe(200);
  });

  it('uses deterministic pagination and rejects unbounded queries', async () => {
    const first = await createApproved();
    const second = await createApproved();
    await prisma.comment.updateMany({
      where: { postId },
      data: { createdAt: new Date('2020-01-01') },
    });
    expect(
      (await repository.listComments(postId, null, null, { ...page, take: 1, sort: 'oldest' }))
        .data[0].id,
    ).toBe(first.id);
    expect(
      (
        await repository.listComments(postId, null, null, {
          ...page,
          take: 1,
          skip: 1,
          sort: 'oldest',
        })
      ).data[0].id,
    ).toBe(second.id);
    expect(
      (await repository.listComments(postId, null, null, { ...page, take: 1 })).data[0].id,
    ).toBe(second.id);
    for (const query of [
      'take=0',
      'take=-1',
      'take=51',
      'skip=10001',
      'skip=-1',
      'take=1e2',
      'sort=invalid',
    ]) {
      expect((await request(`/posts/${postId}/comments?${query}`)).status).toBe(422);
      expect((await request(`/notifications?${query}`, 'GET', commenter)).status).toBe(422);
    }
  });
});

describe('persisted interactions and notifications', () => {
  it('deduplicates reactions, hides identities, supports removal and comment targets', async () => {
    for (let attempt: number = 0; attempt < 2; attempt++) {
      expect(
        (await request(`/posts/${postId}/reactions`, 'PUT', commenter, { type: 'like' })).status,
      ).toBe(200);
    }
    const summary = await repository.reactions({ kind: 'post', id: postId }, commenter);
    expect(summary).toEqual({ counts: [{ type: 'like', count: 1 }], mine: ['like'] });
    expect((await repository.reactions({ kind: 'post', id: postId }, other)).mine).toEqual([]);
    expect(
      await prisma.notification.count({ where: { recipientId: owner.id, type: 'reaction' } }),
    ).toBe(1);
    expect(
      (await request(`/posts/${postId}/reactions`, 'PUT', commenter, { type: 'unsupported' }))
        .status,
    ).toBe(422);
    await repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', false);
    expect((await repository.reactions({ kind: 'post', id: postId }, commenter)).counts).toEqual(
      [],
    );
    await repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', true);
    expect(
      await prisma.notification.count({ where: { recipientId: owner.id, type: 'reaction' } }),
    ).toBe(1);
    const comment = await createApproved();
    await repository.setReaction(other, { kind: 'comment', id: comment.id }, 'love', true);
    expect((await repository.reactions({ kind: 'comment', id: comment.id }, other)).mine).toEqual([
      'love',
    ]);
    await repository.deleteComment(commenter, comment.id);
    expect(await prisma.reaction.count({ where: { commentId: comment.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('keeps bookmarks and social lists private and deduplicates follows', async () => {
    await repository.setBookmark(commenter, postId, true);
    await repository.setBookmark(commenter, postId, true);
    expect((await repository.bookmarks(commenter, page)).meta.total).toBe(1);
    expect((await repository.bookmarks(other, page)).meta.total).toBe(0);
    await repository.setFollow(commenter, owner.id, true);
    await repository.setFollow(commenter, owner.id, true);
    expect((await repository.follows(commenter, 'following', page)).data[0].user.id).toBe(owner.id);
    expect((await repository.follows(owner, 'followers', page)).data[0].user.id).toBe(commenter.id);
    expect((await repository.follows(other, 'following', page)).data).toEqual([]);
    expect(
      await prisma.notification.count({ where: { recipientId: owner.id, type: 'follow' } }),
    ).toBe(1);
    await expect(repository.setFollow(owner, owner.id, true)).rejects.toMatchObject({
      status: 422,
    });
    await repository.setFollow(commenter, owner.id, false);
    expect((await repository.follows(commenter, 'following', page)).meta.total).toBe(0);
    await repository.setBookmark(commenter, postId, false);
    expect((await repository.bookmarks(commenter, page)).meta.total).toBe(0);
  });

  it('persists comment/reply/moderation notifications with recipient-only read ownership', async () => {
    const root = await createApproved(commenter);
    const reply = await createApproved(other, root.id);
    const commenterNotifications = await repository.notifications(commenter, false, page);
    expect(commenterNotifications.data.map((n) => n.type).sort()).toEqual(['moderation', 'reply']);
    const replyNotification = commenterNotifications.data.find((n) => n.type === 'reply');
    expect(replyNotification?.commentId).toBe(reply.id);
    if (!replyNotification) throw new Error('missing reply notification');
    expect(
      (await request(`/notifications/${replyNotification.id}/read`, 'PUT', other)).status,
    ).toBe(404);
    expect(
      (await request(`/notifications/${replyNotification.id}/read`, 'PUT', commenter)).status,
    ).toBe(200);
    expect(
      (await request(`/notifications/${replyNotification.id}/read`, 'PUT', commenter)).status,
    ).toBe(200);
    const unread: ListBody<NotificationBody> = await (
      await request('/notifications?unread=true', 'GET', commenter)
    ).json();
    expect(unread.data.every((n) => !n.read)).toBe(true);
    expect(unread.unread).toBe(1);
    expect(JSON.stringify(unread)).not.toMatch(/email|password|eventKey|recipientId/);
    expect((await repository.notifications(admin, false, page)).meta.total).toBe(0);
    const own = await createApproved(owner);
    expect(
      await prisma.notification.count({
        where: { commentId: own.id, recipientId: owner.id, type: 'comment' },
      }),
    ).toBe(0);
  });

  it('deduplicates views by account and UTC day and ranks only public posts', async () => {
    expect(await repository.recordView(commenter, postId)).toEqual({ views: 1 });
    expect(await repository.recordView(commenter, postId)).toEqual({ views: 1 });
    expect(await repository.recordView(other, postId)).toEqual({ views: 2 });
    now = new Date('2026-10-07T00:00:00Z');
    expect(await repository.recordView(commenter, postId)).toEqual({ views: 3 });
    await repository.recordView(commenter, secondPostId);
    const popular = await repository.popular(page);
    expect(popular.data.findIndex((p) => p.id === postId)).toBeLessThan(
      popular.data.findIndex((p) => p.id === secondPostId),
    );
    expect(popular.data.some((p) => p.id === draftId)).toBe(false);
    expect((await request('/posts/popular')).status).toBe(200);
    expect((await repository.stats(postId)).views).toBe(3);
  });

  it('enforces public-content visibility across comments, stats, bookmarks and notifications', async () => {
    const comment = await createApproved();
    await repository.setBookmark(commenter, postId, true);
    await repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', true);
    await prisma.post.update({ where: { id: postId }, data: { published: false } });
    for (const actor of [null, owner, commenter, admin]) {
      for (const path of [
        `/posts/${postId}/comments`,
        `/comments/${comment.id}`,
        `/posts/${postId}/interactions`,
        `/posts/${postId}/reactions`,
      ]) {
        expect((await request(path, 'GET', actor)).status).toBe(404);
      }
    }
    await expect(
      repository.createComment(owner, draftId, 'draft comment', null),
    ).rejects.toMatchObject({ status: 404 });
    await expect(repository.recordView(owner, draftId)).rejects.toMatchObject({ status: 404 });
    await expect(repository.setBookmark(owner, draftId, true)).rejects.toMatchObject({
      status: 404,
    });
    expect((await repository.bookmarks(commenter, page)).data).toEqual([]);
    expect((await repository.notifications(owner, false, page)).data).toEqual([]);
    await repository.deleteComment(commenter, comment.id);
    await repository.setBookmark(commenter, postId, false);
    await repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', false);
    expect(await prisma.reaction.count({ where: { postId } })).toBe(0);
  });

  it('honors due scheduled posts and hides future schedules', async () => {
    await prisma.post.update({
      where: { id: draftId },
      data: { scheduledAt: new Date('2026-10-07') },
    });
    await expect(repository.recordView(commenter, draftId)).rejects.toMatchObject({ status: 404 });
    now = new Date('2026-10-07');
    expect(await repository.recordView(commenter, draftId)).toEqual({ views: 1 });
  });

  it('limits persisted comment writes across repository instances and resets after one minute', async () => {
    for (let i: number = 0; i < 10; i++)
      await repository.createComment(commenter, postId, `limited ${i}`, null);
    const secondRepository = new InteractionRepository(prisma, () => now);
    await expect(
      secondRepository.createComment(commenter, postId, 'overflow', null),
    ).rejects.toMatchObject({ status: 429 });
    const response = await request(`/posts/${postId}/comments`, 'POST', commenter, {
      content: 'overflow',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    now = new Date(now.getTime() + 60001);
    expect(
      (await secondRepository.createComment(commenter, postId, 'after reset', null)).status,
    ).toBe('pending');
  });

  it('rolls back reaction and follow mutations if notification persistence fails', async () => {
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER interaction_notification_failure BEFORE INSERT ON Notification BEGIN SELECT RAISE(ABORT, 'fixture notification failure'); END",
    );
    try {
      const response = await request(`/posts/${postId}/reactions`, 'PUT', commenter, {
        type: 'like',
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('fixture');
      expect(await prisma.reaction.count({ where: { postId } })).toBe(0);
      await expect(repository.setFollow(commenter, owner.id, true)).rejects.toThrow();
      expect(await prisma.follow.count({ where: { followerId: commenter.id } })).toBe(0);
      const pending = await repository.createComment(commenter, postId, 'atomic moderation', null);
      await expect(
        repository.moderateComment(
          admin,
          pending.id,
          'approved',
          (await repository.getComment(pending.id, admin)).revision,
        ),
      ).rejects.toThrow();
      expect((await prisma.comment.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
        'pending',
      );
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER interaction_notification_failure');
    }
  });

  it('deduplicates concurrent view and reaction retries without losing notifications', async () => {
    await Promise.all(Array.from({ length: 6 }, () => repository.recordView(commenter, postId)));
    expect((await repository.stats(postId)).views).toBe(1);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', true),
      ),
    );
    expect((await repository.reactions({ kind: 'post', id: postId }, commenter)).counts).toEqual([
      { type: 'like', count: 1 },
    ]);
    expect(
      await prisma.notification.count({ where: { recipientId: owner.id, type: 'reaction' } }),
    ).toBe(1);
  });

  it('enforces DB uniqueness for nullable reaction targets and cascades post deletion', async () => {
    await repository.setReaction(commenter, { kind: 'post', id: postId }, 'like', true);
    await expect(
      Promise.resolve(
        prisma.reaction.create({ data: { userId: commenter.id, postId, type: 'like' } }),
      ),
    ).rejects.toThrow();
    const comment = await createApproved();
    await repository.setReaction(other, { kind: 'comment', id: comment.id }, 'love', true);
    await expect(
      Promise.resolve(
        prisma.reaction.create({ data: { userId: other.id, commentId: comment.id, type: 'love' } }),
      ),
    ).rejects.toThrow();
    await repository.setBookmark(commenter, postId, true);
    await repository.recordView(commenter, postId);
    await prisma.post.delete({ where: { id: postId } });
    expect(await prisma.comment.count({ where: { postId } })).toBe(0);
    expect(await prisma.reaction.count({ where: { commentId: comment.id } })).toBe(0);
    expect(await prisma.bookmark.count({ where: { postId } })).toBe(0);
    expect(await prisma.postView.count({ where: { postId } })).toBe(0);
    expect(await prisma.notification.count({ where: { postId } })).toBe(0);
  });
});

it('validates standalone policy boundaries without framework dependencies', () => {
  expect(interactionId('1')).toBe(1);
  for (const value of ['1e2', '01', '1 ', '9007199254740992'])
    expect(() => interactionId(value)).toThrow();
  expect(interactionPage({})).toEqual(page);
  expect(() => interactionPage({ take: '10000000000000000000' })).toThrow();
});
