import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getPasswordPepper, getPasswordVerificationPeppers } from '../lib/pepper-config';

const jwt: string = 'configured-jwt-secret-for-passwords';
const pepper: string = 'configured-independent-password-secret';
const placeholder: string = 'your-secret-key-for-jwt-tokens';
const fallback: string = 'dev-fallback-pepper-for-local-testing-only';

describe('password pepper configuration', () => {
  for (const mode of ['development', 'test', 'production', 'staging', '', undefined]) {
    it(`preserves configured-secret precedence in ${mode ?? 'unset'} mode`, () => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: mode };
      expect(getPasswordPepper({ ...env, JWT_SECRET: jwt, PEPPER_SECRET: pepper })).toBe(jwt);
      for (const invalid of [undefined, '', '   ', placeholder]) {
        expect(getPasswordPepper({ ...env, JWT_SECRET: invalid, PEPPER_SECRET: pepper })).toBe(
          pepper,
        );
      }
      expect(getPasswordPepper({ ...env, JWT_SECRET: ` ${jwt} ` })).toBe(` ${jwt} `);
    });
  }

  for (const mode of ['production', 'staging', 'Development', '', undefined]) {
    it(`refuses public fallback and public sample secrets in ${mode ?? 'unset'} mode`, () => {
      for (const invalid of [
        undefined,
        '',
        '   ',
        placeholder,
        fallback,
        'default-secret-for-testing-please-change-in-prod',
        'test-secret-key-for-testing-only',
      ]) {
        const env: NodeJS.ProcessEnv = {
          NODE_ENV: mode,
          JWT_SECRET: invalid,
          PEPPER_SECRET: invalid,
        };
        expect(() => getPasswordPepper(env)).toThrow('explicit NODE_ENV');
        expect(() => getPasswordVerificationPeppers(env)).toThrow('explicit NODE_ENV');
      }
    });
  }

  for (const mode of ['development', 'test']) {
    it(`allows stable fallback only in explicit ${mode} mode`, () => {
      expect(getPasswordPepper({ NODE_ENV: mode })).toBe(fallback);
      expect(getPasswordPepper({ NODE_ENV: mode, JWT_SECRET: placeholder })).toBe(fallback);
      expect(
        getPasswordVerificationPeppers({
          NODE_ENV: mode,
          JWT_SECRET: placeholder,
          PEPPER_SECRET: pepper,
        }),
      ).toEqual([pepper, fallback]);
      expect(
        getPasswordVerificationPeppers({ NODE_ENV: mode, JWT_SECRET: jwt, PEPPER_SECRET: pepper }),
      ).toEqual([jwt]);
    });
  }

  it('does not try an old public pepper outside explicit local modes', () => {
    for (const mode of ['production', 'staging', '', undefined]) {
      expect(
        getPasswordVerificationPeppers({
          NODE_ENV: mode,
          JWT_SECRET: placeholder,
          PEPPER_SECRET: pepper,
        }),
      ).toEqual([pepper]);
    }
  });

  it('starts the documented dev command in explicit development mode', () => {
    const manifest: { scripts: { dev: string } } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest.scripts.dev).toBe('NODE_ENV=development bun run --watch src/index.ts');
  });
});
