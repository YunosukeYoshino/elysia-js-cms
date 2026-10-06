import type Redis from 'ioredis';
import { createRedisClient, readyRedis } from './redis';

export const AUTH_CACHE_TTL_MS: number = 5 * 60 * 1000;
export const CONTENT_CACHE_TTL_MS: number = 60 * 1000;

export interface CacheRead {
  token: string;
  value: string | null;
}

export interface CacheStore {
  read(scope: string, key: string): Promise<CacheRead>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlMs: number): Promise<void>;
  generation(scope: string): Promise<string>;
  invalidate(scope: string): Promise<void>;
  destroy(): Promise<void>;
}

/** 開発用の上限付きキャッシュ。期限切れ値は読み取り時にも削除する。 */
export class MemoryCacheStore implements CacheStore {
  private entries: Map<string, { value: string; expires: number }> = new Map();
  private generations: Map<string, string> = new Map();
  private characters: number = 0;
  constructor(
    private maxEntries: number = 1000,
    private clock: () => number = Date.now,
  ) {}

  async read(scope: string, key: string): Promise<CacheRead> {
    const token: string = `${scope}:${await this.generation(scope)}:${key}`;
    return { token, value: await this.get(token) };
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= this.clock()) {
      this.remove(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, ttlMs: number): Promise<void> {
    if (value.length > 1024 * 1024 || ttlMs <= 0) return;
    for (const [entryKey, entry] of this.entries) {
      if (entry.expires <= this.clock()) this.remove(entryKey);
    }
    this.remove(key);
    while (
      this.entries.size >= this.maxEntries ||
      this.characters + value.length > 8 * 1024 * 1024
    ) {
      const oldest: string | undefined = this.entries.keys().next().value;
      if (oldest) this.remove(oldest);
      else break;
    }
    this.entries.set(key, { value, expires: this.clock() + ttlMs });
    this.characters += value.length;
  }

  private remove(key: string): void {
    this.characters -= this.entries.get(key)?.value.length ?? 0;
    this.entries.delete(key);
  }

  /** 件数とUTF-16文字数の上限を監視する。値や識別子は返さない。 */
  size(): { entries: number; characters: number } {
    return { entries: this.entries.size, characters: this.characters };
  }

  async generation(scope: string): Promise<string> {
    return this.generations.get(scope) ?? '0';
  }

  async invalidate(scope: string): Promise<void> {
    this.generations.set(scope, crypto.randomUUID());
  }

  async destroy(): Promise<void> {
    this.entries.clear();
    this.characters = 0;
    this.generations.clear();
  }
}

/** 世代キーでプロセス間共有と更新中の古いfillの隔離を行う。 */
export class RedisCacheStore implements CacheStore {
  private client: Redis;
  constructor(
    url: string,
    private prefix: string = 'cms:v1:cache:',
  ) {
    this.client = createRedisClient(url);
  }

  /** 世代と値を一往復かつ不可分に読み取る。 */
  async read(scope: string, key: string): Promise<CacheRead> {
    const result: unknown = await (await readyRedis(this.client)).eval(
      `
local generation = redis.call('GET', KEYS[1]) or '0'
local token = ARGV[1] .. ':' .. generation .. ':' .. ARGV[2]
return {token, redis.call('GET', ARGV[3] .. token)}
`,
      1,
      this.prefix + `generation:${scope}`,
      scope,
      key,
      this.prefix,
    );
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== 'string' ||
      (result[1] !== null && typeof result[1] !== 'string')
    )
      throw new Error('Invalid cache response');
    return { token: result[0], value: result[1] };
  }

  async get(key: string): Promise<string | null> {
    return (await readyRedis(this.client)).get(this.prefix + key);
  }

  async put(key: string, value: string, ttlMs: number): Promise<void> {
    if (value.length > 1024 * 1024 || ttlMs <= 0) return;
    await (await readyRedis(this.client)).set(this.prefix + key, value, 'PX', ttlMs);
  }

  async generation(scope: string): Promise<string> {
    return (await this.get(`generation:${scope}`)) ?? '0';
  }

  async invalidate(scope: string): Promise<void> {
    // 世代は期限切れにしない。同じ世代の古いデータが復活するのを防ぐ。
    await (await readyRedis(this.client)).set(
      this.prefix + `generation:${scope}`,
      crypto.randomUUID(),
    );
  }

  async destroy(): Promise<void> {
    this.client.disconnect();
  }
}

export interface CacheStats {
  hits: number;
  localHits: number;
  misses: number;
  errors: number;
  bypasses: number;
  pendingInvalidations: number;
  backend: 'memory' | 'redis';
}

