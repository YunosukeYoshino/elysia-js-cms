import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface CoverageEntry {
  source: string;
  lines: number;
  coveredLines: number;
  functions: number;
  coveredFunctions: number;
}

/** LCOV を検証し、未ロードのサービスもカバレッジ不足として扱う。 */
async function verifyServiceCoverage(path: string): Promise<void> {
  const content = await Bun.file(path).text();
  const entries: CoverageEntry[] = [];
  let current: CoverageEntry | undefined;
  for (const line of content.split('\n')) {
    if (line.startsWith('SF:'))
      current = {
        source: line.slice(3).replaceAll('\\', '/'),
        lines: 0,
        coveredLines: 0,
        functions: 0,
        coveredFunctions: 0,
      };
    else if (current && line.startsWith('LF:')) current.lines = Number(line.slice(3));
    else if (current && line.startsWith('LH:')) current.coveredLines = Number(line.slice(3));
    else if (current && line.startsWith('FNF:')) current.functions = Number(line.slice(4));
    else if (current && line.startsWith('FNH:')) current.coveredFunctions = Number(line.slice(4));
    else if (line === 'end_of_record' && current) {
      entries.push(current);
      current = undefined;
    }
  }
  const sources: string[] = [];
  for (const directory of ['src/domain/services', 'src/services']) {
    const files = await readdir(directory).catch((error: unknown): string[] => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) if (file.endsWith('.ts')) sources.push(directory + '/' + file);
  }
  if (!sources.length) throw new Error('No service source files found');
  const results = sources.map((source) => {
    const entry = entries.find(
      (value) => value.source === source || value.source.endsWith('/' + source),
    );
    if (!entry || !entry.lines) throw new Error('Missing service coverage: ' + source);
    const lines = (entry.coveredLines / entry.lines) * 100;
    const functions = entry.functions ? (entry.coveredFunctions / entry.functions) * 100 : 100;
    return { source, lines, functions };
  });
  console.table(
    results.map((entry) => ({
      service: entry.source,
      lines: entry.lines.toFixed(2) + '%',
      functions: entry.functions.toFixed(2) + '%',
    })),
  );
  if (results.some((entry) => entry.lines < 90 || entry.functions < 90))
    throw new Error('Every service requires at least 90% line and function coverage');
}

/** 専用 DB を使用して全テスト・実測時間・サービスカバレッジを CI で検証する。 */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cms-full-suite-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: 'file:' + join(directory, 'test.db'),
    CMS_TEST_DATABASE_URL: 'file:' + join(directory, 'test.db'),
  };
  try {
    const setup = Bun.spawn(
      [process.execPath, resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      { env, stdout: 'inherit', stderr: 'inherit' },
    );
    if ((await setup.exited) !== 0) throw new Error('Test schema setup failed');
    const started = performance.now();
    const child = Bun.spawn(
      [
        process.execPath,
        'test',
        '--coverage',
        '--coverage-reporter=text',
        '--coverage-reporter=lcov',
        '--coverage-dir=coverage',
        '--timeout=30000',
      ],
      { env, stdout: 'inherit', stderr: 'inherit' },
    );
    const timer = setTimeout(() => {
      child.kill();
    }, 300000);
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } finally {
      clearTimeout(timer);
    }
    const elapsed = performance.now() - started;
    console.log(`Full test suite: ${(elapsed / 1000).toFixed(2)}s (limit: 300s)`);
    if (exitCode !== 0) throw new Error('Test suite failed or timed out');
    if (elapsed >= 300000) throw new Error('Test suite exceeded five minutes');
    await verifyServiceCoverage('coverage/lcov.info');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
