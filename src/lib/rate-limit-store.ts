import Redis from 'ioredis';
/**
 * レート制限ストレージの抽象化
 * インメモリ（開発用）とRedis（本番用）バックエンドをサポート
 */

export interface RateLimitData {
  count: number;
  resetTime: number;
}

export interface RateLimitStore {
  get(key: string): Promise<RateLimitData | null>;
  set(key: string, data: RateLimitData, ttlMs: number): Promise<void>;
  increment(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  cleanup(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * インメモリレート制限ストア（開発/テスト用）
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private store: Map<string, RateLimitData> = new Map();
  private cleanupInterval: Timer | null = null;

  constructor(cleanupIntervalMs: number = 60000) {
    // 1分ごとに期限切れエントリをクリーンアップ
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  async get(key: string): Promise<RateLimitData | null> {
    const data = this.store.get(key);

    if (!data) return null;

    // 期限切れかチェック
    if (data.resetTime <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return data;
  }

  async set(key: string, data: RateLimitData, _ttlMs: number): Promise<void> {
    // TTLはデータ構造内のresetTimeによって処理される
    this.store.set(key, data);
  }

  async increment(key: string): Promise<number> {
    const existing = await this.get(key);
    if (!existing) {
      throw new Error('Key does not exist for increment');
    }

    existing.count++;
    await this.set(key, existing, 0); // ttlは不要、resetTimeが設定されている

    return existing.count;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [key, data] of this.store.entries()) {
      if (data.resetTime <= now) {
        this.store.delete(key);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

/**
 * Redisレート制限ストア（本番用）
 * redisパッケージのインストールが必要
 */
export class RedisRateLimitStore implements RateLimitStore {
  private redis: Redis | null = null;

  constructor(
    private redisUrl: string = 'redis://localhost:6379',
    private keyPrefix: string = 'rate_limit:',
  ) {}

  private connect(): Redis {
    if (!this.redis) this.redis = new Redis(this.redisUrl);
    return this.redis;
  }

  async get(key: string): Promise<RateLimitData | null> {
    const redis = this.connect();

    const fullKey = this.keyPrefix + key;
    const data = await redis.hmget(fullKey, 'count', 'resetTime');

    if (!data[0] || !data[1]) return null;

    const rateLimitData: RateLimitData = {
      count: parseInt(data[0], 10),
      resetTime: parseInt(data[1], 10),
    };

    // 期限切れかチェック
    if (rateLimitData.resetTime <= Date.now()) {
      await this.delete(key);
      return null;
    }

    return rateLimitData;
  }

  async set(key: string, data: RateLimitData, ttlMs: number): Promise<void> {
    const redis = this.connect();

    const fullKey = this.keyPrefix + key;
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    await redis
      .multi()
      .hmset(fullKey, 'count', data.count, 'resetTime', data.resetTime)
      .expire(fullKey, ttlSeconds)
      .exec();
  }

  async increment(key: string): Promise<number> {
    const redis = this.connect();

    const fullKey = this.keyPrefix + key;
    const newCount = await redis.hincrby(fullKey, 'count', 1);

    return newCount;
  }

  async delete(key: string): Promise<void> {
    const redis = this.connect();

    const fullKey = this.keyPrefix + key;
    await redis.del(fullKey);
  }

  async cleanup(): Promise<void> {
    // RedisはTTLを自動的に処理するため、手動クリーンアップは不要
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

/**
 * 環境に基づいて適切なレート制限ストアを作成
 */
export function createRateLimitStore(): RateLimitStore {
  const redisUrl = process.env.REDIS_URL;
  const useRedis = process.env.NODE_ENV === 'production' && redisUrl;

  if (useRedis) {
    try {
      return new RedisRateLimitStore(redisUrl);
    } catch (_error) {
      console.warn('⚠️  Redis unavailable, falling back to memory store');
    }
  }

  return new MemoryRateLimitStore();
}
