/** インタラクションの認証主体。メール等の非公開情報を含めない。 */
export interface Actor {
  id: number;
  role: string;
}

/** HTTP 層が安全に返せる業務エラー。 */
export class InteractionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_COMMENT_DEPTH: number = 5;
export const REACTION_TYPES = ['like', 'love', 'laugh', 'wow', 'sad'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export interface PageOptions {
  take: number;
  skip: number;
  sort: 'newest' | 'oldest';
}
export interface Page<T> {
  data: T[];
  meta: { take: number; skip: number; total: number };
}

/** 認証を確認する。 */
export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new InteractionError(401, '認証が必要です');
  return actor;
}

/** 管理者権限を確認する。 */
export function requireAdmin(actor: Actor | null): Actor {
  const user: Actor = requireActor(actor);
  if (user.role !== 'admin') throw new InteractionError(403, '管理者権限が必要です');
  return user;
}

/** 所有者または管理者のみ変更できる。 */
export function requireOwner(actor: Actor, authorId: number): void {
  if (actor.id !== authorId && actor.role !== 'admin') {
    throw new InteractionError(403, 'この操作を行う権限がありません');
  }
}

/** ID の部分一致や整数オーバーフローを拒否する。 */
export function interactionId(value: string): number {
  const id: number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new InteractionError(422, 'ID は正の整数で指定してください');
  }
  return id;
}

/** 新しい一覧 API は負数、巨大な OFFSET、無制限取得を許可しない。 */
export function interactionPage(query: {
  take?: string;
  skip?: string;
  sort?: string;
}): PageOptions {
  const take: number = Number(query.take ?? '20');
  const skip: number = Number(query.skip ?? '0');
  const sort: string = query.sort ?? 'newest';
  if (
    !/^[0-9]+$/.test(query.take ?? '20') ||
    !/^[0-9]+$/.test(query.skip ?? '0') ||
    !Number.isSafeInteger(take) ||
    take < 1 ||
    take > 50 ||
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    skip > 10000 ||
    (sort !== 'newest' && sort !== 'oldest')
  )
    throw new InteractionError(422, 'take は 1〜50、skip は 0〜10000、sort は newest/oldest です');
  return { take, skip, sort };
}

/** コメント本文を正規化し、空白のみ・巨大な本文を拒否する。 */
export function commentContent(value: string): string {
  const content: string = value.trim();
  if (!content || content.length > 5000) {
    throw new InteractionError(422, 'コメントは 1〜5000 文字で入力してください');
  }
  return content;
}
