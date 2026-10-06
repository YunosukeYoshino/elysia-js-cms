import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CONTENT_REVISION_TRIGGERS, readContentRevision } from '../lib/content-revision';

it('maintains a transactional revision for every cached entity and refuses missing triggers', async () => {
  const directory: string = await mkdtemp(join(tmpdir(), 'cms-revision-test-'));
  const path: string = join(directory, 'revision.db');
  const database: Database = new Database(path);
  const client: PrismaClient = new PrismaClient({ datasourceUrl: `file:${path}` });
  const tables: string[] = [
    ...new Set(CONTENT_REVISION_TRIGGERS.map((name: string): string => name.split('_')[2])),
  ];
  try {
    for (const table of tables)
      database.exec(
        `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT)`,
      );
    database.exec(
      await Bun.file(
        new URL(
          '../../prisma/migrations/20261006190000_content_cache_revision/migration.sql',
          import.meta.url,
        ),
      ).text(),
    );
    expect(await readContentRevision(client)).toBe('0');
    let revision: number = 0;
    for (const table of tables) {
      database.exec(`INSERT INTO "${table}" (id, name) VALUES (1, 'before')`);
      expect(await readContentRevision(client)).toBe(String(++revision));
      database.exec(`UPDATE "${table}" SET name = 'after' WHERE id = 1`);
      expect(await readContentRevision(client)).toBe(String(++revision));
      database.exec(`DELETE FROM "${table}" WHERE id = 1`);
      expect(await readContentRevision(client)).toBe(String(++revision));
    }
    expect(() =>
      database.transaction(() => {
        database.exec('INSERT INTO Post (id) VALUES (2)');
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(await readContentRevision(client)).toBe(String(revision));
    database.exec('DROP TRIGGER cache_content_Post_update');
    expect(readContentRevision(client)).rejects.toThrow('unavailable or incomplete');
  } finally {
    await client.$disconnect();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses db-push databases that have a revision model but no transaction triggers', async () => {
  const directory: string = await mkdtemp(join(tmpdir(), 'cms-revision-unmigrated-'));
  const path: string = join(directory, 'revision.db');
  const database: Database = new Database(path);
  const client: PrismaClient = new PrismaClient({ datasourceUrl: `file:${path}` });
  try {
    database.exec(
      "CREATE TABLE CacheRevision (id TEXT PRIMARY KEY, version BIGINT); INSERT INTO CacheRevision VALUES ('content',0)",
    );
    expect(readContentRevision(client)).rejects.toThrow('unavailable or incomplete');
  } finally {
    await client.$disconnect();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
