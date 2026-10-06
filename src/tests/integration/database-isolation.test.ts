import { expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import prisma from '../../lib/prisma';
import prepareDatabase from '../../scripts/prepare-db';

it('prepares repeatedly without dropping data from active Prisma connections', async () => {
  const email = 'keep-existing-' + crypto.randomUUID() + '@example.invalid';
  const user = await prisma.user.create({ data: { email, password: 'fixture-only' } });
  try {
    await prepareDatabase('test');
    await prepareDatabase('test');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(email);
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

it('ignores an ordinary database URL and never removes an unrelated cwd test.db', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cms-isolation-sentinel-'));
  const sentinel = join(directory, 'test.db');
  await writeFile(sentinel, 'untouched database sentinel');
  const modulePath = resolve('src/scripts/prepare-db.ts');
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { configureTestDatabase } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(configureTestDatabase()));`,
    ],
    {
      cwd: directory,
      env: { ...process.env, DATABASE_URL: 'file:' + sentinel, CMS_TEST_DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  try {
    const [status, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(status).toBe(0);
    const result: { url: string; ownedDirectory?: string } = JSON.parse(text);
    expect(result.url).not.toBe('file:' + sentinel);
    expect(result.ownedDirectory).toContain('cms-test-run-');
    expect(await readFile(sentinel, 'utf8')).toBe('untouched database sentinel');
    if (result.ownedDirectory) await rm(result.ownedDirectory, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses explicit non-disposable test URL configuration before running Prisma', async () => {
  const modulePath = resolve('src/scripts/prepare-db.ts');
  for (const url of [
    'file:./test.db',
    'file:/var/data/production.db',
    'postgres://example.invalid/cms',
  ]) {
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { configureTestDatabase } from ${JSON.stringify(modulePath)}; configureTestDatabase();`,
      ],
      {
        env: { ...process.env, CMS_TEST_DATABASE_URL: url },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain('must point to a disposable');
  }
});

it('overrides inherited production settings before application imports and child env loading', async () => {
  const directory: string = await mkdtemp(join(tmpdir(), 'cms-preload-isolation-'));
  const sentinel: string = join(directory, 'production.db');
  const envFile: string = join(directory, '.env');
  const source: string = `
    import app from ${JSON.stringify(resolve('src/index.ts'))};
    import { sharedCache } from ${JSON.stringify(resolve('src/lib/shared-cache.ts'))};
    import { getJwtSecret } from ${JSON.stringify(resolve('src/lib/jwt-config.ts'))};
    import prisma from ${JSON.stringify(resolve('src/lib/prisma.ts'))};
    const nested = Bun.spawnSync([process.execPath, '-e', 'console.log(JSON.stringify({ redis: process.env.REDIS_URL, policy: process.env.RATE_LIMIT_POLICY, pepper: process.env.PEPPER_SECRET }))'], {
      cwd: ${JSON.stringify(directory)}, env: process.env, timeout: 30000,
    });
    if (nested.exitCode !== 0) throw new Error(nested.stderr.toString());
    console.log('ISOLATION_RESULT=' + JSON.stringify({
      mode: process.env.NODE_ENV, jwt: getJwtSecret(), pepper: process.env.PEPPER_SECRET,
      redis: process.env.REDIS_URL, policy: process.env.RATE_LIMIT_POLICY,
      database: process.env.DATABASE_URL, backend: sharedCache.stats().backend,
      status: (await app.handle(new Request('http://localhost/'))).status,
      nested: JSON.parse(nested.stdout.toString()),
    }));
    await sharedCache.destroy();
    await prisma.$disconnect();
  `;
  try {
    await writeFile(sentinel, 'untouched production sentinel');
    await writeFile(
      envFile,
      'REDIS_URL=redis://127.0.0.1:1\nRATE_LIMIT_POLICY=production-policy-sentinel\nPEPPER_SECRET=production-pepper-sentinel\n',
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--env-file',
        envFile,
        '--preload',
        resolve('src/tests/setup.ts'),
        '-e',
        source,
      ],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: 'file:' + sentinel,
          CMS_TEST_DATABASE_URL: '',
          JWT_SECRET: 'production-jwt-sentinel-never-use-for-tests',
          PEPPER_SECRET: 'production-pepper-sentinel',
          REDIS_URL: 'redis://127.0.0.1:1',
          RATE_LIMIT_POLICY: 'production-policy-sentinel',
        },
        timeout: 30000,
      },
    );
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const line: string | undefined = result.stdout
      .toString()
      .split('\n')
      .find((entry: string): boolean => entry.startsWith('ISOLATION_RESULT='));
    if (!line) throw new Error('Missing preload isolation result');
    const actual: { database: string } = JSON.parse(line.slice('ISOLATION_RESULT='.length));
    expect(actual).toMatchObject({
      mode: 'test',
      jwt: 'test-secret-key-for-testing-only',
      pepper: '',
      redis: '',
      policy: '',
      backend: 'memory',
      status: 200,
      nested: { redis: '', policy: '', pepper: '' },
    });
    expect(actual.database).not.toBe('file:' + sentinel);
    expect(actual.database).toContain('cms-test-run-');
    expect(await readFile(sentinel, 'utf8')).toBe('untouched production sentinel');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
