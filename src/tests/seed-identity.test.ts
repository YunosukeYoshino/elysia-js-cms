import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Row = Record<string, string | number | null>;
interface SeedFixture {
  db: Database;
  run: () => Bun.SyncSubprocess<'pipe', 'pipe'>;
}

/** 本番・リポジトリ内のDBを使わず、破棄可能な専用SQLiteで検証する。 */
function withFixture(check: (fixture: SeedFixture) => void, oldSchema: boolean = false): void {
  const dir: string = mkdtempSync(join(tmpdir(), 'cms-seed-identity-'));
  const path: string = join(dir, 'seed.db');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    ALLOW_DEMO_SEED: 'true',
    JWT_SECRET: 'cms-seed-test-secret-32-characters-minimum',
    PEPPER_SECRET: '',
    DATABASE_URL: `file:${path}`,
  };
  try {
    const args: string[] = ['prisma', 'db', 'push', '--skip-generate'];
    if (oldSchema) {
      const schema: string = readFileSync('prisma/schema.prisma', 'utf8').replace(
        /^.*demoSeedKey.*\n/gm,
        '',
      );
      const schemaPath: string = join(dir, 'before.prisma');
      writeFileSync(schemaPath, schema);
      args.push('--schema', schemaPath);
    }
    const setup = Bun.spawnSync([process.execPath, ...args], { env, timeout: 10000 });
    if (setup.exitCode !== 0) throw new Error(setup.stderr.toString());
    const db: Database = new Database(path);
    try {
      check({
        db,
        run: (): Bun.SyncSubprocess<'pipe', 'pipe'> =>
          Bun.spawnSync([process.execPath, 'run', 'seed'], { env, timeout: 10000 }),
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ロールバック時には関連と採番状態も変化していないことを確認する。 */
function snapshot(db: Database): string {
  return JSON.stringify(
    ['User', 'Post', 'Category', 'CategoryOnPost', 'sqlite_sequence'].map((table: string) =>
      db.query<Row, []>(`SELECT * FROM "${table}" ORDER BY 1, 2`).all(),
    ),
  );
}

/** シードと無関係な既存ユーザーを用意する。 */
function insertRealUser(db: Database, email: string = 'existing@example.com'): void {
  db.run(
    "INSERT INTO User(id,email,password,name,role,updatedAt) VALUES(1,?,'bun:v1:preserved-real-hash','既存ユーザー','editor',CURRENT_TIMESTAMP)",
    [email],
  );
}

/** 更新されてはいけない既存投稿を用意する。 */
function insertRealPost(db: Database, id: number, title: string = '既存の投稿'): void {
  db.run(
    "INSERT INTO Post(id,title,content,published,authorId,updatedAt) VALUES(?,?,'変更禁止の本文',1,1,CURRENT_TIMESTAMP)",
    [id, title],
  );
}

it('keeps unrelated rows and high-sequence databases unchanged across repeated seeds', () => {
  withFixture(({ db, run }: SeedFixture): void => {
    insertRealUser(db);
    for (const id of [1, 2, 3, 4, 100]) insertRealPost(db, id, 'ElysiaJSによるAPIの構築');
    db.run('DELETE FROM Post WHERE id=100');
    db.run(
      "INSERT INTO Category(id,name,slug,updatedAt) VALUES(40,'既存カテゴリ','technology',CURRENT_TIMESTAMP)",
    );
    db.run('INSERT INTO CategoryOnPost(postId,categoryId) VALUES(1,40)');
    const realUsers: Row[] = db.query<Row, []>('SELECT * FROM User').all();
    const realPosts: Row[] = db.query<Row, []>('SELECT * FROM Post ORDER BY id').all();
    const realCategories: Row[] = db.query<Row, []>('SELECT * FROM Category').all();
    const realRelations: Row[] = db.query<Row, []>('SELECT * FROM CategoryOnPost').all();

    const first = run();
    if (first.exitCode !== 0) throw new Error(first.stderr.toString());
    expect(db.query<Row, []>('SELECT * FROM User WHERE demoSeedKey IS NULL').all()).toEqual(
      realUsers,
    );
    expect(
      db.query<Row, []>('SELECT * FROM Post WHERE demoSeedKey IS NULL ORDER BY id').all(),
    ).toEqual(realPosts);
    expect(db.query<Row, []>('SELECT * FROM Category WHERE id=40').all()).toEqual(realCategories);
    expect(db.query<Row, []>('SELECT * FROM CategoryOnPost WHERE postId<=4').all()).toEqual(
      realRelations,
    );
    expect(db.query('SELECT COUNT(*) AS count FROM Post WHERE id>100').get()).toEqual({ count: 4 });
    expect(
      db.query('SELECT COUNT(*) AS count FROM User WHERE demoSeedKey IS NOT NULL').get(),
    ).toEqual({ count: 2 });
    const seeded: string = snapshot(db);
    expect(run().exitCode).toBe(0);
    expect(snapshot(db)).toBe(seeded);

    db.run(
      "UPDATE User SET password='bun:v1:changed-demo-hash',role='editor',name='変更済み' WHERE demoSeedKey='cms-demo:v1:admin'",
    );
    db.run(
      "UPDATE Post SET title='変更済み',content='変更済み',published=0 WHERE demoSeedKey='cms-demo:v1:elysia-api'",
    );
    const edited: string = snapshot(db);
    expect(run().exitCode).toBe(0);
    expect(snapshot(db)).toBe(edited);
  });
}, 30000);

for (const email of ['admin@example.com', 'user@example.com']) {
  it(`refuses to adopt ${email} and rolls back all seed writes`, () => {
    withFixture(({ db, run }: SeedFixture): void => {
      insertRealUser(db, email);
      insertRealPost(db, 1);
      const before: string = snapshot(db);
      for (let attempt: number = 0; attempt < 2; attempt += 1) {
        const result = run();
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain('refuses to adopt an unmarked existing user');
        expect(result.stdout.toString()).not.toContain('シード処理が完了しました');
        expect(snapshot(db)).toBe(before);
      }
    });
  }, 30000);
}

it('rolls back partial categories when an unrelated unique name collides', () => {
  withFixture(({ db, run }: SeedFixture): void => {
    insertRealUser(db);
    db.run(
      "INSERT INTO Category(name,slug,updatedAt) VALUES('デザイン','existing-design',CURRENT_TIMESTAMP)",
    );
    const before: string = snapshot(db);
    expect(run().exitCode).not.toBe(0);
    expect(snapshot(db)).toBe(before);
  });
}, 30000);

it('upgrades populated databases without claiming or modifying old rows', () => {
  withFixture(({ db, run }: SeedFixture): void => {
    insertRealUser(db, 'admin@example.com');
    insertRealPost(db, 1, 'ElysiaJSによるAPIの構築');
    const userBefore: Row | null = db.query<Row, []>('SELECT * FROM User').get();
    const postBefore: Row | null = db.query<Row, []>('SELECT * FROM Post').get();
    db.exec(
      readFileSync('prisma/migrations/20261006181600_add_demo_seed_identity/migration.sql', 'utf8'),
    );
    expect(db.prepare<Row, []>('SELECT * FROM User').get()).toEqual({
      ...userBefore,
      demoSeedKey: null,
    });
    expect(db.prepare<Row, []>('SELECT * FROM Post').get()).toEqual({
      ...postBefore,
      demoSeedKey: null,
    });
    insertRealPost(db, 100);
    const upgraded: string = snapshot(db);
    expect(run().exitCode).not.toBe(0);
    expect(snapshot(db)).toBe(upgraded);

    db.run("UPDATE User SET email='existing@example.com' WHERE id=1");
    expect(run().exitCode).toBe(0);
    const seeded: string = snapshot(db);
    expect(run().exitCode).toBe(0);
    expect(snapshot(db)).toBe(seeded);
    expect(db.query('SELECT COUNT(*) AS count FROM Post WHERE demoSeedKey IS NULL').get()).toEqual({
      count: 2,
    });
    expect(
      db.query('SELECT COUNT(*) AS count FROM Post WHERE demoSeedKey IS NOT NULL').get(),
    ).toEqual({ count: 4 });
  }, true);
}, 30000);
