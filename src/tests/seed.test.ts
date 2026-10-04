import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('seeds SQLite twice without duplicate relations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cms-seed-'));
  const path = join(dir, 'seed.db');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:' + path };
  try {
    for (const args of [
      ['prisma', 'db', 'push', '--skip-generate'],
      ['run', 'seed'],
      ['run', 'seed'],
    ]) {
      const result = Bun.spawnSync([process.execPath, ...args], { env, timeout: 10000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    const db = new Database(path, { readonly: true });
    try {
      for (const [table, total] of [
        ['User', 2],
        ['Category', 5],
        ['Post', 4],
        ['CategoryOnPost', 8],
      ] as const) {
        expect(db.query('SELECT COUNT(*) AS total FROM ' + table).get()).toEqual({ total });
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
