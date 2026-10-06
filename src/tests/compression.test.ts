import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { acceptsGzip, responseCompression } from '../middlewares/compression';

const text: string = '公開コンテンツ '.repeat(200);
const app = new Elysia()
  .use(responseCompression)
  .get('/public', () => ({ text }))
  .get('/named-status', ({ set }) => {
    set.status = 'Created';
    return text;
  })
  .get('/small', () => 'small')
  .get('/private', ({ set }) => {
    set.headers['Cache-Control'] = 'private';
    return text;
  })
  .get('/no-transform', ({ set }) => {
    set.headers['Cache-Control'] = 'public, no-transform';
    return text;
  })
  .get('/cookie', ({ set }) => {
    set.headers['Set-Cookie'] = 'session=secret';
    return text;
  })
  .get('/raw', () => new Response(text, { headers: { 'Content-Type': 'text/plain' } }))
  .get('/headers', ({ set }) => {
    set.headers.Vary = 'Origin';
    set.headers.ETag = '"version"';
    set.headers['Content-Length'] = '99999';
    return text;
  })
  .get('/api/auth/me', () => text)
  .get('/error', ({ set }) => {
    set.status = 400;
    return { error: text };
  });

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, { headers: { 'Accept-Encoding': 'gzip', ...headers } }),
  );
}

describe('public response compression', () => {
  it('negotiates valid explicit weights before wildcards', () => {
    for (const value of ['gzip', 'br, gzip;q=0.5', '*;q=1', 'GZIP; q=1.000'])
      expect(acceptsGzip(value)).toBe(true);
    for (const value of [null, '', 'br', 'gzip;q=0,*;q=1', 'gzip;q=2', 'gzip;q=nope'])
      expect(acceptsGzip(value)).toBe(false);
  });
  it('compresses public JSON losslessly and reduces bytes', async () => {
    const response = await get('/public');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(new TextEncoder().encode(text).byteLength / 10);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)))).toEqual({ text });
  });
  it('varies uncompressed negotiation and preserves origin and etag semantics', async () => {
    const identity = await get('/public', { 'Accept-Encoding': 'gzip;q=0' });
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(identity.headers.get('vary')).toContain('Accept-Encoding');
    expect(await identity.json()).toEqual({ text });
    const compressed = await get('/headers');
    expect(compressed.headers.get('vary')).toBe('Origin, Accept-Encoding');
    expect(compressed.headers.get('etag')).toBe('W/"version"');
    expect(compressed.headers.get('content-length')).not.toBe('99999');
  });
  it('preserves named statuses and Vary on both negotiations', async () => {
    const created = await get('/named-status');
    expect(created.status).toBe(201);
    expect(created.headers.get('content-encoding')).toBeNull();
    for (const coding of ['gzip', 'identity']) {
      const response = await get('/headers', { 'Accept-Encoding': coding });
      expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding');
      expect(response.headers.get('content-encoding')).toBe(coding === 'gzip' ? 'gzip' : null);
    }
  });
  it('leaves secrets, small bodies, errors and streaming Responses untouched', async () => {
    for (const path of [
      '/small',
      '/private',
      '/no-transform',
      '/cookie',
      '/raw',
      '/api/auth/me',
      '/error',
    ]) {
      expect((await get(path)).headers.get('content-encoding')).toBeNull();
    }
    const privateHeaders: Record<string, string>[] = [
      { Authorization: 'Bearer secret' },
      { Cookie: 'session=secret' },
    ];
    for (const headers of privateHeaders) {
      expect((await get('/public', headers)).headers.get('content-encoding')).toBeNull();
    }
    expect((await get('/error')).status).toBe(400);
    expect(await (await get('/raw')).text()).toBe(text);
  });
});
