import { expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MemoryCacheStore, SharedCache } from '../lib/shared-cache';
import { createContentCache } from '../middlewares/content-cache';

it('caches public JSON, varies exact queries, bypasses authentication and invalidates after mutations', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  let reads: number = 0;
  const app = new Elysia()
    .use(
      createContentCache({
        currentRevision: async () => '0',
        cache,
        nextPublication: async () => null,
      }),
    )
    .get('/api/posts', () => ({ posts: [{ id: ++reads, date: new Date('2026-01-01') }] }))
    .post('/api/posts', () => ({ ok: true }))
    .post('/api/posts/1/comments', () => ({ ok: true }));
  const send = (
    path: string = '/api/posts',
    method: string = 'GET',
    headers: Record<string, string> = {},
  ): Promise<Response> => app.handle(new Request('http://localhost' + path, { method, headers }));
  const first: Response = await send();
  expect(first.headers.get('X-Cache')).toBe('MISS');
  const original: string = await first.text();
  const hit: Response = await send();
  expect(hit.headers.get('X-Cache')).toBe('HIT');
  expect(await hit.text()).toBe(original);
  expect(reads).toBe(1);
  expect((await send('/api/posts?search=x')).headers.get('X-Cache')).toBe('MISS');
  expect((await send('/api/posts?search=y')).headers.get('X-Cache')).toBe('MISS');
  const privateHeaders: Record<string, string>[] = [
    { authorization: 'Bearer invalid' },
    { cookie: 'session=abc' },
  ];
  for (const headers of privateHeaders) {
    expect((await send('/api/posts', 'GET', headers)).headers.has('X-Cache')).toBe(false);
  }
  await send('/api/posts', 'POST');
  expect((await send()).headers.get('X-Cache')).toBe('MISS');
  await send('/api/posts/1/comments', 'POST');
  expect((await send()).headers.get('X-Cache')).toBe('MISS');
  await cache.destroy();
});

it('expires exactly at publication time and avoids resurrecting pre-publication values', async () => {
  let now: number = 1000;
  const cache: SharedCache = new SharedCache(new MemoryCacheStore(100, () => now));
  const publication: number = 2000;
  const app = new Elysia()
    .use(
      createContentCache({
        currentRevision: async () => '0',
        cache,
        clock: () => now,
        nextPublication: async () => (now < publication ? new Date(publication) : null),
      }),
    )
    .get('/api/posts', () => ({ posts: now < publication ? [] : [{ id: 1 }] }));
  const read = (): Promise<Response> => app.handle(new Request('http://localhost/api/posts'));
  expect(await (await read()).json()).toEqual({ posts: [] });
  now = 1999;
  expect((await read()).headers.get('X-Cache')).toBe('HIT');
  now = 2000;
  const due: Response = await read();
  expect(due.headers.get('X-Cache')).toBe('MISS');
  expect(await due.json()).toEqual({ posts: [{ id: 1 }] });
  expect((await read()).headers.get('X-Cache')).toBe('HIT');
  await cache.destroy();
});

it('bypasses posts when scheduling cannot be checked but still caches categories', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  const app = new Elysia()
    .use(createContentCache({ currentRevision: async () => '0', cache }))
    .get('/api/posts', () => ({ posts: [] }))
    .get('/api/categories', () => ({ categories: [] }));
  expect((await app.handle(new Request('http://localhost/api/posts'))).headers.has('X-Cache')).toBe(
    false,
  );
  expect(
    (await app.handle(new Request('http://localhost/api/categories'))).headers.get('X-Cache'),
  ).toBe('MISS');
  expect(
    (await app.handle(new Request('http://localhost/api/categories'))).headers.get('X-Cache'),
  ).toBe('HIT');
  await cache.destroy();
});

