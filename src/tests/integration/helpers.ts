import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient, type User } from '@prisma/client';

export interface TestDatabase {
  directory: string;
  database: PrismaClient;
  close(): Promise<void>;
}

/** 各スイート専用 DB を作る。既存 DATABASE_URL の DB は一切操作しない。 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'cms-service-test-'));
  const url = 'file:' + join(directory, 'isolated.db');
  const child = Bun.spawn(
    [
      process.execPath,
      resolve('node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      resolve('prisma/schema.prisma'),
    ],
    {
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Failed to create isolated test schema: ' + stdout + stderr);
  }
  const database = new PrismaClient({ datasourceUrl: url });
  await database.$connect();
  return {
    directory,
    database,
    close: async (): Promise<void> => {
      await database.$disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** 一意で再現可能なテストユーザーを生成する。実ユーザー情報を使用しない。 */
export async function seedUser(
  database: PrismaClient,
  prefix: string = 'fixture',
  role: string = 'user',
): Promise<User> {
  return database.user.create({
    data: {
      email: prefix + '-' + crypto.randomUUID() + '@example.invalid',
      password: 'fixture-password-not-for-login',
      name: prefix,
      role,
    },
  });
}

/** 複数カテゴリと関連投稿をまとめて作る負荷テスト用の生成器。 */
export async function seedPosts(
  database: PrismaClient,
  authorId: number,
  categoryId: number,
  count: number,
): Promise<void> {
  await database.$transaction(
    async (tx) => {
      for (let index = 0; index < count; index++) {
        await tx.post.create({
          data: {
            title: 'Generated post ' + index,
            content: 'Generated content ' + index,
            published: index % 2 === 0,
            authorId,
            categories: { create: { categoryId } },
          },
        });
      }
    },
    { timeout: 30000 },
  );
}
