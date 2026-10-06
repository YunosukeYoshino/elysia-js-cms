import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { jwt } from '@elysiajs/jwt';
import type { Post, Prisma } from '@prisma/client';
import app from '../index';
import { getJwtSecret } from '../lib/jwt-config';
import {
  highlightSearchText,
  parsePostDate,
  parsePostId,
  parsePostSearch,
} from '../lib/post-search';
import {
  type PostViewer,
  postStatus,
  publicPostWhere,
  visiblePostWhere,
} from '../lib/post-visibility';
import prisma from '../lib/prisma';
import { PostService, PostServiceError, type PostWriteInput } from '../services/post-service';

type SearchResponse = Awaited<ReturnType<PostService['list']>>;

it('validates UTC dates and IDs without accepting partial parses or invalid calendar days', () => {
  expect(parsePostDate('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  expect(parsePostDate('2024-02-29', true)?.toISOString()).toBe('2024-02-29T23:59:59.999Z');
  expect(parsePostDate('2024-02-29T03:04:05.6Z')?.toISOString()).toBe('2024-02-29T03:04:05.600Z');
  expect(parsePostDate('2024-02-29T03:04:05Z')?.toISOString()).toBe('2024-02-29T03:04:05.000Z');
  for (const value of [
    '2023-02-29',
    '2024-02-30',
    '0000-01-01',
    '2024-01-01T24:00:00Z',
    '2024-01-01T00:60:00Z',
    '2024-01-01T00:00:00+09:00',
    'garbage',
  ])
    expect(parsePostDate(value)).toBeNull();
  for (const value of ['1x', '-1', '0', '1.0', '1e2', ' 1', '2147483648'])
    expect(parsePostId(value)).toBeNull();
  expect(parsePostId('001')).toBe(1);
});

it('escapes highlights, merges overlapping terms and truncates around a late match', () => {
  expect(highlightSearchText('<script>Alpha & "beta"</script>', ['alpha', 'beta'])).toBe(
    '&lt;script&gt;<mark>Alpha</mark> &amp; &quot;<mark>beta</mark>&quot;&lt;/script&gt;',
  );
  expect(highlightSearchText('banana', ['ban', 'ana'])).toBe('<mark>banana</mark>');
  expect(highlightSearchText("'<img> 日本語", ['日本語'])).toBe(
    '&#39;&lt;img&gt; <mark>日本語</mark>',
  );
  expect(highlightSearchText(`${'x'.repeat(300)}Alpha${'x'.repeat(300)}`, ['alpha'])).toContain(
    '…',
  );
  expect(highlightSearchText(`${'x'.repeat(300)}Alpha${'x'.repeat(300)}`, ['alpha'])).toContain(
    '<mark>Alpha</mark>',
  );
  expect(highlightSearchText('nothing', ['missing'])).toBe('nothing');
});

it('uses the same effective publication rules for Prisma and response status', () => {
  const now: Date = new Date('2025-01-01T00:00:00Z');
  expect(postStatus({ published: false, scheduledAt: now }, now)).toBe('published');
  expect(postStatus({ published: true, scheduledAt: new Date('2030-01-01') }, now)).toBe(
    'published',
  );
  expect(postStatus({ published: false, scheduledAt: null }, now)).toBe('draft');
  expect(postStatus({ published: false, scheduledAt: new Date('2030-01-01') }, now)).toBe(
    'scheduled',
  );
  expect(visiblePostWhere(null, now)).toEqual(publicPostWhere(now));
  expect(visiblePostWhere({ id: 1, role: 'admin' }, now)).toEqual({});
  expect(visiblePostWhere({ id: 1, role: 'user' }, now)).toEqual({
    OR: [publicPostWhere(now), { authorId: 1 }],
  });
});

it('applies the additive migration without changing existing content', async () => {
  const db: Database = new Database(':memory:');
  try {
    db.exec(await readFile('prisma/migrations/20250313140408_init/migration.sql', 'utf8'));
    db.exec(
      `INSERT INTO User (id,email,password,updatedAt) VALUES (1,'migration@example.com','fixture',CURRENT_TIMESTAMP); INSERT INTO Post (id,title,content,published,authorId,updatedAt) VALUES (1,'original','content',1,1,CURRENT_TIMESTAMP)`,
    );
    db.exec(await readFile('prisma/migrations/20261006182100_post_search/migration.sql', 'utf8'));
    expect(db.query('SELECT title,content,published,scheduledAt FROM Post').get()).toEqual({
      title: 'original',
      content: 'content',
      published: 1,
      scheduledAt: null,
    });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='TagOnPost_tagId_postId_idx'",
        )
        .get(),
    ).toEqual({ name: 'TagOnPost_tagId_postId_idx' });
    db.exec(
      "PRAGMA foreign_keys=ON; INSERT INTO Tag (id,name) VALUES (1,'tag'); INSERT INTO TagOnPost (postId,tagId) VALUES (1,1); DELETE FROM Post WHERE id=1",
    );
    expect(db.query('SELECT COUNT(*) AS count FROM TagOnPost').get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

describe('Post search, publication and injectable service', () => {
  const key: string = `search-${Date.now()}`;
  const service: PostService = new PostService(prisma);
  let owner: PostViewer;
  let other: PostViewer;
  let admin: PostViewer;
  let ownerToken = '';
  let otherToken = '';
  let adminToken = '';
  let categoryA = 0;
  let categoryB = 0;
  let privateCategory = 0;
  let redTag = 0;
  let blueTag = 0;
  let secretTag = 0;
  let titleMatch: Post;
  let contentMatch: Post;
  let draft: Post;
  let scheduled: Post;
  let due: Post;
  let otherDraft: Post;
  const userIds: number[] = [];
  const categoryIds: number[] = [];
  const tagIds: number[] = [];

  const get = (query: Record<string, string> = {}, token = ''): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api/posts?${new URLSearchParams({ q: key, ...query })}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    );
  const detail = (id: number | string, token = ''): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api/posts/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    );
  const write = (
    method: string,
    path: string,
    body: PostWriteInput,
    token = ownerToken,
  ): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api/posts${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  const read = async (response: Response): Promise<SearchResponse> => {
    expect(response.status).toBe(200);
    return response.json();
  };
  const createFixture = (
    data: Omit<Prisma.PostUncheckedCreateInput, 'authorId'> & { authorId?: number },
  ): Promise<Post> =>
    prisma.post.create({
      data: { authorId: owner.id, createdAt: new Date('2020-01-02T12:00:00Z'), ...data },
    });

  beforeAll(async () => {
    await import('../scripts/prepare-db').then((module) => module.default('test'));
    const makeUser = async (name: string, role = 'user'): Promise<PostViewer> => {
      const user = await prisma.user.create({
        data: { email: `${key}-${name}@example.com`, password: 'unused-fixture', name, role },
      });
      userIds.push(user.id);
      return user;
    };
    owner = await makeUser('owner');
    other = await makeUser('other');
    admin = await makeUser('admin', 'admin');
    const token = (user: PostViewer): Promise<string> =>
      jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
        userId: user.id,
        type: 'access',
        exp: Math.floor(Date.now() / 1000) + 600,
      });
    [ownerToken, otherToken, adminToken] = await Promise.all([
      token(owner),
      token(other),
      token(admin),
    ]);
    for (const suffix of ['a', 'b', 'private'])
      categoryIds.push(
        (
          await prisma.category.create({
            data: { name: `${key}-${suffix}`, slug: `${key}-${suffix}` },
          })
        ).id,
      );
    [categoryA, categoryB, privateCategory] = categoryIds;
    for (const suffix of ['red', 'blue', 'secret'])
      tagIds.push((await prisma.tag.create({ data: { name: `${key}-${suffix}` } })).id);
    [redTag, blueTag, secretTag] = tagIds;
    titleMatch = await createFixture({
      title: `${key} <script>Alpha</script> & "beta"`,
      content: '日本語 and gamma with literal %_ characters',
      published: true,
      categories: { create: [{ categoryId: categoryA }, { categoryId: categoryB }] },
      tags: { create: [{ tagId: redTag }, { tagId: blueTag }] },
    });
    contentMatch = await createFixture({
      title: `${key} body-only`,
      content: 'Alpha and gamma in body',
      published: true,
      categories: { create: { categoryId: categoryB } },
      tags: { create: { tagId: blueTag } },
    });
    draft = await createFixture({
      title: `${key} Alpha private draft`,
      content: 'secret',
      categories: { create: { categoryId: privateCategory } },
      tags: { create: { tagId: secretTag } },
    });
    scheduled = await createFixture({
      title: `${key} Alpha scheduled`,
      content: 'future',
      scheduledAt: new Date('2099-01-01T00:00:00Z'),
      categories: { create: { categoryId: privateCategory } },
    });
    due = await createFixture({
      title: `${key} Alpha due`,
      content: 'released',
      scheduledAt: new Date('2020-01-01T00:00:00Z'),
      createdAt: new Date('2020-01-03T00:00:00Z'),
      categories: { create: { categoryId: categoryA } },
      tags: { create: { tagId: redTag } },
    });
    otherDraft = await createFixture({
      title: `${key} Alpha other private`,
      content: 'hidden',
      authorId: other.id,
    });
  });
  afterAll(async () => {
    await prisma.categoryOnPost.deleteMany({ where: { post: { authorId: { in: userIds } } } });
    await prisma.post.deleteMany({ where: { authorId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma.tag.deleteMany({
      where: { OR: [{ id: { in: tagIds } }, { name: { startsWith: key } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('matches terms across title and body, weights title matches and returns safe highlights', async () => {
    const result: SearchResponse = await read(await get({ q: `${key} ALPHA gamma` }));
    expect(result.data.map((post) => post.id)).toEqual([titleMatch.id, contentMatch.id]);
    expect(result.data[0].relevance).toBeGreaterThan(result.data[1].relevance ?? 0);
    expect(result.data[0].highlights?.title).toContain(
      '&lt;script&gt;<mark>Alpha</mark>&lt;/script&gt;',
    );
    expect(result.data[0].highlights?.title).toContain('&amp; &quot;beta&quot;');
    expect(result.data[0].highlights?.title).not.toContain('<script>');
    expect(result.data[1].highlights?.content).toContain('<mark>Alpha</mark>');
    expect(result.meta.total).toBe(2);
  });
  it('treats punctuation and SQL-like text as literal search input, and supports Japanese substrings', async () => {
    for (const q of [`${key} %_`, `${key} 日本語`])
      expect((await read(await get({ q }))).data.map((post) => post.id)).toEqual([titleMatch.id]);
    for (const q of [`${key} ' OR 1=1 --`, `${key} "Alpha"`, `${key} missing`, `${key} *`])
      expect((await read(await get({ q }))).meta.total).toBe(0);
    expect((await read(await get({ q: `${key} Alpha Alpha` }))).data).toHaveLength(3);
  });
  it('uses conjunctive author/category/tag/date filters with OR within each ID list', async () => {
    const result: SearchResponse = await read(
      await get({
        authorId: String(owner.id),
        categoryIds: `${categoryA},${categoryA}`,
        tagIds: String(blueTag),
        createdFrom: '2020-01-02',
        createdTo: '2020-01-02',
      }),
    );
    expect(result.data.map((post) => post.id)).toEqual([titleMatch.id]);
    expect(result.meta.filters.categoryIds).toEqual([categoryA]);
    expect(
      (
        await read(
          await get({ categoryIds: `${categoryA},${categoryB}`, tagIds: `${redTag},${blueTag}` }),
        )
      ).meta.total,
    ).toBe(3);
    expect(
      (await read(await get({ authorId: String(other.id), categoryId: String(categoryA) }))).meta
        .total,
    ).toBe(0);
    expect(
      (
        await read(
          await get({ createdFrom: '2020-01-03T00:00:00Z', createdTo: '2020-01-03T00:00:00Z' }),
        )
      ).data.map((post) => post.id),
    ).toEqual([due.id]);
  });
  it('keeps stable order and facets across pages, zero and reverse take', async () => {
    const all: SearchResponse = await read(await get());
    expect(all.data.map((post) => post.id)).toEqual([due.id, contentMatch.id, titleMatch.id]);
    const page: SearchResponse = await read(await get({ take: '1', skip: '1' }));
    expect(page.data.map((post) => post.id)).toEqual([contentMatch.id]);
    expect(page.meta.total).toBe(3);
    expect(page.meta.facets).toEqual(all.meta.facets);
    expect((await read(await get({ take: '0' }))).data).toHaveLength(0);
    expect((await read(await get({ take: '-1' }))).data.map((post) => post.id)).toEqual([
      titleMatch.id,
    ]);
    expect((await read(await get({ sort: 'oldest' }))).data.map((post) => post.id)).toEqual([
      titleMatch.id,
      contentMatch.id,
      due.id,
    ]);
    expect((await read(await get({ sort: 'newest', skip: '100' }))).data).toHaveLength(0);
  });
  it('provides counts and available options from the matching visible posts without duplicate joins', async () => {
    const result: SearchResponse = await read(await get());
    expect(result.meta.facets.categories).toContainEqual({
      id: categoryA,
      name: `${key}-a`,
      count: 2,
    });
    expect(result.meta.facets.categories).toContainEqual({
      id: categoryB,
      name: `${key}-b`,
      count: 2,
    });
    expect(result.meta.facets.tags).toContainEqual({ id: blueTag, name: `${key}-blue`, count: 2 });
    expect(result.meta.facets.authors).toEqual([{ id: owner.id, name: 'owner', count: 3 }]);
    expect(result.meta.facets.statuses).toEqual([
      { value: 'draft', count: 0 },
      { value: 'published', count: 3 },
      { value: 'scheduled', count: 0 },
    ]);
    expect(result.meta.filterOptions.statuses).toEqual(['published']);
    expect(result.meta.filterOptions.tags).not.toContainEqual({
      id: secretTag,
      name: `${key}-secret`,
    });
    expect(result.meta.facetsTruncated).toEqual({ categories: false, tags: false, authors: false });
    expect((await read(await get({ q: `${key} missing` }))).meta.filterOptions).toEqual({
      categories: [],
      tags: [],
      authors: [],
      statuses: [],
    });
  });
  it('never exposes private content, counts or tag options to guests or other authors', async () => {
    for (const token of ['', 'invalid-token', otherToken]) {
      const result: SearchResponse = await read(await get({}, token));
      expect(result.data.map((post) => post.id)).not.toContain(draft.id);
      expect(result.data.map((post) => post.id)).not.toContain(scheduled.id);
      expect(result.meta.filterOptions.categories.map((category) => category.id)).not.toContain(
        privateCategory,
      );
      expect((await detail(draft.id, token)).status).toBe(404);
      expect((await detail(scheduled.id, token)).status).toBe(404);
    }
    for (const status of ['draft', 'scheduled'])
      expect((await read(await get({ status }))).meta.total).toBe(0);
    expect((await read(await get({ published: 'false' }))).meta.total).toBe(0);
    expect((await read(await get({ published: 'true' }))).meta.total).toBe(3);
  });
  it('lets authors see their own private posts and administrators inspect all posts', async () => {
    expect((await read(await get({}, ownerToken))).meta.total).toBe(5);
    expect((await read(await get({}, otherToken))).meta.total).toBe(4);
    expect((await read(await get({}, adminToken))).meta.total).toBe(6);
    expect(
      (await read(await get({ status: 'draft' }, ownerToken))).data.map((post) => post.id),
    ).toEqual([draft.id]);
    expect(
      (await read(await get({ status: 'scheduled' }, ownerToken))).data.map((post) => post.id),
    ).toEqual([scheduled.id]);
    expect((await read(await get({ published: 'false' }, ownerToken))).meta.total).toBe(2);
    expect((await detail(draft.id, ownerToken)).status).toBe(200);
    expect((await detail(otherDraft.id, adminToken)).status).toBe(200);
    const published = await service.getById(due.id, null);
    expect(published.published).toBe(true);
    expect(published.status).toBe('published');
    expect((await prisma.post.findUniqueOrThrow({ where: { id: due.id } })).published).toBe(false);
  });
  it('validates every filter before SQL execution and rejects malformed route IDs', async () => {
    const invalid: Record<string, string>[] = [
      { q: '' },
      { q: ' ' },
      { q: 'x'.repeat(201) },
      { q: 'a\nb' },
      { q: 'a\u007fb' },
      { q: 'a b c d e f g h i j k' },
      { published: 'yes' },
      { published: '' },
      { status: 'deleted' },
      { status: 'draft', published: 'false' },
      { authorId: '1x' },
      { authorId: '2147483648' },
      { categoryId: '0' },
      { categoryId: '1,2' },
      { categoryId: '1', categoryIds: '2' },
      { categoryIds: '1,,2' },
      { categoryIds: '1, 2' },
      { tagIds: '' },
      { tagIds: Array.from({ length: 21 }, (_, index) => String(index + 1)).join(',') },
      { createdFrom: 'yesterday' },
      { createdTo: '2023-02-29' },
      { createdFrom: '2020-02-01', createdTo: '2020-01-01' },
      { sort: 'random' },
      { take: '101' },
      { take: '-101' },
      { skip: '10001' },
      { skip: '-1' },
      { take: '1x' },
    ];
    for (const query of invalid) expect((await get(query)).status, JSON.stringify(query)).toBe(422);
    for (const id of ['1x', '0', '-1', '1.1', '2147483648'])
      expect((await detail(id)).status).toBe(422);
    expect((await detail('2147483647')).status).toBe(404);
    expect(parsePostSearch({ sort: 'relevance' }).error).toBe('relevance sorting requires q');
  });
  it('preserves legacy pagination while intentionally returning privacy-safe author fields', async () => {
    for (const take of ['0', '-1', '9007199254740991']) {
      const response: Response = await app.handle(
        new Request(`http://localhost/api/posts?authorId=${owner.id}&take=${take}`),
      );
      const result: SearchResponse = await read(response);
      expect(result.meta.take).toBe(Number(take));
      expect(result.meta.total).toBe(3);
      if (take !== '0') {
        expect(result.data[0].author).toEqual({ id: owner.id, name: 'owner' });
        expect(result.data[0]).not.toHaveProperty('author.email');
        expect(result.data[0]).toHaveProperty('categories');
        expect(result.data[0]).not.toHaveProperty('highlights');
      }
    }
  });
  it('creates and replaces tags/categories atomically while retaining omitted relationships', async () => {
    const created = await service.create(
      {
        title: 'Service mutation',
        content: 'body',
        categoryIds: [categoryA, categoryA],
        tags: [`${key}-New`, ` ${key}-new `],
        scheduledAt: '2099-01-01T00:00:00Z',
      },
      owner,
    );
    expect(created.status).toBe('scheduled');
    expect(created.tags).toHaveLength(1);
    expect(created.categories).toHaveLength(1);
    const retained = await service.update(created.id, { title: 'Changed' }, owner);
    expect(retained.tags).toEqual(created.tags);
    expect(retained.categories).toEqual(created.categories);
    expect(retained.scheduledAt).toEqual(created.scheduledAt);
    const updated = await service.update(
      created.id,
      { categoryIds: [categoryB], tags: [`${key}-new`, `${key}-blue`], published: true },
      owner,
    );
    expect(updated.scheduledAt).toBeNull();
    expect(updated.status).toBe('published');
    expect(updated.tags).toHaveLength(2);
    expect(updated.categories.map((category) => category.id)).toEqual([categoryB]);
    const cleared = await service.update(
      created.id,
      { categoryIds: [], tags: [], published: false },
      admin,
    );
    expect(cleared.categories).toEqual([]);
    expect(cleared.tags).toEqual([]);
    expect(cleared.status).toBe('draft');
    expect(await service.delete(created.id, admin)).toEqual({ message: '投稿を削除しました' });
    expect(await prisma.tag.findUnique({ where: { name: `${key}-new` } })).not.toBeNull();
  });
  it('rolls back a failed category replacement including tag removals and content changes', async () => {
    const before = await service.getById(titleMatch.id, owner);
    await expect(
      service.update(
        titleMatch.id,
        { title: 'must roll back', categoryIds: [2147483647], tags: [] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await service.getById(titleMatch.id, owner)).toEqual(before);
    const count: number = await prisma.post.count();
    await expect(
      service.create(
        {
          title: 'invalid category',
          content: '',
          categoryIds: [2147483647],
          tags: [`${key}-rollback`],
        },
        owner,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.post.count()).toBe(count);
    expect(await prisma.tag.findUnique({ where: { name: `${key}-rollback` } })).toBeNull();
  });
  it('enforces service authorization and existence checks independently of HTTP middleware', async () => {
    await expect(service.create({ title: 'no', content: '' }, null)).rejects.toMatchObject({
      status: 401,
    });
    await expect(service.update(draft.id, {}, null)).rejects.toMatchObject({ status: 401 });
    await expect(service.delete(draft.id, null)).rejects.toMatchObject({ status: 401 });
    await expect(service.update(draft.id, {}, other)).rejects.toMatchObject({ status: 403 });
    await expect(service.delete(draft.id, other)).rejects.toMatchObject({ status: 403 });
    await expect(service.update(2147483647, {}, owner)).rejects.toMatchObject({ status: 404 });
    await expect(service.delete(2147483647, owner)).rejects.toMatchObject({ status: 404 });
    await expect(service.getById(-1, owner)).rejects.toMatchObject({ status: 422 });
    await expect(service.list({ authorId: 'bad' }, null)).rejects.toBeInstanceOf(PostServiceError);
  });
  it('validates write inputs and explicit scheduling conflicts through the service and API', async () => {
    const invalid: PostWriteInput[] = [
      { title: ' ' },
      { tags: [' '] },
      { tags: ['a'.repeat(51)] },
      { tags: ['a\nb'] },
      { tags: Array(21).fill('tag') },
      { categoryIds: [0] },
      { categoryIds: [1.1] },
      { categoryIds: Array(21).fill(1) },
      { scheduledAt: '2020-01-01' },
      { scheduledAt: '2099-02-30' },
      { scheduledAt: '2099-01-01', published: true },
    ];
    for (const input of invalid) {
      await expect(
        service.create({ title: 'new', content: '', ...input }, owner),
      ).rejects.toMatchObject({ status: 422 });
      expect((await write('POST', '', { title: 'new', content: '', ...input })).status).toBe(422);
    }
    await expect(service.create({ content: '' }, owner)).rejects.toMatchObject({ status: 422 });
    await expect(service.create({ title: 'new' }, owner)).rejects.toMatchObject({ status: 422 });
    const response: Response = await write('POST', '', {
      title: 'HTTP scheduled',
      content: '',
      scheduledAt: '2099-01-01T00:00:00Z',
      tags: [`${key}-http`],
    });
    expect(response.status).toBe(200);
    const created: { id: number; status: string } = await response.json();
    expect(created.status).toBe('scheduled');
    const cleared = await service.update(created.id, { scheduledAt: null }, owner);
    expect(cleared.status).toBe('draft');
    expect((await write('PUT', `/${created.id}`, { published: true })).status).toBe(200);
    expect((await detail(created.id)).status).toBe(200);
    expect(
      (
        await app.handle(
          new Request(`http://localhost/api/posts/${created.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${ownerToken}` },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await detail(created.id)).status).toBe(404);
  });
  it('paginates a thousand matching rows in SQL and bounds facet options', async () => {
    const bulkKey: string = `bulk-${Date.now()}`;
    const bulkTags: number[] = [];
    try {
      await prisma.post.createMany({
        data: Array.from({ length: 1000 }, (_, index) => ({
          title: `${bulkKey} ${index}`,
          content: 'indexed fixture',
          authorId: owner.id,
          published: true,
          createdAt: new Date('2021-01-01T00:00:00Z'),
        })),
      });
      const posts = await prisma.post.findMany({
        where: { title: { startsWith: bulkKey } },
        select: { id: true },
        orderBy: { id: 'desc' },
      });
      await prisma.categoryOnPost.createMany({
        data: posts.map((post, index) => ({
          postId: post.id,
          categoryId: index % 2 ? categoryA : categoryB,
        })),
      });
      await prisma.tag.createMany({
        data: Array.from({ length: 105 }, (_, index) => ({ name: `${bulkKey}-tag-${index}` })),
      });
      bulkTags.push(
        ...(
          await prisma.tag.findMany({
            where: { name: { startsWith: bulkKey } },
            orderBy: { id: 'asc' },
          })
        ).map((tag) => tag.id),
      );
      await prisma.tagOnPost.createMany({
        data: bulkTags.map((tagId, index) => ({ tagId, postId: posts[index].id })),
      });
      const result: SearchResponse = await service.list(
        { q: bulkKey, take: '100', skip: '100' },
        null,
      );
      expect(result.meta.total).toBe(1000);
      expect(result.data).toHaveLength(100);
      expect(result.data.map((post) => post.id)).toEqual(
        posts.slice(100, 200).map((post) => post.id),
      );
      expect(result.meta.facets.tags).toHaveLength(100);
      expect(result.meta.facetsTruncated.tags).toBe(true);
      expect(result.meta.facets.tags.every((tag) => tag.count === 1)).toBe(true);
      expect(result.meta.facets.categories.every((category) => category.count === 500)).toBe(true);
      expect(
        (await service.list({ q: bulkKey, tagIds: String(bulkTags[0]) }, null)).meta.total,
      ).toBe(1);
      const plan: { detail: string }[] =
        await prisma.$queryRaw`EXPLAIN QUERY PLAN SELECT postId FROM CategoryOnPost WHERE categoryId = ${categoryA}`;
      expect(plan.some((row) => row.detail.includes('CategoryOnPost_categoryId_postId_idx'))).toBe(
        true,
      );
    } finally {
      await prisma.categoryOnPost.deleteMany({
        where: { post: { title: { startsWith: bulkKey } } },
      });
      await prisma.post.deleteMany({ where: { title: { startsWith: bulkKey } } });
      await prisma.tag.deleteMany({ where: { id: { in: bulkTags } } });
    }
  });
  it('reflects service creates, edits and deletes in search metadata immediately', async () => {
    const mutationKey: string = `mutation-${Date.now()}`;
    const created = await service.create(
      {
        title: mutationKey,
        content: 'first',
        published: true,
        categoryIds: [categoryA],
        tags: [`${key}-mutation`],
      },
      owner,
    );
    expect((await service.list({ q: mutationKey }, null)).meta.total).toBe(1);
    await service.update(created.id, { published: false }, owner);
    expect((await service.list({ q: mutationKey }, null)).meta.total).toBe(0);
    expect((await service.list({ q: mutationKey }, owner)).meta.facets.statuses).toContainEqual({
      value: 'draft',
      count: 1,
    });
    await service.delete(created.id, owner);
    expect((await service.list({ q: mutationKey }, owner)).meta.total).toBe(0);
    expect(await prisma.tagOnPost.count({ where: { postId: created.id } })).toBe(0);
  });
  it('exposes the next publication boundary and invalidates content only after successful service writes', async () => {
    expect((await service.nextPublication())?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(await service.nextPublication(new Date('2100-01-01T00:00:00Z'))).toBeNull();
    let invalidations = 0;
    const tracked: PostService = new PostService(prisma, async (): Promise<void> => {
      invalidations++;
    });
    const post = await tracked.create(
      { title: 'invalidation', content: '', published: true },
      owner,
    );
    expect(invalidations).toBe(1);
    await expect(
      tracked.update(post.id, { categoryIds: [2147483647] }, owner),
    ).rejects.toMatchObject({ status: 400 });
    expect(invalidations).toBe(1);
    await tracked.update(post.id, { title: 'changed' }, owner);
    expect(invalidations).toBe(2);
    await tracked.delete(post.id, owner);
    expect(invalidations).toBe(3);
  });
});
