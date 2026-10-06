import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

// ソースのない一時ディレクトリから実際の配布物を起動し、DB とネイティブ依存を検証する。
const root: string = resolve(import.meta.dir, '..');
const directory: string = await mkdtemp(join(tmpdir(), 'cms-artifact-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: '0',
  JWT_SECRET: 'artifact-smoke-secret-at-least-32-characters',
  DATABASE_URL: `file:${join(directory, 'smoke.db')}`,
};
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(join(directory, 'dist'));
  await cp(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
  // シンボリックリンクも実体としてコピーし、実行時の依存解決を配布先で検証する。
  await cp(join(root, 'node_modules'), join(directory, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  const schema = Bun.spawnSync([process.execPath, 'prisma', 'db', 'push', '--skip-generate'], {
    cwd: root,
    env,
    timeout: 30000,
  });
  assert.equal(schema.exitCode, 0, schema.stderr.toString());
  server = Bun.spawn([process.execPath, 'dist/index.js'], {
    cwd: directory,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const running = server;
  const stdout = running.stdout;
  assert(stdout && typeof stdout !== 'number');
  let log: string = '';
  const ready: Promise<string> = (async (): Promise<string> => {
    for await (const chunk of stdout) {
      log += new TextDecoder().decode(chunk);
      const match = log.match(/http:\/\/[^\s:]+:(\d+)/);
      if (match) return `http://127.0.0.1:${match[1]}`;
    }
    throw new Error(`Artifact exited before ready: ${log}`);
  })();
  const timeout = setTimeout(() => running.kill(), 30000);
  try {
    const url: string = await ready;
    const request = (path: string, init?: RequestInit): Promise<Response> =>
      fetch(url + path, { ...init, signal: AbortSignal.timeout(5000) });
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/api/posts/')).status, 200);
    const credentials = { email: 'artifact@example.test', password: 'ArtifactPass123!' };
    const register = await request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...credentials, name: 'Artifact smoke' }),
    });
    assert.equal(register.status, 200, await register.text());
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 200);
    const session: unknown = await login.json();
    assert(session && typeof session === 'object' && 'accessToken' in session);
    assert.equal(typeof session.accessToken, 'string');
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    assert.equal((await request('/api/auth/me', { headers })).status, 200);
    const input: Buffer = await sharp({
      create: { width: 16, height: 12, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(input)], 'smoke.png', { type: 'image/png' }));
    const upload = await request('/api/files/upload', { method: 'POST', headers, body: form });
    const result: unknown = await upload.json();
    assert.equal(upload.status, 200, JSON.stringify(result));
    assert(result && typeof result === 'object' && 'file' in result);
    const file = result.file;
    assert(file && typeof file === 'object' && 'id' in file && 'thumbnailPath' in file);
    assert.equal(typeof file.thumbnailPath, 'string');
    const thumb = await request(`/api/files${file.thumbnailPath}`);
    assert.equal(thumb.status, 200);
    const metadata = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(
      (await request(`/api/files/${file.id}`, { method: 'DELETE', headers })).status,
      200,
    );
    console.log(
      'Artifact smoke passed: isolated startup, Prisma auth/routes, native image upload and thumbnail.',
    );
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (server) {
    server.kill();
    await server.exited;
    const stderr = server.stderr;
    if (stderr && typeof stderr !== 'number') {
      const errors = await new Response(stderr).text();
      if (errors) console.error(errors);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
