import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import type { Post, User } from '@prisma/client';
import app from '../index';
import { getJwtSecret } from '../lib/jwt-config';
import { formatPost, postInclude } from '../lib/post-search';
import prisma from '../lib/prisma';
import type { PostService } from '../services/post-service';

type ContentResponse = Awaited<ReturnType<PostService['getById']>>;
type ListResponse = Awaited<ReturnType<PostService['list']>>;

interface Viewer {
  label: string;
  user: User | null;
  token: string;
  visibleIds: number[];
}

describe('Privacy-safe content authors', () => {
  const key: string = `author-privacy-${crypto.randomUUID()}`;
  const users: User[] = [];
  const posts: Post[] = [];
  const viewers: Viewer[] = [];
  let owner: User;
  let categoryId: number = 0;
  let tagId: number = 0;

  const request = (path: string, token: string = ''): Promise<Response> =>
    app.handle(
      new Request(`http://localhost/api${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    );

  const expectMinimalAuthor = (author: ContentResponse['author']): void => {
    const user: User | undefined = users.find(
      (candidate: User): boolean => candidate.id === author.id,
    );
    if (!user) throw new Error('Unexpected fixture author');
    expect(author).toEqual({ id: user.id, name: user.name });
  };

  const readContent = async <T>(response: Response): Promise<T> => {
    expect(response.status).toBe(200);
    const text: string = await response.text();
    for (const user of users) {
      expect(text).not.toContain(user.email);
      expect(text).not.toContain(user.password);
    }
    expect(text).not.toContain('"email"');
    expect(text).not.toContain('"password"');
    expect(text).not.toContain('"role"');
    return JSON.parse(text);
  };

  const expectList = (result: ListResponse, viewer: Viewer): void => {
    expect(
      result.data.map((post): number => post.id).sort((a: number, b: number): number => a - b),
    ).toEqual([...viewer.visibleIds].sort((a: number, b: number): number => a - b));
    expect(result.meta.total).toBe(viewer.visibleIds.length);
    for (const post of result.data) expectMinimalAuthor(post.author);
    const visiblePosts: Post[] = posts.filter((post: Post): boolean =>
      viewer.visibleIds.includes(post.id),
    );
    const expectedAuthors: { id: number; name: string | null; count: number }[] = users
      .map((user: User) => ({
        id: user.id,
        name: user.name,
        count: visiblePosts.filter((post: Post): boolean => post.authorId === user.id).length,
      }))
      .filter((author): boolean => author.count > 0)
      .sort((a, b): number => b.count - a.count || a.id - b.id);
    expect(result.meta.facets.authors).toEqual(expectedAuthors);
    expect(result.meta.filterOptions.authors).toEqual(
      expectedAuthors.map(({ id, name }) => ({ id, name })),
    );
  };

  beforeAll(async () => {
    const makeUser = async (name: string | null, role: string = 'user'): Promise<User> => {
      const user: User = await prisma.user.create({
        data: {
          email: `${key}-${users.length}@example.invalid`,
          password: 'private-fixture-password',
          name,
          role,
        },
      });
      users.push(user);
      return user;
    };
    owner = await makeUser('Content owner');
    const other: User = await makeUser(null);
    const admin: User = await makeUser('Administrator', 'admin');
    categoryId = (await prisma.category.create({ data: { name: key, slug: key } })).id;
    tagId = (await prisma.tag.create({ data: { name: key } })).id;
    for (const fixture of [
      { authorId: owner.id, published: true, scheduledAt: null },
      { authorId: owner.id, published: false, scheduledAt: null },
      { authorId: owner.id, published: false, scheduledAt: new Date('2099-01-01T00:00:00Z') },
      { authorId: other.id, published: false, scheduledAt: null },
    ]) {
      posts.push(
        await prisma.post.create({
          data: {
            ...fixture,
            title: `${key} post ${posts.length}`,
            content: key,
            categories: { create: { categoryId } },
            tags: { create: { tagId } },
          },
        }),
      );
    }
    for (const [label, user] of [
      ['anonymous', null],
      ['ordinary author', owner],
      ['another author', other],
      ['administrator', admin],
    ] as const) {
      viewers.push({
        label,
        user,
        token: user
          ? await jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
              userId: user.id,
              type: 'access',
              exp: Math.floor(Date.now() / 1000) + 600,
            })
          : '',
        visibleIds: posts
          .filter(
            (post: Post): boolean =>
              post.published || user?.role === 'admin' || post.authorId === user?.id,
          )
          .map((post: Post): number => post.id),
      });
    }
  });

  afterAll(async () => {
    const userIds: number[] = users.map((user: User): number => user.id);
    await prisma.categoryOnPost.deleteMany({ where: { categoryId } });
    await prisma.post.deleteMany({ where: { authorId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.tag.deleteMany({ where: { id: tagId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('selects only public author fields and strips extra fields from a broader database result', async () => {
    expect(postInclude.author.select).toEqual({ id: true, name: true });
    const expanded = await prisma.post.findUniqueOrThrow({
      where: { id: posts[0].id },
      include: {
        author: true,
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
      },
    });
    expect(expanded.author.email).toBe(owner.email);
    expectMinimalAuthor(formatPost(expanded).author);
  });

  it('keeps list, category, search and facet authors minimal for every viewer and visibility', async () => {
    for (const viewer of viewers) {
      for (const path of [
        `/posts?categoryId=${categoryId}`,
        `/posts?q=${key}`,
        `/categories/${categoryId}/posts`,
        `/categories/${categoryId}/posts?q=${key}`,
      ]) {
        const result: ListResponse = await readContent(await request(path, viewer.token));
        expectList(result, viewer);
      }
    }
  });

  it('keeps detail authors minimal while preserving private-post access restrictions', async () => {
    for (const viewer of viewers) {
      for (const post of posts) {
        const response: Response = await request(`/posts/${post.id}`, viewer.token);
        if (viewer.visibleIds.includes(post.id)) {
          const result: ContentResponse = await readContent(response);
          expect(result.id).toBe(post.id);
          expectMinimalAuthor(result.author);
        } else {
          expect(response.status, `${viewer.label}: ${post.id}`).toBe(404);
        }
      }
    }
  });

  it('preserves each authenticated user email in their own account profile only', async () => {
    for (const viewer of viewers) {
      const response: Response = await request('/auth/me', viewer.token);
      if (!viewer.user) {
        expect(response.status).toBe(401);
        continue;
      }
      expect(response.status).toBe(200);
      const result: { user: { id: number; email: string; name: string | null; role: string } } =
        await response.json();
      expect(result.user).toEqual({
        id: viewer.user.id,
        email: viewer.user.email,
        name: viewer.user.name,
        role: viewer.user.role,
      });
    }
  });

  it('returns the same minimal author from authenticated create and update responses', async () => {
    const author: Viewer | undefined = viewers.find(
      (viewer: Viewer): boolean => viewer.user?.id === owner.id,
    );
    const administrator: Viewer | undefined = viewers.find(
      (viewer: Viewer): boolean => viewer.user?.role === 'admin',
    );
    if (!author || !administrator) throw new Error('Missing authenticated fixture');
    const write = (method: string, path: string, token: string, body: object): Promise<Response> =>
      app.handle(
        new Request(`http://localhost/api/posts${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
      );
    const created: ContentResponse = await readContent(
      await write('POST', '/', author.token, { title: key, content: key }),
    );
    expectMinimalAuthor(created.author);
    for (const viewer of [author, administrator]) {
      const updated: ContentResponse = await readContent(
        await write('PUT', `/${created.id}`, viewer.token, { content: `${key} updated` }),
      );
      expectMinimalAuthor(updated.author);
    }
  });
});
