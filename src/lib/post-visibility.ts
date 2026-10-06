import type { Prisma } from '@prisma/client';

/** 投稿の有効な公開状態。予約日時に達すると読み取り時に公開扱いとなる。 */
export type PostStatus = 'draft' | 'published' | 'scheduled';

/** 投稿の参照権限の判定に必要な利用者情報。 */
export interface PostViewer {
  id: number;
  role: string;
}

/** 現時点で一般公開されている投稿の条件を返す。 */
export function publicPostWhere(now: Date = new Date()): Prisma.PostWhereInput {
  return { OR: [{ published: true }, { scheduledAt: { lte: now } }] };
}

/** 公開投稿に加え、本人の非公開投稿（管理者は全投稿）を許可する。 */
export function visiblePostWhere(
  user: PostViewer | null,
  now: Date = new Date(),
): Prisma.PostWhereInput {
  if (user?.role === 'admin') return {};
  return user ? { OR: [publicPostWhere(now), { authorId: user.id }] } : publicPostWhere(now);
}

/** 保存済みの公開設定から、指定時点の状態を計算する。 */
export function postStatus(
  post: { published: boolean; scheduledAt: Date | null },
  now: Date = new Date(),
): PostStatus {
  if (post.published || (post.scheduledAt !== null && post.scheduledAt <= now)) return 'published';
  return post.scheduledAt === null ? 'draft' : 'scheduled';
}
