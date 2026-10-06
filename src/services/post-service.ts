import { Prisma, type PrismaClient } from '@prisma/client';
import { DomainError } from '../domain/errors/domain-error';
import {
  containsControlCharacters,
  formatPost,
  type PostSearchInput,
  parsePostDate,
  parsePostSearch,
  postInclude,
  searchPosts,
} from '../lib/post-search';
import { type PostViewer, visiblePostWhere } from '../lib/post-visibility';
import prisma from '../lib/prisma';
import { sharedCache } from '../lib/shared-cache';

/** HTTP 層に依存しない投稿操作エラー。 */
export class PostServiceError extends DomainError {
  constructor(status: number, message: string) {
    super('POST_ERROR', status, message);
    this.name = 'PostServiceError';
  }
}

/** 既存の投稿入力にタグと公開予約を追加する。 */
export interface PostWriteInput {
  title?: string;
  content?: string;
  published?: boolean;
  categoryIds?: number[];
  tags?: string[];
  scheduledAt?: string | null;
}

type FormattedPost = ReturnType<typeof formatPost>;

function requireUser(user: PostViewer | null): PostViewer {
  if (!user) throw new PostServiceError(401, '認証が必要です');
  return user;
}

function validateId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
    throw new PostServiceError(422, 'Invalid post ID');
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  if (tags.length > 20) throw new PostServiceError(422, 'A post supports at most 20 tags');
  const names: string[] = tags.map((name: string): string =>
    name.trim().normalize('NFKC').toLowerCase(),
  );
  if (
    names.some(
      (name: string): boolean => !name || name.length > 50 || containsControlCharacters(name),
    )
  )
    throw new PostServiceError(422, 'Tags must contain 1 to 50 printable characters');
  return [...new Set(names)];
}

function validateInput(input: PostWriteInput): {
  tags: string[] | undefined;
  categoryIds: number[] | undefined;
  publication: { published?: boolean; scheduledAt?: Date | null };
} {
  if (input.title !== undefined && !input.title.trim())
    throw new PostServiceError(422, 'Title must not be empty');
  if (
    input.categoryIds &&
    (input.categoryIds.length > 20 ||
      input.categoryIds.some(
        (id: number): boolean => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647,
      ))
  )
    throw new PostServiceError(422, 'Invalid category IDs (maximum 20)');
  const publication: { published?: boolean; scheduledAt?: Date | null } = {};
  if (input.scheduledAt !== undefined && input.scheduledAt !== null) {
    const scheduledAt: Date | null = parsePostDate(input.scheduledAt);
    if (!scheduledAt || scheduledAt <= new Date())
      throw new PostServiceError(422, 'scheduledAt must be a future UTC ISO date or timestamp');
    if (input.published === true)
      throw new PostServiceError(422, 'A scheduled post cannot also be published immediately');
    publication.scheduledAt = scheduledAt;
    publication.published = false;
  } else {
    if (input.published !== undefined) {
      publication.published = input.published;
      publication.scheduledAt = null;
    }
    if (input.scheduledAt === null) publication.scheduledAt = null;
  }
  return {
    tags: normalizeTags(input.tags),
    categoryIds: input.categoryIds === undefined ? undefined : [...new Set(input.categoryIds)],
    publication,
  };
}

function translateWriteError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ['P2002', 'P2003', 'P2025'].includes(error.code)
  )
    throw new PostServiceError(400, '投稿の関連データを確認してください');
  throw error;
}

