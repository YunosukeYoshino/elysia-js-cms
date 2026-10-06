import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import { type CachedUser, getAuthenticatedUser } from '../lib/auth-cache';
import { getJwtSecret } from '../lib/jwt-config';
import prisma from '../lib/prisma';
import { MemoryCacheStore, RedisCacheStore, SharedCache } from '../lib/shared-cache';

/** 同じJWT検証とレスポンス処理でDB直接読取・メモリ・Redisの認証経路を比較する。 */
function application(load: (id: number) => Promise<CachedUser | null>) {
  return new Elysia()
    .use(jwt({ secret: getJwtSecret() }))
    .get('/me', async ({ jwt, headers, set }) => {
      const token: string = headers.authorization?.slice(7) ?? '';
      const claims = await jwt.verify(token);
      if (!claims || typeof claims.userId !== 'number' || claims.type !== 'access') {
        set.status = 401;
        return { error: 'Unauthorized' };
      }
      return { user: await load(claims.userId) };
    });
}

function summary(samples: number[]): { medianMs: number; p95Ms: number; meanMs: number } {
  const sorted: number[] = [...samples].sort((a: number, b: number): number => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    meanMs: samples.reduce((a: number, b: number): number => a + b, 0) / samples.length,
  };
}

const samples: number = Number(process.env.BENCH_SAMPLES ?? 1000);
if (!Number.isSafeInteger(samples) || samples < 10 || samples > 100000)
  throw new Error('Invalid BENCH_SAMPLES');
const email: string = `cache-bench-${crypto.randomUUID()}@example.com`;
const user = await prisma.user.create({
  data: { email, password: 'benchmark-only', name: 'Benchmark', role: 'user' },
});
const memoryStore: MemoryCacheStore = new MemoryCacheStore();
const memory: SharedCache = new SharedCache(memoryStore);
const redis: SharedCache | null = process.env.REDIS_TEST_URL
  ? new SharedCache(
      new RedisCacheStore(process.env.REDIS_TEST_URL, `cms:benchmark:${crypto.randomUUID()}:`),
      'redis',
    )
  : null;
const signer = jwt({ secret: getJwtSecret() }).decorator.jwt;
const token: string = await signer.sign({
  userId: user.id,
  type: 'access',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const baseline = application(
  (id: number): Promise<CachedUser | null> =>
    prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, role: true },
    }),
);
const variants = [
  { name: 'baselineDB', app: baseline, samples: [] as number[], cache: null },
  {
    name: 'warmMemory',
    app: application((id: number) => getAuthenticatedUser(id, memory)),
    samples: [] as number[],
    cache: memory,
  },
  ...(redis
    ? [
        {
          name: 'warmRedis',
          app: application((id: number) => getAuthenticatedUser(id, redis)),
          samples: [] as number[],
          cache: redis,
        },
      ]
    : []),
];
const request = (): Request =>
  new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } });
try {
  for (let iteration: number = 0; iteration < 200; iteration++)
    for (const variant of variants) await (await variant.app.handle(request())).arrayBuffer();
  // 同一時間帯の外部負荷の影響を均すため順序を交替し、全応答を消費する。
  for (let iteration: number = 0; iteration < samples; iteration++) {
    for (let offset: number = 0; offset < variants.length; offset++) {
      const variant = variants[(iteration + offset) % variants.length];
      const start: number = performance.now();
      const response: Response = await variant.app.handle(request());
      if (response.status !== 200) throw new Error('Unexpected benchmark status');
      await response.arrayBuffer();
      variant.samples.push(performance.now() - start);
    }
  }
  const baselineMedian: number = summary(variants[0].samples).medianMs;
  const results = variants.map((variant) => ({
    name: variant.name,
    ...summary(variant.samples),
    medianDeltaPercent: (summary(variant.samples).medianMs / baselineMedian - 1) * 100,
    cache: variant.cache?.stats() ?? null,
  }));
  const cold: { name: string; medianMs: number; p95Ms: number; meanMs: number }[] = [];
  for (const variant of variants.filter((value) => value.cache)) {
    const times: number[] = [];
    for (let iteration: number = 0; iteration < Math.min(samples, 100); iteration++) {
      await variant.cache?.invalidate('auth');
      const start: number = performance.now();
      await (await variant.app.handle(request())).arrayBuffer();
      times.push(performance.now() - start);
    }
    cold.push({ name: variant.name.replace('warm', 'cold'), ...summary(times) });
  }
  Bun.gc(true);
  const before: number = process.memoryUsage().heapUsed;
  const bounded: MemoryCacheStore = new MemoryCacheStore();
  for (let iteration: number = 0; iteration < 3000; iteration++)
    await bounded.put(`entry:${iteration}`, 'x'.repeat(16384), 60000);
  Bun.gc(true);
  console.log(
    JSON.stringify(
      {
        samples,
        runtime: Bun.version,
        database: 'SQLite, one indexed user lookup per request (authoritative role/existence)',
        results,
        cold,
        boundedMemory: {
          attemptedEntries: 3000,
          entryCharacters: 16384,
          retained: bounded.size(),
          approximateHeapDeltaBytes: process.memoryUsage().heapUsed - before,
        },
        note: 'Local microbenchmark, not a production SLO. No flaky wallclock CI assertions.',
      },
      null,
      2,
    ),
  );
  await bounded.destroy();
} finally {
  await prisma.user.delete({ where: { id: user.id } });
  await Promise.all([memory.destroy(), redis?.destroy()]);
  await prisma.$disconnect();
}
