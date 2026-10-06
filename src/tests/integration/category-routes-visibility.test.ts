import { expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import app from '../../index';
import { getJwtSecret } from '../../lib/jwt-config';
import prisma from '../../lib/prisma';
import { seedUser } from './helpers';

it('enforces publication and ownership for category posts in the composed application', async () => {
  const author = await seedUser(prisma, 'category-author');
  const other = await seedUser(prisma, 'category-other');
  const admin = await seedUser(prisma, 'category-admin', 'admin');
  const slug = 'visibility-' + crypto.randomUUID();
  const category = await prisma.category.create({ data: { name: slug, slug } });
  const created = await Promise.all([
    prisma.post.create({
      data: {
        title: 'Public',
        content: 'content',
        published: true,
        authorId: author.id,
        categories: { create: { categoryId: category.id } },
      },
    }),
    prisma.post.create({
      data: {
        title: 'Due',
        content: 'content',
        scheduledAt: new Date(Date.now() - 60000),
        authorId: author.id,
        categories: { create: { categoryId: category.id } },
      },
    }),
    prisma.post.create({
      data: {
        title: 'Draft',
        content: 'content',
        authorId: author.id,
        categories: { create: { categoryId: category.id } },
      },
    }),
    prisma.post.create({
      data: {
        title: 'Future',
        content: 'content',
        scheduledAt: new Date(Date.now() + 60000),
        authorId: author.id,
        categories: { create: { categoryId: category.id } },
      },
    }),
  ]);
  const sign = async (user: { id: number; role: string }): Promise<string> =>
    jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
      userId: user.id,
      role: user.role,
      type: 'access',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
  const get = async (
    token?: string,
    query: string = '',
  ): Promise<{
    response: Response;
    data: { data: Array<{ title: string }>; meta: { category: { id: number } } };
  }> => {
    const response = await app.handle(
      new Request(`http://localhost/api/categories/${category.id}/posts${query}`, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      }),
    );
    return { response, data: await response.json() };
  };
  try {
    for (const token of [undefined, await sign(other)]) {
      const result = await get(token);
      expect(result.response.status).toBe(200);
      expect(result.data.data.map((post) => post.title).sort()).toEqual(['Due', 'Public']);
      expect(result.data.meta.category.id).toBe(category.id);
    }
    for (const token of [await sign(author), await sign(admin)]) {
      expect((await get(token)).data.data).toHaveLength(4);
      expect(
        (await get(token, '?published=false')).data.data.map((post) => post.title).sort(),
      ).toEqual(['Draft', 'Future']);
    }
    expect((await get(undefined, '?published=invalid')).response.status).toBe(422);
  } finally {
    await prisma.categoryOnPost.deleteMany({ where: { categoryId: category.id } });
    await prisma.post.deleteMany({ where: { id: { in: created.map((post) => post.id) } } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.user.deleteMany({ where: { id: { in: [author.id, other.id, admin.id] } } });
  }
});
