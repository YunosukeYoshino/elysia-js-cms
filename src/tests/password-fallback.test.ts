import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  JWT_SECRET: '',
  PEPPER_SECRET: '',
};
function run(code: string, env: NodeJS.ProcessEnv = base): Bun.SyncSubprocess<'pipe', 'pipe'> {
  return Bun.spawnSync([process.execPath, '-e', code], { env, timeout: 10000 });
}
const hashCode: string =
  "import {hashPassword} from './src/lib/password'; console.log((await hashPassword('DevCheck42-Only')).hash);";
for (const mode of ['development', 'test']) {
  for (const jwt of ['', 'your-secret-key-for-jwt-tokens']) {
    it(`keeps fallback passwords valid across restart in ${mode}`, () => {
      const env: NodeJS.ProcessEnv = { ...base, NODE_ENV: mode, JWT_SECRET: jwt };
      const first = run(hashCode, env);
      expect(first.exitCode).toBe(0);
      const hash: string = first.stdout.toString().trim();
      expect(hash.startsWith('bun:v1:')).toBe(true);
      const second = run(
        "import {verifyPassword} from './src/lib/password'; console.log(await verifyPassword('DevCheck42-Only',process.env.FIXTURE_HASH),await verifyPassword('incorrect',process.env.FIXTURE_HASH));",
        { ...env, FIXTURE_HASH: hash },
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString().trim()).toBe('true false');
    });
  }
}
it('never uses the fallback in production', () => {
  for (const jwt of ['', 'your-secret-key-for-jwt-tokens']) {
    expect(run(hashCode, { ...base, NODE_ENV: 'production', JWT_SECRET: jwt }).exitCode).not.toBe(
      0,
    );
  }
});
it('registers and logs in after restart without development secrets', () => {
  const dir: string = mkdtempSync(join(tmpdir(), 'cms-dev-auth-'));
  const env: NodeJS.ProcessEnv = { ...base, DATABASE_URL: `file:${join(dir, 'auth.db')}` };
  try {
    expect(
      Bun.spawnSync([process.execPath, 'prisma', 'db', 'push', '--skip-generate'], {
        env,
        timeout: 10000,
      }).exitCode,
    ).toBe(0);
    const code: string =
      "import {strict as assert} from 'node:assert'; import app from './src/index'; import p from './src/lib/prisma'; const body={email:'dev-auth@example.com',password:'DevCheck42-Only'}; const post=path=>app.handle(new Request('http://localhost/api/auth/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})); if(process.env.REGISTER_FIXTURE==='true') assert.equal((await post('register')).status,200); const login=await post('login'); assert.equal(login.status,200); const token=(await login.json()).accessToken; assert.equal((await app.handle(new Request('http://localhost/api/auth/me',{headers:{Authorization:'Bearer '+token}}))).status,200); body.password='incorrect'; assert.equal((await post('login')).status,401); await p.$disconnect(); process.exit(0);";
    for (const register of ['true', 'false']) {
      const result = run(code, { ...env, REGISTER_FIXTURE: register });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
it('preserves configured-secret precedence instead of the fallback', () => {
  const key: string = 'configured-jwt-pepper-for-regression';
  const first = run(hashCode, { ...base, JWT_SECRET: key, PEPPER_SECRET: 'other' });
  expect(first.exitCode).toBe(0);
  const hash: string = first.stdout.toString().trim();
  for (const [jwt, pepper, expected] of [
    [key, 'changed', 'true'],
    ['different', key, 'false'],
    ['', key, 'true'],
  ] as const) {
    const result = run(
      "import {verifyPassword} from './src/lib/password'; console.log(await verifyPassword('DevCheck42-Only',process.env.FIXTURE_HASH));",
      { ...base, JWT_SECRET: jwt, PEPPER_SECRET: pepper, FIXTURE_HASH: hash },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expected);
  }
});
