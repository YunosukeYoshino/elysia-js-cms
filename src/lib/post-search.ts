import { Prisma, type PrismaClient } from '@prisma/client';
import { parsePagination } from './pagination';
import { type PostStatus, type PostViewer, postStatus } from './post-visibility';
import prisma from './prisma';

/** 一覧・全文検索で受け付ける文字列クエリ。 */
export interface PostSearchInput {
  q?: string;
  published?: string;
  status?: string;
  authorId?: string;
  categoryId?: string;
  categoryIds?: string;
  tagIds?: string;
  createdFrom?: string;
  createdTo?: string;
  sort?: string;
  take?: string;
  skip?: string;
}

interface SearchOptions {
  q: string | null;
  terms: string[];
  status: PostStatus | 'unpublished' | null;
  authorId: number | null;
  categoryIds: number[];
  tagIds: number[];
  createdFrom: Date | null;
  createdTo: Date | null;
  sort: 'relevance' | 'newest' | 'oldest';
  take: number;
  skip: number;
}

type SearchValidation = { value: SearchOptions; error?: never } | { error: string; value?: never };

/** 制御文字の混入を、正規表現による曖昧な解釈なしに検出する。 */
export function containsControlCharacters(value: string): boolean {
  return [...value].some((character: string): boolean => {
    const code: number = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** SQLite と同じ ASCII 大文字小文字の正規化を行う。日本語などはそのまま比較する。 */
export function foldSearchText(text: string): string {
  return text.replace(/[A-Z]/g, (character: string): string => character.toLowerCase());
}

/** 厳密な正の整数 ID を検証する。SQLite/Prisma の Int 範囲に限定する。 */
export function parsePostId(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const id: number = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function parseIds(value: string | undefined): number[] | null {
  if (value === undefined) return [];
  const pieces: string[] = value.split(',');
  if (pieces.length > 20) return null;
  const ids: number[] = [];
  for (const piece of pieces) {
    const id: number | null = parsePostId(piece);
    if (id === null) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** UTC の ISO 日付・日時のみ受け付け、存在しない日付や時刻を拒否する。 */
export function parsePostDate(value: string, endOfDay = false): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) return null;
  const dateOnly: boolean = value.length === 10;
  const canonical: string = dateOnly
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value.includes('.')
      ? value.replace(
          /\.(\d+)Z$/,
          (_match: string, digits: string): string => `.${digits.padEnd(3, '0')}Z`,
        )
      : value.replace('Z', '.000Z');
  const date: Date = new Date(canonical);
  return Number.isFinite(date.getTime()) &&
    date.toISOString() === canonical &&
    date.getUTCFullYear() > 0
    ? date
    : null;
}

/** 検索条件を検証し、SQL に渡す前に正規化する。 */
export function parsePostSearch(query: PostSearchInput): SearchValidation {
  const page = parsePagination(query);
  if (!page) return { error: 'Invalid pagination' };
  const q: string | null = query.q?.trim() || null;
  if (query.q !== undefined && (!q || query.q.length > 200 || containsControlCharacters(query.q))) {
    return { error: 'q must contain 1 to 200 printable characters' };
  }
  const terms: string[] = q ? [...new Set(q.split(/\s+/u).map(foldSearchText))] : [];
  if (terms.length > 10) return { error: 'q supports at most 10 distinct terms' };
  if (query.published !== undefined && query.published !== 'true' && query.published !== 'false') {
    return { error: 'published must be true or false' };
  }
  if (query.status !== undefined && !['draft', 'published', 'scheduled'].includes(query.status)) {
    return { error: 'status must be draft, published or scheduled' };
  }
  if (query.status !== undefined && query.published !== undefined) {
    return { error: 'Use either status or published' };
  }
  const status: SearchOptions['status'] =
    query.status === 'draft' || query.status === 'scheduled' || query.status === 'published'
      ? query.status
      : query.published === 'true'
        ? 'published'
        : query.published === 'false'
          ? 'unpublished'
          : null;
  const authorId: number | null = query.authorId === undefined ? null : parsePostId(query.authorId);
  if (query.authorId !== undefined && authorId === null) return { error: 'Invalid authorId' };
  if (query.categoryId !== undefined && query.categoryIds !== undefined)
    return { error: 'Use either categoryId or categoryIds' };
  if (query.categoryId !== undefined && parsePostId(query.categoryId) === null) {
    return { error: 'Invalid categoryId' };
  }
  const categoryIds: number[] | null = parseIds(query.categoryIds ?? query.categoryId);
  const tagIds: number[] | null = parseIds(query.tagIds);
  if (!categoryIds || !tagIds)
    return { error: 'Category and tag IDs must be comma-separated positive integers (maximum 20)' };
  const createdFrom: Date | null =
    query.createdFrom === undefined ? null : parsePostDate(query.createdFrom);
  const createdTo: Date | null =
    query.createdTo === undefined ? null : parsePostDate(query.createdTo, true);
  if (
    (query.createdFrom !== undefined && !createdFrom) ||
    (query.createdTo !== undefined && !createdTo)
  ) {
    return { error: 'Dates must be valid UTC ISO dates or timestamps' };
  }
  if (createdFrom && createdTo && createdFrom > createdTo)
    return { error: 'createdFrom must not exceed createdTo' };
  if (query.sort !== undefined && !['relevance', 'newest', 'oldest'].includes(query.sort))
    return { error: 'Invalid sort' };
  if (query.sort === 'relevance' && !q) return { error: 'relevance sorting requires q' };
  const advanced: boolean = [
    'q',
    'status',
    'categoryIds',
    'tagIds',
    'createdFrom',
    'createdTo',
    'sort',
  ].some((key: string): boolean => query[key as keyof PostSearchInput] !== undefined);
  // 既存クライアントの signed take 契約を維持し、新しい検索には負荷上限を設ける。
  if (advanced && (Math.abs(page.take) > 100 || page.skip > 10000))
    return { error: 'Search pagination requires |take| <= 100 and skip <= 10000' };
  return {
    value: {
      q,
      terms,
      status,
      authorId,
      categoryIds,
      tagIds,
      createdFrom,
      createdTo,
      sort:
        query.sort === 'oldest'
          ? 'oldest'
          : query.sort === 'newest'
            ? 'newest'
            : q
              ? 'relevance'
              : 'newest',
      ...page,
    },
  };
}

const includePost = {
  author: { select: { id: true, name: true } },
  categories: { include: { category: true } },
  tags: { include: { tag: true } },
} satisfies Prisma.PostInclude;

/** 投稿の取得・更新で統一する関連フィールド。著者の個人情報は取得しない。 */
export const postInclude = includePost;

type DetailedPost = Prisma.PostGetPayload<{ include: typeof includePost }>;

/** 関連テーブルを展開し、有効な公開状態を付与する。 */
export function formatPost(post: DetailedPost, now: Date = new Date()) {
  const status: PostStatus = postStatus(post, now);
  return {
    ...post,
    author: { id: post.author.id, name: post.author.name },
    published: status === 'published',
    status,
    categories: post.categories.map((entry) => entry.category),
    tags: post.tags.map((entry) => entry.tag),
  };
}

function statusSql(now: Date): Prisma.Sql {
  return Prisma.sql`CASE WHEN p.published = 1 OR p.scheduledAt <= ${now} THEN 'published' WHEN p.scheduledAt IS NOT NULL THEN 'scheduled' ELSE 'draft' END`;
}

function searchWhere(options: SearchOptions, user: PostViewer | null, now: Date): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (user?.role !== 'admin') {
    const publicCondition: Prisma.Sql = Prisma.sql`(p.published = 1 OR p.scheduledAt <= ${now})`;
    conditions.push(
      user ? Prisma.sql`(${publicCondition} OR p.authorId = ${user.id})` : publicCondition,
    );
  }
  if (options.status) {
    conditions.push(
      options.status === 'unpublished'
        ? Prisma.sql`${statusSql(now)} != 'published'`
        : Prisma.sql`${statusSql(now)} = ${options.status}`,
    );
  }
  if (options.authorId !== null) conditions.push(Prisma.sql`p.authorId = ${options.authorId}`);
  if (options.categoryIds.length)
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM CategoryOnPost cp WHERE cp.postId = p.id AND cp.categoryId IN (${Prisma.join(options.categoryIds)}))`,
    );
  if (options.tagIds.length)
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM TagOnPost tp WHERE tp.postId = p.id AND tp.tagId IN (${Prisma.join(options.tagIds)}))`,
    );
  if (options.createdFrom) conditions.push(Prisma.sql`p.createdAt >= ${options.createdFrom}`);
  if (options.createdTo) conditions.push(Prisma.sql`p.createdAt <= ${options.createdTo}`);
  for (const term of options.terms)
    conditions.push(
      Prisma.sql`(instr(lower(p.title), ${term}) > 0 OR instr(lower(p.content), ${term}) > 0)`,
    );
  return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`1 = 1`;
}

function relevanceSql(terms: string[]): Prisma.Sql {
  return terms.length
    ? Prisma.join(
        terms.map(
          (term: string): Prisma.Sql =>
            Prisma.sql`(CASE WHEN instr(lower(p.title), ${term}) > 0 THEN 3 ELSE 0 END + CASE WHEN instr(lower(p.content), ${term}) > 0 THEN 1 ELSE 0 END)`,
        ),
        ' + ',
      )
    : Prisma.sql`0`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 保存された HTML と検索語をエスケープし、短い抜粋内の一致だけを mark で囲む。 */
export function highlightSearchText(value: string, terms: string[], length = 240): string {
  const folded: string = foldSearchText(value);
  const matches: number[] = terms
    .map((term: string): number => folded.indexOf(term))
    .filter((index: number): boolean => index >= 0);
  const first: number = matches.length ? Math.min(...matches) : 0;
  const start: number = Math.max(0, first - Math.floor(length / 4));
  const excerpt: string = value.slice(start, start + length);
  const normalized: string = foldSearchText(excerpt);
  const highlighted: boolean[] = Array.from({ length: excerpt.length }, (): boolean => false);
  for (const term of terms) {
    if (!term) continue;
    let position: number = normalized.indexOf(term);
    while (position !== -1) {
      for (let index: number = position; index < position + term.length; index++)
        highlighted[index] = true;
      position = normalized.indexOf(term, position + 1);
    }
  }
  let result: string = start > 0 ? '…' : '';
  let marking = false;
  for (let index = 0; index < excerpt.length; index++) {
    if (highlighted[index] !== marking) {
      result += highlighted[index] ? '<mark>' : '</mark>';
      marking = highlighted[index];
    }
    result += escapeHtml(excerpt[index]);
  }
  if (marking) result += '</mark>';
  return result + (start + length < value.length ? '…' : '');
}

interface ResultId {
  id: number;
  relevance: number | bigint;
}
interface Count {
  count: number | bigint;
}
interface FacetRow extends Count {
  id: number;
  name: string | null;
}
interface StatusRow extends Count {
  status: PostStatus;
}
const facetLimit = 100;

/** DB 内で条件・関連度・ページを計算し、同じ可視範囲のファセットを返す。 */
export async function searchPosts(
  options: SearchOptions,
  user: PostViewer | null,
  database: PrismaClient = prisma,
) {
  const now: Date = new Date();
  const where: Prisma.Sql = searchWhere(options, user, now);
  const score: Prisma.Sql = relevanceSql(options.terms);
  const reverse: boolean = options.take < 0;
  const direction: Prisma.Sql =
    (options.sort === 'oldest') !== reverse ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const order: Prisma.Sql =
    options.sort === 'relevance'
      ? Prisma.sql`relevance ${reverse ? Prisma.sql`ASC` : Prisma.sql`DESC`}, p.createdAt ${direction}, p.id ${direction}`
      : Prisma.sql`p.createdAt ${direction}, p.id ${direction}`;
  return database.$transaction(async (tx) => {
    const ids: ResultId[] = await tx.$queryRaw(
      Prisma.sql`SELECT p.id, (${score}) AS relevance FROM Post p WHERE ${where} ORDER BY ${order} LIMIT ${Math.abs(options.take)} OFFSET ${options.skip}`,
    );
    if (reverse) ids.reverse();
    const posts: DetailedPost[] = ids.length
      ? await tx.post.findMany({
          where: { id: { in: ids.map((row: ResultId): number => row.id) } },
          include: includePost,
        })
      : [];
    const byId: Map<number, DetailedPost> = new Map(
      posts.map((post: DetailedPost): [number, DetailedPost] => [post.id, post]),
    );
    const totals: Count[] = await tx.$queryRaw(
      Prisma.sql`SELECT COUNT(*) AS count FROM Post p WHERE ${where}`,
    );
    const categories: FacetRow[] = await tx.$queryRaw(
      Prisma.sql`SELECT c.id, c.name, COUNT(*) AS count FROM Post p JOIN CategoryOnPost cp ON cp.postId = p.id JOIN Category c ON c.id = cp.categoryId WHERE ${where} GROUP BY c.id, c.name ORDER BY count DESC, c.id ASC LIMIT ${facetLimit + 1}`,
    );
    const tags: FacetRow[] = await tx.$queryRaw(
      Prisma.sql`SELECT t.id, t.name, COUNT(*) AS count FROM Post p JOIN TagOnPost tp ON tp.postId = p.id JOIN Tag t ON t.id = tp.tagId WHERE ${where} GROUP BY t.id, t.name ORDER BY count DESC, t.id ASC LIMIT ${facetLimit + 1}`,
    );
    const authors: FacetRow[] = await tx.$queryRaw(
      Prisma.sql`SELECT u.id, u.name, COUNT(*) AS count FROM Post p JOIN User u ON u.id = p.authorId WHERE ${where} GROUP BY u.id, u.name ORDER BY count DESC, u.id ASC LIMIT ${facetLimit + 1}`,
    );
    const statuses: StatusRow[] = await tx.$queryRaw(
      Prisma.sql`SELECT ${statusSql(now)} AS status, COUNT(*) AS count FROM Post p WHERE ${where} GROUP BY status ORDER BY status`,
    );
    const facet = (rows: FacetRow[]) =>
      rows
        .slice(0, facetLimit)
        .map((row: FacetRow) => ({ id: row.id, name: row.name, count: Number(row.count) }));
    const facets = {
      categories: facet(categories),
      tags: facet(tags),
      authors: facet(authors),
      statuses: (['draft', 'published', 'scheduled'] as const).map((status: PostStatus) => ({
        value: status,
        count: Number(
          statuses.find((row: StatusRow): boolean => row.status === status)?.count ?? 0,
        ),
      })),
    };
    return {
      data: ids.flatMap((row: ResultId) => {
        const post: DetailedPost | undefined = byId.get(row.id);
        return post
          ? [
              {
                ...formatPost(post, now),
                ...(options.q
                  ? {
                      relevance: Number(row.relevance),
                      highlights: {
                        title: highlightSearchText(post.title, options.terms, 300),
                        content: highlightSearchText(post.content, options.terms),
                      },
                    }
                  : {}),
              },
            ]
          : [];
      }),
      meta: {
        total: Number(totals[0]?.count ?? 0),
        skip: options.skip,
        take: options.take,
        filters: {
          q: options.q,
          status: options.status,
          authorId: options.authorId,
          categoryIds: options.categoryIds,
          tagIds: options.tagIds,
          createdFrom: options.createdFrom,
          createdTo: options.createdTo,
          sort: options.sort,
        },
        facets,
        filterOptions: {
          categories: facets.categories.map(({ id, name }) => ({ id, name })),
          tags: facets.tags.map(({ id, name }) => ({ id, name })),
          authors: facets.authors.map(({ id, name }) => ({ id, name })),
          statuses: facets.statuses.filter(({ count }) => count > 0).map(({ value }) => value),
        },
        facetLimit,
        facetsTruncated: {
          categories: categories.length > facetLimit,
          tags: tags.length > facetLimit,
          authors: authors.length > facetLimit,
        },
      },
    };
  });
}
