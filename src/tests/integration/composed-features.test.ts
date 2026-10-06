import { expect, it } from 'bun:test';
import { jwt } from '@elysiajs/jwt';
import app from '../../index';
import { getJwtSecret } from '../../lib/jwt-config';
import prisma from '../../lib/prisma';

it('composes public cache, compression, DB invalidation and live authorization', async () => {
  const user = await prisma.user.create({
    data: {
      email: `composed-${crypto.randomUUID()}@example.test`,
      name: 'Composed author',
      password: 'fixture-only',
      role: 'admin',
    },
  });
  const post = await prisma.post.create({
    data: {
      title: 'Composed public',
      content: 'public-content '.repeat(500),
      authorId: user.id,
      published: true,
    },
  });
  const token: string = await jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
    userId: user.id,
    type: 'access',
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const get = (path: string, authenticated: boolean = false): Promise<Response> =>
    app.handle(
      new Request(`http://localhost${path}`, {
        headers: {
          'Accept-Encoding': 'gzip',
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
  try {
    for (const state of ['MISS', 'HIT']) {
      const response = await get(`/api/posts/${post.id}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Cache')).toBe(state);
      expect(response.headers.get('Content-Encoding')).toBe('gzip');
      const vary = response.headers.get('Vary') ?? '';
      expect(vary === '*' || vary.includes('Accept-Encoding')).toBe(true);
      expect(response.headers.get('X-RateLimit-Limit')).not.toBeNull();
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeLessThan(1000);
      const body: unknown = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
      expect(body).toMatchObject({ id: post.id, content: post.content });
    }
    // Redis世代を無効化しない直接DB変更でも、トランザクション版で古い公開本文を隠す。
    const originResponse = await app.handle(
      new Request(`http://localhost/api/posts/${post.id}`, {
        headers: { Origin: 'https://reader.example.test' },
      }),
    );
    expect(originResponse.headers.get('access-control-allow-origin')).toBe(
      'https://reader.example.test',
    );
    expect(originResponse.headers.get('X-Cache')).toBe('HIT');
    expect(originResponse.headers.get('Vary')).toContain('Origin');
    await prisma.post.update({ where: { id: post.id }, data: { published: false } });
    const hidden = await get(`/api/posts/${post.id}`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain(post.content);
    const own = await get(`/api/posts/${post.id}`, true);
    expect(own.status).toBe(200);
    expect(own.headers.get('Content-Encoding')).toBeNull();
    expect(own.headers.get('X-Cache')).toBeNull();
    expect((await get('/api/admin/rate-limits/status', true)).status).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { role: 'user' } });
    expect((await get('/api/admin/rate-limits/status', true)).status).toBe(403);
  } finally {
    await prisma.post.delete({ where: { id: post.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

it('charges malformed requests in the real composed app before parsing', async () => {
  for (let attempt: number = 0; attempt < 11; attempt++) {
    const response = await app.handle(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      }),
    );
    expect(response.status).toBe(attempt < 10 ? 400 : 429);
    expect(response.headers.get('X-RateLimit-Limit')).not.toBeNull();
    if (attempt === 10) expect(response.headers.get('Retry-After')).not.toBeNull();
  }
});
