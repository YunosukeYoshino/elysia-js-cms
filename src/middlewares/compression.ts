import { Elysia } from 'elysia';

/** Accept-Encoding の明示指定をワイルドカードより優先して判定する。 */
export function acceptsGzip(value: string | null): boolean {
  if (!value) return false;
  const weights: Map<string, number> = new Map();
  for (const item of value.split(',')) {
    const [coding, ...parameters]: string[] = item.trim().toLowerCase().split(';');
    let quality: number = 1;
    for (const parameter of parameters) {
      const pair: string[] = parameter.trim().split('=');
      if (pair[0] === 'q') {
        quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(pair[1] ?? '') ? Number(pair[1]) : 0;
      }
    }
    weights.set(coding, quality);
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}

/** 公開レスポンスだけを圧縮し、認証情報やストリームはそのまま維持する。 */
export const responseCompression = new Elysia({ name: 'cms.response-compression' }).mapResponse(
  { as: 'global' },
  ({ request, responseValue, set, path }) => {
    if (
      request.method !== 'GET' ||
      request.headers.has('authorization') ||
      request.headers.has('cookie') ||
      path.startsWith('/api/auth') ||
      (set.status !== undefined && set.status !== 200 && set.status !== 'OK')
    )
      return;
    const isJson: boolean =
      Array.isArray(responseValue) ||
      (responseValue !== null &&
        typeof responseValue === 'object' &&
        Object.getPrototypeOf(responseValue) === Object.prototype);
    if (typeof responseValue !== 'string' && !isJson) return;
    const headers: Headers = new Headers();
    if (set.headers instanceof Headers) {
      set.headers.forEach((value: string, key: string) => {
        headers.append(key, value);
      });
    } else {
      for (const [key, value] of Object.entries(set.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value !== undefined) headers.set(key, String(value));
      }
    }
    if (
      headers.has('content-encoding') ||
      headers.has('set-cookie') ||
      /(?:no-transform|private|no-store)/i.test(headers.get('cache-control') ?? '')
    )
      return;
    const contentType: string =
      headers.get('content-type') ??
      (isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    if (!/^(?:application\/json|text\/(?:plain|html|css))(?:;|$)/i.test(contentType)) return;
    const text: string =
      typeof responseValue === 'string' ? responseValue : JSON.stringify(responseValue);
    const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(text);
    if (bytes.byteLength < 1024 || bytes.byteLength > 1024 * 1024) return;
    const vary: string[] = (headers.get('vary') ?? '')
      .split(',')
      .map((part: string) => part.trim())
      .filter(Boolean);
    if (!vary.some((part: string) => part === '*' || part.toLowerCase() === 'accept-encoding'))
      vary.push('Accept-Encoding');
    headers.set('Vary', vary.join(', '));
    set.headers = Object.fromEntries(headers.entries());
    if (!acceptsGzip(request.headers.get('accept-encoding'))) return;
    const compressed: Uint8Array = Bun.gzipSync(bytes);
    if (compressed.byteLength >= bytes.byteLength) return;
    headers.set('Content-Type', contentType);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Vary', vary.join(', '));
    headers.delete('Content-Length');
    headers.delete('Accept-Ranges');
    const etag: string | null = headers.get('etag');
    if (etag && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`);
    // Elysia は set.headers も統合するため、古い長さや範囲指定を残さない。
    set.headers = Object.fromEntries(headers.entries());
    return new Response(new Uint8Array(compressed), { headers });
  },
);