/** 障害時はDBを読み、Redis構成では整合性のないメモリ値を使わない。 */
export class SharedCache {
  private dirty: Map<string, string> = new Map();
  private authFront: MemoryCacheStore = new MemoryCacheStore();
  private inflight: Map<string, Promise<unknown>> = new Map();
  private counters: CacheStats;

  constructor(
    private store: CacheStore,
    backend: 'memory' | 'redis' = 'memory',
  ) {
    this.counters = {
      hits: 0,
      localHits: 0,
      misses: 0,
      errors: 0,
      bypasses: 0,
      pendingInvalidations: 0,
      backend,
    };
  }

  /** 認証専用L1。返却前のDB版・権限・存在検証は呼び出し元で必須。 */
  async authLocal<T>(key: string, validate: (value: unknown) => value is T): Promise<T | null> {
    const serialized: string | null = await this.authFront.get(key);
    if (!serialized) return null;
    const value: unknown = JSON.parse(serialized);
    return validate(value) ? value : null;
  }

  /** 認証L1のデータも最大5分で失効させる。 */
  async fillAuthLocal(key: string, value: unknown): Promise<void> {
    await this.authFront.put(key, JSON.stringify(value), AUTH_CACHE_TTL_MS);
  }

  /** DBで版と権限を検証できたL1ヒットだけを計測する。 */
  recordAuthLocalHit(): void {
    this.counters.localHits++;
    this.counters.hits++;
  }

  /** 読み取りとfillを分離し、レスポンスミドルウェアでも世代を固定する。 */
  async lookup<T>(
    scope: string,
    key: string,
    validate: (value: unknown) => value is T,
  ): Promise<{ hit: boolean; value: T | null; token: string | null }> {
    try {
      for (const [dirtyScope, revision] of this.dirty) {
        await this.store.invalidate(dirtyScope);
        if (this.dirty.get(dirtyScope) === revision) this.dirty.delete(dirtyScope);
      }
      const { token, value: cached } = await this.store.read(scope, key);
      if (cached !== null) {
        const parsed: unknown = JSON.parse(cached);
        if (validate(parsed)) {
          this.counters.hits++;
          return { hit: true, value: parsed, token };
        }
      }
      this.counters.misses++;
      return { hit: false, value: null, token };
    } catch {
      this.counters.errors++;
      this.counters.bypasses++;
      return { hit: false, value: null, token: null };
    }
  }

  /** lookup時の世代にだけ書く。更新後の世代へ古い値を混入させない。 */
  async fill(token: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      await this.store.put(token, JSON.stringify(value), ttlMs);
    } catch {
      this.counters.errors++;
    }
  }

  /** 検証済みJSONだけを返し、同一プロセスの同一キーfillをまとめる。 */
  async getOrLoad<T>(
    scope: string,
    key: string,
    ttlMs: number,
    validate: (value: unknown) => value is T,
    load: () => Promise<T>,
  ): Promise<T> {
    const lookup = await this.lookup(scope, key, validate);
    if (lookup.hit && validate(lookup.value)) return lookup.value;
    const fullKey: string | null = lookup.token;
    if (!fullKey) return load();
    const pending: Promise<unknown> | undefined = this.inflight.get(fullKey);
    if (pending) {
      const value: unknown = await pending;
      if (validate(value)) return value;
    }
    const fill: Promise<T> = load().then(async (value: T): Promise<T> => {
      await this.fill(fullKey, value, ttlMs);
      return value;
    });
    this.inflight.set(fullKey, fill);
    try {
      return await fill;
    } finally {
      this.inflight.delete(fullKey);
    }
  }

  /** 書き込み完了後に呼ぶ。失敗した無効化は次の読み取り前に再試行する。 */
  async invalidate(scope: string): Promise<void> {
    if (scope === 'auth') await this.authFront.destroy();
    const revision: string = crypto.randomUUID();
    this.dirty.set(scope, revision);
    try {
      await this.store.invalidate(scope);
      if (this.dirty.get(scope) === revision) this.dirty.delete(scope);
    } catch {
      this.counters.errors++;
    }
  }

  /** 個人情報を含まないプロセス単位の観測値。 */
  stats(): CacheStats {
    return { ...this.counters, pendingInvalidations: this.dirty.size };
  }

  async destroy(): Promise<void> {
    await this.authFront.destroy();
    await this.store.destroy();
  }
}

/** REDIS_URLがある全環境で共有Redisを使用する。 */
export function createSharedCache(url: string | undefined = process.env.REDIS_URL): SharedCache {
  return url
    ? new SharedCache(new RedisCacheStore(url), 'redis')
    : new SharedCache(new MemoryCacheStore());
}

export const sharedCache: SharedCache = createSharedCache();
