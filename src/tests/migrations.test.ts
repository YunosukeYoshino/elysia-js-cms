import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const root: string = resolve(import.meta.dir, '../..');

it('deploys migration history and preserves a populated initial schema', async () => {
  const directory: string = mkdtempSync(join(tmpdir(), 'cms-migrations-'));
  const databasePath: string = join(directory, 'upgrade.db');
  const url: string = `file:${databasePath}`;
  let client: PrismaClient | undefined;
  try {
    const initial: string = join(directory, 'prisma');
    mkdirSync(join(initial, 'migrations'), { recursive: true });
    cpSync(
      join(root, 'prisma/migrations/20250313140408_init'),
      join(initial, 'migrations/20250313140408_init'),
      { recursive: true },
    );
    cpSync(
      join(root, 'prisma/migrations/migration_lock.toml'),
      join(initial, 'migrations/migration_lock.toml'),
    );
    writeFileSync(
      join(initial, 'schema.prisma'),
      `datasource db {\n provider = "sqlite"\n url = env("DATABASE_URL")\n}\n`,
    );
    const deploy = (schema: string): void => {
      const result = Bun.spawnSync(
        [process.execPath, 'prisma', 'migrate', 'deploy', '--schema', schema],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: url },
          timeout: 30000,
        },
      );
      expect(result.exitCode).toBe(0);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    deploy(join(initial, 'schema.prisma'));
    const db = new Database(databasePath);
    db.exec(`INSERT INTO User(id,email,password,name,role,updatedAt) VALUES(42,'migration@example.test','preserve-hash','Original','admin',CURRENT_TIMESTAMP);
      INSERT INTO Post(id,title,content,published,authorId,updatedAt) VALUES(73,'Existing','Keep',1,42,CURRENT_TIMESTAMP);`);
    db.close();
    deploy(join(root, 'prisma/schema.prisma'));
    deploy(join(root, 'prisma/schema.prisma'));
    client = new PrismaClient({ datasources: { db: { url } } });
    expect(await client.user.findUnique({ where: { id: 42 } })).toMatchObject({
      email: 'migration@example.test',
      password: 'preserve-hash',
      role: 'admin',
      loginAttempts: 0,
      lockedUntil: null,
    });
    expect(await client.post.findUnique({ where: { id: 73 } })).toMatchObject({
      title: 'Existing',
      content: 'Keep',
      authorId: 42,
    });
    await client.refreshToken.create({
      data: {
        token: 'migration-refresh-token',
        userId: 42,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    expect(await client.refreshToken.count()).toBe(1);
    // 最新スキーマと履歴全体の一致を検証し、後続マイグレーションの追加漏れも検出する。
    const diff = Bun.spawnSync(
      [
        process.execPath,
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        url,
        '--to-schema-datamodel',
        join(root, 'prisma/schema.prisma'),
        '--exit-code',
      ],
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, timeout: 30000 },
    );
    expect(diff.exitCode).toBe(0);
    if (diff.exitCode !== 0) throw new Error(diff.stdout.toString() + diff.stderr.toString());
  } finally {
    await client?.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
