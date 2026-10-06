import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CategoryService } from '../../domain/services/category-service';
import { createTestDatabase, seedPosts, seedUser, type TestDatabase } from './helpers';

describe('CategoryService isolated database integration', () => {
  let fixture: TestDatabase;
  let service: CategoryService;
  beforeAll(async () => {
    fixture = await createTestDatabase();
    service = new CategoryService(fixture.database);
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('creates, lists, reads, updates and deletes categories', async () => {
    const category = await service.create({ name: 'Lifecycle', slug: 'lifecycle' });
    expect(await service.getById(category.id)).toEqual(category);
    expect((await service.list()).some((entry) => entry.id === category.id)).toBe(true);
    expect((await service.update(category.id, { name: 'Renamed', slug: 'renamed' })).slug).toBe(
      'renamed',
    );
    expect(await service.delete(category.id)).toEqual({ message: 'カテゴリを削除しました' });
    await expect(service.getById(category.id)).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
      status: 404,
    });
  });

  it('rejects invalid IDs, missing mutations, duplicate names and simultaneous duplicate slugs', async () => {
    await expect(service.getById(0)).rejects.toMatchObject({
      code: 'INVALID_CATEGORY_ID',
      status: 422,
    });
    await expect(service.update(9999999, {})).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
    await expect(service.delete(9999999)).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
    const attempts = await Promise.allSettled([
      service.create({ name: 'Duplicate A', slug: 'duplicate' }),
      service.create({ name: 'Duplicate B', slug: 'duplicate' }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const other = await service.create({ name: 'Other', slug: 'other' });
    await expect(service.update(other.id, { slug: 'duplicate' })).rejects.toMatchObject({
      code: 'CATEGORY_EXISTS',
      status: 400,
    });
    await expect(service.create({ name: 'Other', slug: 'different' })).rejects.toMatchObject({
      code: 'CATEGORY_EXISTS',
    });
  });

  it('preserves category and posts when linked, and deletes after unlinking', async () => {
    const user = await seedUser(fixture.database);
    const category = await service.create({ name: 'Dependency', slug: 'dependency' });
    await seedPosts(fixture.database, user.id, category.id, 2);
    await expect(service.delete(category.id)).rejects.toMatchObject({
      code: 'CATEGORY_IN_USE',
      status: 400,
    });
    expect(
      await fixture.database.categoryOnPost.count({ where: { categoryId: category.id } }),
    ).toBe(2);
    await fixture.database.categoryOnPost.deleteMany({ where: { categoryId: category.id } });
    await service.delete(category.id);
    expect(await fixture.database.post.count({ where: { authorId: user.id } })).toBe(2);
  });

  it('rolls back dependency checks when DB deletion fails and does not leak storage errors', async () => {
    const category = await service.create({ name: 'Failure', slug: 'failure' });
    await fixture.database.$executeRawUnsafe(
      "CREATE TRIGGER category_delete_failure BEFORE DELETE ON Category WHEN OLD.slug = 'failure' BEGIN SELECT RAISE(ABORT, 'private failure'); END",
    );
    try {
      await expect(service.delete(category.id)).rejects.toMatchObject({
        code: 'CATEGORY_IN_USE',
        status: 400,
      });
    } finally {
      await fixture.database.$executeRawUnsafe('DROP TRIGGER category_delete_failure');
    }
    expect(await service.getById(category.id)).toEqual(category);
  });

  it('handles 1,000 dependent posts without loading the whole relationship into memory', async () => {
    const user = await seedUser(fixture.database, 'large');
    const category = await service.create({ name: 'Large Dataset', slug: 'large' });
    await seedPosts(fixture.database, user.id, category.id, 1000);
    const started = performance.now();
    for (let index = 0; index < 100; index++)
      await expect(service.delete(category.id)).rejects.toMatchObject({ code: 'CATEGORY_IN_USE' });
    expect(
      await fixture.database.categoryOnPost.count({ where: { categoryId: category.id } }),
    ).toBe(1000);
    expect(performance.now() - started).toBeLessThan(10000);
  });
});

it('notifies cache invalidation only after committed category mutations', async () => {
  const fixture = await createTestDatabase();
  let invalidations = 0;
  const service = new CategoryService(fixture.database, async () => {
    invalidations++;
  });
  try {
    const category = await service.create({ name: 'Invalidation', slug: 'invalidation' });
    await service.update(category.id, { name: 'Changed' });
    await expect(service.create({ name: 'Duplicate', slug: 'invalidation' })).rejects.toThrow();
    expect(invalidations).toBe(2);
    await service.delete(category.id);
    expect(invalidations).toBe(3);
  } finally {
    await fixture.close();
  }
});