/** 投稿の権限・検索・関連データの一括更新を担当する。DB を注入して検証できる。 */
export class PostService {
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly invalidateContent: () => Promise<void> = () =>
      sharedCache.invalidate('content'),
  ) {}

  /** 匿名レスポンスのキャッシュ期限に使う、最も近い未公開の予約日時。 */
  async nextPublication(now: Date = new Date()): Promise<Date | null> {
    const next = await this.database.post.findFirst({
      where: { published: false, scheduledAt: { gt: now } },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
    return next?.scheduledAt ?? null;
  }

  /** 条件を検証した一覧と、同一可視範囲の検索メタデータを返す。 */
  async list(query: PostSearchInput, user: PostViewer | null) {
    const parsed = parsePostSearch(query);
    if (parsed.error !== undefined) throw new PostServiceError(422, parsed.error);
    return searchPosts(parsed.value, user, this.database);
  }

  /** 参照権限のない投稿は存在しない投稿と同じ応答にする。 */
  async getById(id: number, user: PostViewer | null): Promise<FormattedPost> {
    validateId(id);
    const now: Date = new Date();
    const post = await this.database.post.findFirst({
      where: { AND: [{ id }, visiblePostWhere(user, now)] },
      include: postInclude,
    });
    if (!post) throw new PostServiceError(404, '投稿が見つかりません');
    return formatPost(post, now);
  }

  /** 投稿とカテゴリ・タグ関連を原子的に作成する。 */
  async create(input: PostWriteInput, user: PostViewer | null): Promise<FormattedPost> {
    const author: PostViewer = requireUser(user);
    const { tags, categoryIds, publication } = validateInput(input);
    if (input.title === undefined || input.content === undefined)
      throw new PostServiceError(422, 'Title and content are required');
    try {
      const post = await this.database.post.create({
        data: {
          title: input.title,
          content: input.content,
          authorId: author.id,
          ...publication,
          categories: {
            create: (categoryIds ?? []).map((categoryId: number) => ({
              category: { connect: { id: categoryId } },
            })),
          },
          tags: {
            create: (tags ?? []).map((name: string) => ({
              tag: { connectOrCreate: { where: { name }, create: { name } } },
            })),
          },
        },
        include: postInclude,
      });
      await this.invalidateContent();
      return formatPost(post);
    } catch (error) {
      return translateWriteError(error);
    }
  }

  /** 著者・管理者だけに更新を許可し、関連置換の失敗時は全体をロールバックする。 */
  async update(id: number, input: PostWriteInput, user: PostViewer | null): Promise<FormattedPost> {
    const actor: PostViewer = requireUser(user);
    validateId(id);
    const { tags, categoryIds, publication } = validateInput(input);
    try {
      const result: FormattedPost = await this.database.$transaction(
        async (tx): Promise<FormattedPost> => {
          const post = await tx.post.findUnique({ where: { id } });
          if (!post) throw new PostServiceError(404, '投稿が見つかりません');
          if (post.authorId !== actor.id && actor.role !== 'admin')
            throw new PostServiceError(403, 'この操作を行う権限がありません');
          if (categoryIds !== undefined)
            await tx.categoryOnPost.deleteMany({ where: { postId: id } });
          if (tags !== undefined) await tx.tagOnPost.deleteMany({ where: { postId: id } });
          const updated = await tx.post.update({
            where: { id },
            data: {
              title: input.title,
              content: input.content,
              ...publication,
              ...(categoryIds === undefined
                ? {}
                : {
                    categories: {
                      create: categoryIds.map((categoryId: number) => ({
                        category: { connect: { id: categoryId } },
                      })),
                    },
                  }),
              ...(tags === undefined
                ? {}
                : {
                    tags: {
                      create: tags.map((name: string) => ({
                        tag: { connectOrCreate: { where: { name }, create: { name } } },
                      })),
                    },
                  }),
            },
            include: postInclude,
          });
          return formatPost(updated);
        },
      );
      await this.invalidateContent();
      return result;
    } catch (error) {
      return translateWriteError(error);
    }
  }

  /** 投稿と関連を原子的に削除する。タグ本体は他の投稿で再利用できるよう残す。 */
  async delete(id: number, user: PostViewer | null): Promise<{ message: string }> {
    const actor: PostViewer = requireUser(user);
    validateId(id);
    await this.database.$transaction(async (tx): Promise<void> => {
      const post = await tx.post.findUnique({ where: { id } });
      if (!post) throw new PostServiceError(404, '投稿が見つかりません');
      if (post.authorId !== actor.id && actor.role !== 'admin')
        throw new PostServiceError(403, 'この操作を行う権限がありません');
      await tx.categoryOnPost.deleteMany({ where: { postId: id } });
      await tx.post.delete({ where: { id } });
    });
    await this.invalidateContent();
    return { message: '投稿を削除しました' };
  }
}
