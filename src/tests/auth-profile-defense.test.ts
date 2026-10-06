import { afterAll, beforeAll, expect, it } from 'bun:test';
import { getAuthenticatedUser } from '../lib/auth-cache';
import prisma from '../lib/prisma';
import { MemoryCacheStore, SharedCache } from '../lib/shared-cache';

let userId: number = 0;
const email: string = `auth-defense-${crypto.randomUUID()}@example.com`;
beforeAll(async () => {
  await import('../scripts/prepare-db').then((module) => module.default('test'));
  userId = (await prisma.user.create({ data: { email, password: 'not-cached', role: 'admin' } }))
    .id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
});

it('never returns unexpected password, token, or extra fields from poisoned cache values', async () => {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const isolated: SharedCache = new SharedCache(new MemoryCacheStore());
  const poisoned = {
    version: current.updatedAt.getTime(),
    user: {
      id: userId,
      email,
      name: current.name,
      role: current.role,
      password: 'secret',
      token: 'secret',
      unexpected: true,
    },
  };
  const expected = { id: userId, email, name: current.name, role: current.role };
  await isolated.fillAuthLocal(String(userId), poisoned);
  expect(await getAuthenticatedUser(userId, isolated)).toEqual(expected);
  await isolated.invalidate('auth');
  const lookup = await isolated.lookup(
    'auth',
    String(userId),
    (value: unknown): value is string => typeof value === 'string',
  );
  if (!lookup.token) throw new Error('Missing test cache token');
  await isolated.fill(lookup.token, poisoned, 300000);
  expect(await getAuthenticatedUser(userId, isolated)).toEqual(expected);
  await isolated.destroy();
});
