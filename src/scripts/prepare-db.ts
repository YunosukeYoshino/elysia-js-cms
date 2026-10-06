import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

let preparation: Promise<void> | undefined;
let preparedUrl: string | undefined;

/** テスト専用 URL を選ぶ。通常の DATABASE_URL や cwd の既存 DB を変更しない。 */
export function configureTestDatabase(): { url: string; ownedDirectory?: string } {
  const supplied = process.env.CMS_TEST_DATABASE_URL;
  if (supplied) {
    const path = supplied.startsWith('file:') ? supplied.slice(5) : '';
    const relativePath = relative(tmpdir(), path);
    if (
      !isAbsolute(path) ||
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath) ||
      !/^cms-(full-suite|test-run)-[^/]+\/test\.db$/.test(relativePath.replaceAll('\\', '/'))
    )
      throw new Error(
        'CMS_TEST_DATABASE_URL must point to a disposable cms-full-suite-* or cms-test-run-* directory inside the system temporary directory',
      );
    process.env.DATABASE_URL = supplied;
    return { url: supplied };
  }
  const directory = mkdtempSync(join(tmpdir(), 'cms-test-run-'));
  const url = 'file:' + join(directory, 'test.db');
  process.env.CMS_TEST_DATABASE_URL = url;
  process.env.DATABASE_URL = url;
  return { url, ownedDirectory: directory };
}

/** スキーマを準備する。同一プロセスの再呼び出しでは DB を削除・再初期化しない。 */
async function prepareDatabase(mode: 'development' | 'test' = 'development'): Promise<void> {
  const url = mode === 'test' ? configureTestDatabase().url : process.env.DATABASE_URL;
  if (mode === 'test' && preparedUrl === url && preparation) return preparation;
  const execute = async (): Promise<void> => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve('node_modules/prisma/build/index.js'),
        ...(mode === 'test' ? ['migrate', 'deploy'] : ['db', 'push', '--skip-generate']),
      ],
      {
        env: { ...process.env, ...(mode === 'test' ? { NODE_ENV: 'test' } : {}) },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await child.exited) !== 0) throw new Error(`Failed to prepare ${mode} database`);
  };
  if (mode === 'test') {
    preparedUrl = url;
    preparation = execute();
    try {
      await preparation;
    } catch (error) {
      preparation = undefined;
      preparedUrl = undefined;
      throw error;
    }
  } else {
    await execute();
  }
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'development';
  if (mode !== 'development' && mode !== 'test') throw new Error('Expected development or test');
  await prepareDatabase(mode);
}

export default prepareDatabase;
