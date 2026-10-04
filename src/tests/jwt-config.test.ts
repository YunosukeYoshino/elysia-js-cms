import { expect, it } from 'bun:test';
import { getJwtSecret } from '../lib/jwt-config';

const fallback = getJwtSecret({ NODE_ENV: 'test' });
for (const secret of [undefined, '', '  ', fallback, ' ' + fallback + ' ']) {
  it('rejects unsafe production configuration', () => {
    expect(() => getJwtSecret({ NODE_ENV: 'production', JWT_SECRET: secret })).toThrow(
      'JWT_SECRET',
    );
  });
}
it('preserves configured production secrets exactly', () => {
  expect(getJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'configured-for-unit-tests' })).toBe(
    'configured-for-unit-tests',
  );
});
for (const mode of [undefined, 'development', 'test']) {
  it('preserves non-production fallback and overrides', () => {
    expect(getJwtSecret({ NODE_ENV: mode })).toBe(fallback);
    expect(getJwtSecret({ NODE_ENV: mode, JWT_SECRET: 'override' })).toBe('override');
  });
}
it('refuses to initialize production auth without a secret', async () => {
  const child = Bun.spawn([process.execPath, '-e', "import './src/middlewares/auth'"], {
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stderr).text()).toContain('JWT_SECRET');
});
it('starts in production mode even when the caller is in development', async () => {
  const child = Bun.spawn([process.execPath, 'run', 'start'], {
    env: { ...process.env, NODE_ENV: 'development', JWT_SECRET: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stderr).text()).toContain('JWT_SECRET');
});
