import { Elysia } from 'elysia';
import {
  type EndpointKind,
  type HierarchicalRateLimiter,
  hierarchicalRateLimiter,
  type LimitIdentity,
  trustedClientIP,
} from '../lib/rate-limit-policy';
import { authenticateRequest, authMiddleware } from './auth';

/** 認証済みのDB由来ユーザーとサーバー接続元から制限を適用する。 */
export function createHierarchicalRateLimit(
  limiter: HierarchicalRateLimiter = hierarchicalRateLimiter,
  pathPrefix: string = '/api',
) {
  const identities: WeakMap<Request, LimitIdentity> = new WeakMap();
  return new Elysia({ name: 'hierarchical-rate-limit' })
    .use(authMiddleware)
    .onRequest(async ({ request, server, jwt, set }) => {
      const path: string = new URL(request.url).pathname;
      if (pathPrefix && path !== pathPrefix && !path.startsWith(`${pathPrefix}/`)) return;
      const endpoint: EndpointKind = /\/auth\/(login|register|refresh)\/?$/.test(path)
        ? 'auth'
        : request.method === 'POST' && /\/files\/upload\/?$/.test(path)
          ? 'upload'
          : 'api';
      const identity: LimitIdentity = {
        endpoint,
        user: await authenticateRequest(request, jwt.verify),
        ip: trustedClientIP(
          server?.requestIP(request)?.address,
          request.headers,
          limiter.policy.trustedProxies,
        ),
      };
      identities.set(request, identity);
      const result = await limiter.check(identity);
      Object.assign(set.headers, {
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
        'X-RateLimit-Policy': result.rule,
      });
      if (!result.allowed) {
        set.status = result.unavailable ? 503 : 429;
        set.headers['Retry-After'] = Math.max(
          1,
          Math.ceil((result.resetTime - Date.now()) / 1000),
        ).toString();
        return {
          code: result.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED',
          error: result.unavailable
            ? 'レート制限サービスは一時的に利用できません'
            : 'リクエスト制限に達しました。しばらく待ってください。',
        };
      }
    })
    .mapResponse({ as: 'scoped' }, async ({ request, set, responseValue }) => {
      const limitIdentity: LimitIdentity | undefined = identities.get(request);
      const status: number =
        responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === 'number'
            ? set.status
            : 0;
      if (limitIdentity?.endpoint === 'auth' && (status === 401 || status === 423))
        await limiter.penalize(limitIdentity);
      // エラー経路もこのフックを通るため、変換済みの本文を維持する。
      if (status >= 400) {
        if (responseValue instanceof Response) return responseValue;
        if (typeof responseValue === 'string') return new Response(responseValue, { status });
        return Response.json(responseValue ?? null, { status });
      }
    });
}
