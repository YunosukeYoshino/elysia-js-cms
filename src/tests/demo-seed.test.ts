import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDemoSeedEnvironment } from '../lib/demo-seed';

const secret: string = 'cms-seed-test-secret-32-characters-minimum';
const valid: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  ALLOW_DEMO_SEED: 'true',
  DATABASE_URL: 'file:demo.db',
  JWT_SECRET: secret,
  PEPPER_SECRET: '',
};
for (const patch of [
  { NODE_ENV: 'production' },
  { NODE_ENV: '' },
  { NODE_ENV: 'staging' },
  { ALLOW_DEMO_SEED: '' },
  { DATABASE_URL: '' },
  { DATABASE_URL: 'postgres://example/db' },
  { DATABASE_URL: 'file:' },
  { DATABASE_URL: 'file:?mode=memory' },
  { JWT_SECRET: '' },
  { JWT_SECRET: ' '.repeat(40) },
  { JWT_SECRET: 'default-secret-for-testing-please-change-in-prod' },
] as NodeJS.ProcessEnv[]) {
  it(`rejects unsafe seed configuration: ${Object.keys(patch).join(',')}`, () => {
    expect(() => assertDemoSeedEnvironment({ ...valid, ...patch })).toThrow();
  });
}
it('allows only explicit local development or test seed settings', () => {
  expect(() => assertDemoSeedEnvironment(valid)).not.toThrow();
  expect(() =>
    assertDemoSeedEnvironment({
      ...valid,
      NODE_ENV: 'development',
      JWT_SECRET: '',
      PEPPER_SECRET: secret,
    }),
  ).not.toThrow();
  expect(() =>
    assertDemoSeedEnvironment({
      ...valid,
      JWT_SECRET: 'your-secret-key-for-jwt-tokens',
      PEPPER_SECRET: secret,
    }),
  ).not.toThrow();
});

it('hashes demo credentials and refuses unsafe runs without writes', () => {
  const dir: string = mkdtempSync(join(tmpdir(), 'cms-seed-safety-'));
  const path: string = join(dir, 'seed.db');
  const env: NodeJS.ProcessEnv = { ...process.env, ...valid, DATABASE_URL: `file:${path}` };
  const run = (extra: NodeJS.ProcessEnv = {}): Bun.SyncSubprocess<'pipe', 'pipe'> =>
    Bun.spawnSync([process.execPath, 'run', 'seed'], { env: { ...env, ...extra }, timeout: 10000 });
  try {
    const setup = Bun.spawnSync([process.execPath, 'prisma', 'db', 'push', '--skip-generate'], {
      env,
      timeout: 10000,
    });
    expect(setup.exitCode).toBe(0);
    const first = run();
    expect(first.exitCode).toBe(0);
    const db: Database = new Database(path);
    try {
      const users = db.query<{ email: string; password: string; role: string }, []>(
        'SELECT email,password,role FROM User ORDER BY email',
      );
      const original = users.all();
      expect(original).toHaveLength(2);
      for (const user of original) {
        expect(user.password.startsWith('bun:v1:$argon2id$')).toBe(true);
        expect(first.stdout.toString()).not.toContain(user.password);
        expect(first.stderr.toString()).not.toContain(user.password);
      }
      expect(first.stdout.toString()).not.toContain(secret);
      expect(run().exitCode).toBe(0);
      expect(users.all()).toEqual(original);
      const verify = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          "import p from './src/lib/prisma'; import {verifyPassword} from './src/lib/password'; const rows=await p.user.findMany({orderBy:{email:'asc'}}); console.log(JSON.stringify(await Promise.all(rows.map(async u=>[await verifyPassword(u.email==='admin@example.com'?'DemoRoot-Only42!':'DemoUser-Only42!',u.password),await verifyPassword('incorrect',u.password)])))); await p.$disconnect();",
        ],
        { env, timeout: 10000 },
      );
      expect(verify.exitCode).toBe(0);
      expect(JSON.parse(verify.stdout.toString())).toEqual([
        [true, false],
        [true, false],
      ]);
      db.run(
        "UPDATE User SET password='preserved-existing-value',role='editor' WHERE email='admin@example.com'",
      );
      const preserved = users.all();
      expect(run().exitCode).toBe(0);
      expect(users.all()).toEqual(preserved);
      const before: string = readFileSync(path).toString('hex');
      for (const bad of [
        { NODE_ENV: 'production' },
        { NODE_ENV: '' },
        { ALLOW_DEMO_SEED: '' },
        { JWT_SECRET: '' },
      ]) {
        expect(run(bad).exitCode).not.toBe(0);
        expect(readFileSync(path).toString('hex')).toEqual(before);
      }
      const missing: string = join(dir, 'missing.db');
      expect(run({ NODE_ENV: 'production', DATABASE_URL: `file:${missing}` }).exitCode).not.toBe(0);
      expect(existsSync(missing)).toBe(false);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
