import { expect, it } from 'bun:test';
import app from '../index';
import prisma from '../lib/prisma';
import { hierarchicalRateLimiter } from '../lib/rate-limit-policy';

it('validates both post pagination routes before querying Prisma', async () => {
  await import('../scripts/prepare-db').then((m) => m.default('test'));
  const unique: string = `pagination-${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${unique}@example.com`, password: 'fixture-only' },
  });
  const category = await prisma.category.create({ data: { name: unique, slug: unique } });
  try {
    for (let i = 0; i < 3; i++)
      await prisma.post.create({
        data: {
          title: `page-${i}`,
          content: 'fixture',
          published: true,
          authorId: user.id,
          createdAt: new Date(2020, 0, i + 1),
          categories: { create: { categoryId: category.id } },
        },
      });
    for (const path of [
      `/api/posts?authorId=${user.id}&`,
      `/api/categories/${category.id}/posts?`,
    ]) {
      const get = async (query: Record<string, string> = {}): Promise<Response> => {
        // 入力検証の各ケースは独立した時間窓として扱う。攻撃時の枠は別テストで検証する。
        await hierarchicalRateLimiter.destroy();
        return app.handle(new Request(`http://localhost${path}${new URLSearchParams(query)}`));
      };
      const defaults = await get();
      expect(defaults.status).toBe(200);
      const initial = await defaults.json();
      expect(initial.meta).toMatchObject({ take: 10, skip: 0, total: 3 });
      expect(initial.data).toHaveLength(3);
      const page = await get({ take: '1', skip: '1' });
      expect(page.status).toBe(200);
      const body = await page.json();
      expect(body.meta).toMatchObject({ take: 1, skip: 1, total: 3 });
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('page-1');
      for (const [take, skip, length] of [
        ['0', '0', 0],
        ['-1', '0', 1],
        ['9007199254740991', '0', 3],
        ['1', '9007199254740991', 0],
        ['01', '00', 1],
      ] as const) {
        const response = await get({ take, skip });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.meta).toMatchObject({ take: Number(take), skip: Number(skip), total: 3 });
        expect(result.data).toHaveLength(length);
      }
      for (const key of ['take', 'skip'])
        for (const value of [
          '2\n',
          '\t2',
          'abc',
          '2abc',
          '2.9',
          '',
          ' ',
          'Infinity',
          'NaN',
          '9007199254740992',
          '1e2',
          '0x10',
        ]) {
          expect((await get({ [key]: value })).status).toBe(422);
        }
      expect((await get({ skip: '-1' })).status).toBe(422);
    }
  } finally {
    await prisma.categoryOnPost.deleteMany({ where: { categoryId: category.id } });
    await prisma.post.deleteMany({ where: { authorId: user.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