it('never caches private, cookie, failed, streaming, or unrelated responses', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  const app = new Elysia()
    .use(createContentCache({ currentRevision: async () => '0', cache }))
    .get('/api/categories/1', ({ set }) => {
      set.status = 404;
      return { error: 'missing' };
    })
    .get('/api/categories/2', ({ set }) => {
      set.headers['Cache-Control'] = 'private';
      return { secret: true };
    })
    .get('/api/categories/3', ({ set }) => {
      set.headers['Set-Cookie'] = 'example=value';
      return { value: true };
    })
    .get('/api/categories/4', () => new Response('stream'))
    .get('/api/auth/me', () => ({ email: 'private@example.com' }));
  for (const path of [
    '/api/categories/1',
    '/api/categories/2',
    '/api/categories/3',
    '/api/categories/4',
    '/api/auth/me',
  ]) {
    await app.handle(new Request('http://localhost' + path));
    expect(
      (await app.handle(new Request('http://localhost' + path))).headers.get('X-Cache'),
    ).not.toBe('HIT');
  }
  expect(cache.stats().hits).toBe(0);
  await cache.destroy();
});

it('bypasses stale Redis generations using the authoritative DB revision even when invalidation is lost', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  let revision: string = '1';
  let published: boolean = true;
  const app = new Elysia()
    .use(
      createContentCache({
        cache,
        currentRevision: async () => revision,
        nextPublication: async () => null,
      }),
    )
    .get('/api/posts', () => ({ posts: published ? [{ id: 1, title: 'Previously public' }] : [] }));
  const read = (): Promise<Response> => app.handle(new Request('http://localhost/api/posts'));
  expect(await (await read()).json()).toEqual({ posts: [{ id: 1, title: 'Previously public' }] });
  expect((await read()).headers.get('X-Cache')).toBe('HIT');
  // 他ノードの書き込みで版が更新されたがRedis無効化が届かなかった状態。
  published = false;
  revision = '2';
  expect(await (await read()).json()).toEqual({ posts: [] });
  await cache.destroy();
});

it('bypasses content caching when the authoritative revision cannot be read', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  const app = new Elysia()
    .use(
      createContentCache({
        cache,
        currentRevision: async () => {
          throw new Error('missing trigger');
        },
      }),
    )
    .get('/api/categories', () => ({ categories: [] }));
  for (let i: number = 0; i < 2; i++)
    expect(
      (await app.handle(new Request('http://localhost/api/categories'))).headers.has('X-Cache'),
    ).toBe(false);
  expect(cache.stats().hits).toBe(0);
  await cache.destroy();
});

it('honors private/no-store/cookies/vary when handlers assign a Headers instance', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  for (const header of [
    new Headers({ 'Cache-Control': 'private' }),
    new Headers({ 'Cache-Control': 'no-store' }),
    new Headers({ 'Set-Cookie': 'session=private' }),
    new Headers({ Vary: '*' }),
  ]) {
    const app = new Elysia()
      .use(createContentCache({ cache, currentRevision: async () => 'headers-test' }))
      .get('/api/categories', ({ set }) => {
        Object.defineProperty(set, 'headers', { value: header, writable: true });
        return { secret: 'never cache' };
      });
    for (let i: number = 0; i < 2; i++)
      expect(
        (await app.handle(new Request('http://localhost/api/categories'))).headers.get('X-Cache'),
      ).not.toBe('HIT');
  }
  expect(cache.stats().hits).toBe(0);
  await cache.destroy();
});

it('keeps cache hits eligible for downstream JSON compression and preserves payload and Vary', async () => {
  const cache: SharedCache = new SharedCache(new MemoryCacheStore());
  const payload = {
    posts: [{ content: 'x'.repeat(10000), createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  let calls: number = 0;
  const app = new Elysia()
    .use(
      createContentCache({
        cache,
        currentRevision: async () => '0',
        nextPublication: async () => null,
      }),
    )
    .mapResponse(({ responseValue }) => {
      if (
        typeof responseValue !== 'object' ||
        responseValue === null ||
        responseValue instanceof Response
      )
        return;
      return new Response(new Uint8Array(Bun.gzipSync(JSON.stringify(responseValue))), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          Vary: 'Accept-Encoding',
        },
      });
    })
    .get('/api/posts', () => {
      calls++;
      return payload;
    });
  for (const expected of ['MISS', 'HIT']) {
    const response: Response = await app.handle(
      new Request('http://localhost/api/posts', { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(response.headers.get('X-Cache')).toBe(expected);
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(
      JSON.parse(
        new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))),
      ),
    ).toEqual(payload);
  }
  expect(calls).toBe(1);
  await cache.destroy();
});
