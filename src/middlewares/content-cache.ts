import { Elysia } from 'elysia';
import { readContentRevision } from '../lib/content-revision';
import { CONTENT_CACHE_TTL_MS, type SharedCache, sharedCache } from '../lib/shared-cache';

export interface ContentCacheOptions {
  cache?: SharedCache;
  currentRevision?: () => Promise<string>;
  /** 次の公開時刻。投稿キャッシュにはスケジュール情報の取得を必須とする。 */
  nextPublication?: () => Promise<Date | null>;
  clock?: () => number;
}
interface FillTicket {
  token: string;
  expires: number;
}

/** 匿名の公開投稿・カテゴリJSONだけをキャッシュする。認証・エラー・ストリームは除外する。 */
export function createContentCache(options: ContentCacheOptions = {}) {
  const cache: SharedCache = options.cache ?? sharedCache;
  const clock: () => number = options.clock ?? Date.now;
  const revision: () => Promise<string> = options.currentRevision ?? readContentRevision;
  const tickets: WeakMap<Request, FillTicket> = new WeakMap();
  return new Elysia({ name: 'public-content-cache' })
    .onBeforeHandle({ as: 'scoped' }, async ({ request, set }) => {
      const url: URL = new URL(request.url);
      const isPost: boolean = /^\/api\/posts(?:\/\d+)?\/?$/.test(url.pathname);
      const isCategory: boolean = /^\/api\/categories(?:\/\d+)?\/?$/.test(url.pathname);
      if (
        request.method !== 'GET' ||
        (!isPost && !isCategory) ||
        request.headers.has('authorization') ||
        request.headers.has('cookie') ||
        (isPost && !options.nextPublication)
      )
        return;
      let next: Date | null = null;
      let version: string;
      try {
        version = await revision();
        if (isPost && options.nextPublication) next = await options.nextPublication();
      } catch {
        return; // スケジュール不明時は元のDB読み取りを行う。
      }
      const now: number = clock();
      const expires: number = Math.min(now + CONTENT_CACHE_TTL_MS, next?.getTime() ?? Infinity);
      if (expires <= now) return;
      // クエリは順序も含めて保持し、重複パラメーターの意味を変更しない。
      const key: string = `dto:2:revision:${version}:${url.pathname}${url.search}:publication:${next?.getTime() ?? 'none'}`;
      const lookup = await cache.lookup(
        'content',
        key,
        (value: unknown): value is string => typeof value === 'string',
      );
      if (lookup.hit && lookup.value !== null) {
        try {
          const parsed: unknown = JSON.parse(lookup.value);
          if (typeof parsed === 'object' && parsed !== null) {
            set.headers['X-Cache'] = 'HIT';
            // JSON値を返して後段の圧縮とVary処理も通常レスポンス同様に適用する。
            return parsed;
          }
        } catch {
          // 壊れた値は元のハンドラーで再生成する。
        }
      }
      set.headers['X-Cache'] = lookup.token ? 'MISS' : 'BYPASS';
      if (lookup.token) tickets.set(request, { token: lookup.token, expires });
    })
    .onAfterHandle({ as: 'scoped' }, async ({ request, response, set }) => {
      const status: number =
        typeof set.status === 'number' ? set.status : set.status === 'OK' ? 200 : 0;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && status >= 200 && status < 300) {
        // 投稿・カテゴリ・コメント・リアクション変更による一覧件数も同時に無効化。
        await cache.invalidate('content');
        return;
      }
      const ticket: FillTicket | undefined = tickets.get(request);
      tickets.delete(request);
      if (
        !ticket ||
        status !== 200 ||
        typeof response !== 'object' ||
        response === null ||
        response instanceof Response ||
        response instanceof ReadableStream ||
        response instanceof Blob ||
        ArrayBuffer.isView(response) ||
        response instanceof ArrayBuffer ||
        'error' in response ||
        set.headers['set-cookie']
      )
        return;
      const headers: Headers = new Headers();
      if (set.headers instanceof Headers) {
        set.headers.forEach((value: string, name: string): void => {
          headers.append(name, value);
        });
      } else {
        for (const [name, value] of Object.entries(set.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, String(value));
        }
      }
      const blockedHeader: boolean =
        headers.has('set-cookie') ||
        /private|no-store/i.test(headers.get('cache-control') ?? '') ||
        (headers.get('vary') ?? '').includes('*');
      if (blockedHeader) return;
      const ttlMs: number = ticket.expires - clock();
      if (ttlMs <= 0) return;
      const json: string = JSON.stringify(response);
      await cache.fill(ticket.token, json, ttlMs);
    });
}
