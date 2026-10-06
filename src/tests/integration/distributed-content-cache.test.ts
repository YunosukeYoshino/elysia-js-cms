import { expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type Redis from 'ioredis';
import { readContentRevision } from '../../lib/content-revision';
import prisma from '../../lib/prisma';
import { createRedisClient, readyRedis } from '../../lib/redis';
import { RedisCacheStore, SharedCache } from '../../lib/shared-cache';
import { responseCompression } from '../../middlewares/compression';
import { createContentCache } from '../../middlewares/content-cache';
import { domainErrorPlugin } from '../../middlewares/domain-error';
import { PostService } from '../../services/post-service';
import { seedUser } from './helpers';

interface ContentNode {
  request(): Promise<Response>;
  reads(): number;
}

/** 各ノードで独立したキャッシュ・サービス・HTTPアプリを実際のDBへ接続する。 */
function createContentNode(cache: SharedCache, postId: number): ContentNode {
  const service: PostService = new PostService(prisma);
  let reads: number = 0;
  const app = new Elysia()
    .use(responseCompression)
    .use(domainErrorPlugin)
    .use(
      createContentCache({
        cache,
        currentRevision: () => readContentRevision(prisma),
        nextPublication: () => service.nextPublication(),
      }),
    )
    .get('/api/posts/:id', ({ params }): Promise<Awaited<ReturnType<PostService['getById']>>> => {
      reads++;
      return service.getById(Number(params.id), null);
    });
  return {
    request: (): Promise<Response> =>
      app.handle(
        new Request(`http://localhost/api/posts/${postId}`, {
          headers: { 'Accept-Encoding': 'gzip' },
        }),
      ),
    reads: (): number => reads,
  };
}

it.skipIf(!process.env.REDIS_TEST_URL)(
  'shares compressed public content across Redis nodes and hides direct DB unpublishes without invalidation',
  async () => {
    const url: string = process.env.REDIS_TEST_URL ?? '';
    const prefix: string = `distributed-content-test:${crypto.randomUUID()}:`;
    const firstStore: RedisCacheStore = new RedisCacheStore(url, prefix);
    const secondStore: RedisCacheStore = new RedisCacheStore(url, prefix);
    const firstCache: SharedCache = new SharedCache(firstStore, 'redis');
    const secondCache: SharedCache = new SharedCache(secondStore, 'redis');
    const observer: Redis = createRedisClient(url);
    let authorId: number | null = null;
    try {
      await readyRedis(observer);
      const author = await seedUser(prisma, 'distributed-content');
      authorId = author.id;
      const marker: string = `private-after-unpublish-${crypto.randomUUID()}`;
      const post = await prisma.post.create({
        data: {
          title: marker,
          content: `${marker} ${'public-content '.repeat(500)}`,
          published: true,
          authorId,
        },
      });
      const firstNode: ContentNode = createContentNode(firstCache, post.id);
      const secondNode: ContentNode = createContentNode(secondCache, post.id);
      const initialRevision: string = await readContentRevision(prisma);
      let original: string | null = null;
      for (const [node, expected] of [
        [firstNode, 'MISS'],
        [secondNode, 'HIT'],
      ] as const) {
        const response: Response = await node.request();
        expect(response.status).toBe(200);
        expect(response.headers.get('X-Cache')).toBe(expected);
        expect(response.headers.get('Content-Encoding')).toBe('gzip');
        expect(response.headers.get('Vary')).toContain('Accept-Encoding');
        const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await response.arrayBuffer());
        const decoded: string = new TextDecoder().decode(Bun.gunzipSync(bytes));
        const payload: unknown = JSON.parse(decoded);
        expect(bytes.byteLength).toBeLessThan(new TextEncoder().encode(decoded).byteLength);
        expect(payload).toMatchObject({ id: post.id, content: post.content, published: true });
        if (original === null) original = decoded;
        else expect(decoded).toBe(original);
      }
      expect(firstNode.reads()).toBe(1);
      expect(secondNode.reads()).toBe(0);
      expect(secondCache.stats()).toMatchObject({ backend: 'redis', hits: 1, errors: 0 });

      const keys: string[] = await observer.keys(`${prefix}content:*`);
      expect(keys).toHaveLength(1);
      const cachedKey: string = keys[0];
      const cachedValue: string | null = await observer.get(cachedKey);
      expect(cachedValue).toContain(marker);
      expect(await firstStore.generation('content')).toBe('0');

      // Redis無効化を一切行わず、移行済みSQLiteのトリガーだけで版を進める。
      await prisma.post.update({ where: { id: post.id }, data: { published: false } });
      const updatedRevision: string = await readContentRevision(prisma);
      expect(BigInt(updatedRevision)).toBeGreaterThan(BigInt(initialRevision));
      expect(await secondStore.generation('content')).toBe('0');
      expect(await observer.get(cachedKey)).toBe(cachedValue);

      for (const node of [firstNode, secondNode]) {
        for (let attempt: number = 0; attempt < 2; attempt++) {
          const hidden: Response = await node.request();
          expect(hidden.status).toBe(404);
          expect(hidden.headers.get('X-Cache')).toBe('MISS');
          expect(hidden.headers.get('Content-Encoding')).toBeNull();
          const body: string = await hidden.text();
          expect(body).not.toContain(marker);
          expect(body).not.toContain(post.content);
          const payload: unknown = JSON.parse(body);
          expect(payload).toMatchObject({ code: 'POST_ERROR', success: false });
        }
      }
      expect(firstNode.reads()).toBe(3);
      expect(secondNode.reads()).toBe(2);
      expect(await observer.get(cachedKey)).toBe(cachedValue);
      expect(await observer.keys(`${prefix}content:*`)).toEqual(keys);
      expect(await firstStore.generation('content')).toBe('0');
      expect(firstCache.stats().errors + secondCache.stats().errors).toBe(0);
    } finally {
      try {
        if (authorId !== null) {
          await prisma.post.deleteMany({ where: { authorId } });
          await prisma.user.delete({ where: { id: authorId } });
        }
      } finally {
        try {
          const keys: string[] = await (await readyRedis(observer)).keys(`${prefix}*`);
          if (keys.length) await observer.del(...keys);
        } finally {
          await Promise.all([firstCache.destroy(), secondCache.destroy()]);
          observer.disconnect();
        }
      }
    }
  },
);
