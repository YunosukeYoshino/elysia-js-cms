import { Elysia } from 'elysia';
import { type HierarchicalRateLimiter, hierarchicalRateLimiter } from '../lib/rate-limit-policy';
import { type SharedCache, sharedCache } from '../lib/shared-cache';
import { authMiddleware, isAdmin } from '../middlewares/auth';

const dashboard: string = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>API制限状況</title></head>
<body><h1>API制限状況</h1><p>このサーバープロセスの集計です。トークンは保存されません。</p>
<form id="form"><label>管理者アクセストークン <input id="token" type="password" autocomplete="off" required></label><button>更新</button></form>
<pre id="result" aria-live="polite"></pre><script>
const form = document.getElementById('form');
form.addEventListener('submit', async (event) => {
 event.preventDefault(); const token = document.getElementById('token');
 const button = form.querySelector('button'); button.disabled = true;
 try {
  const response = await fetch('./status', { headers: { Authorization: 'Bearer ' + token.value }, cache: 'no-store' });
  document.getElementById('result').textContent = JSON.stringify(await response.json(), null, 2);
 } catch { document.getElementById('result').textContent = '取得できませんでした'; }
 finally { token.value = ''; button.disabled = false; }
});
</script></body></html>`;

/** 管理者のみ集計値を参照できる。接続URL、トークン、IP、ユーザーIDは返さない。 */
export function createRateLimitAdminRouter(
  limiter: HierarchicalRateLimiter = hierarchicalRateLimiter,
  cache: SharedCache = sharedCache,
) {
  return new Elysia({ prefix: '/admin/rate-limits' })
    .use(authMiddleware)
    .get(
      '/status',
      ({ set }) => {
        set.headers['Cache-Control'] = 'no-store';
        return {
          scope: 'process',
          limits: limiter.stats(),
          cache: cache.stats(),
          policy: {
            global: limiter.policy.global,
            ip: limiter.policy.ip,
            user: limiter.policy.user,
            auth: limiter.policy.auth,
            upload: limiter.policy.upload,
            burst: limiter.policy.burst,
            adminMultiplier: limiter.policy.adminMultiplier,
          },
        };
      },
      { beforeHandle: isAdmin },
    )
    .get('/dashboard', ({ set }) => {
      set.headers['Content-Type'] = 'text/html; charset=utf-8';
      set.headers['Cache-Control'] = 'no-store';
      set.headers['X-Content-Type-Options'] = 'nosniff';
      set.headers['Content-Security-Policy'] =
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
      return dashboard;
    });
}
export const rateLimitAdminRouter = createRateLimitAdminRouter();
