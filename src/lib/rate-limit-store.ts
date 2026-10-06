import Redis from 'ioredis';
/**
 * レート制限ストレージの抽象化
 * インメモリ（開発用）とRedis（本番用）バックエンドをサポート
 */

export interface RateLimitData {
  count: number;
  resetTime: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
}

export interface RateLimitStore {
  /** 時間窓の更新、上限判定、許可したリクエストの加算を不可分に実行する。 */
  consume(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
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

  /** 時間窓の更新から加算まで await を挟まず、同時リクエストを直列化する。 */
  async consume(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    const now: number = Date.now();
    let data: RateLimitData | undefined = this.store.get(key);
    if (!data || data.resetTime <= now) {
      data = { count: 0, resetTime: now + windowMs };
      this.store.set(key, data);
    }

    const allowed: boolean = data.count < max;
    if (allowed) data.count++;

    return {
      allowed,
      remaining: Math.max(0, max - data.count),
      resetTime: data.resetTime,
    };
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

// Redis側の時計と単一スクリプトで、複数プロセス間でも判定と加算を不可分にする。
const CONSUME_SCRIPT: string = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local data = redis.call('HMGET', key, 'count', 'resetTime')
local count = tonumber(data[1])
local resetTime = tonumber(data[2])

if not count or not resetTime or resetTime <= now then
  count = 0
  resetTime = now + windowMs
  redis.call('HSET', key, 'count', count, 'resetTime', resetTime)
  redis.call('PEXPIREAT', key, resetTime)
end

local allowed = 0
if count < max then
  count = redis.call('HINCRBY', key, 'count', 1)
  allowed = 1
end

return { allowed, math.max(0, max - count), resetTime }
`;

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

  /** 上限判定、加算、期限設定を単一のLuaスクリプトで実行する。 */
  async consume(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    const redis: Redis = this.connect();
    const result: unknown = await redis.eval(
      CONSUME_SCRIPT,
      1,
      this.keyPrefix + key,
      max,
      windowMs,
    );
    if (!Array.isArray(result) || result.length !== 3) {
      throw new Error('Invalid rate limit response from Redis');
    }

    const [allowed, remaining, resetTime]: unknown[] = result;
    if (
      (allowed !== 0 && allowed !== 1) ||
      typeof remaining !== 'number' ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      typeof resetTime !== 'number' ||
      !Number.isSafeInteger(resetTime)
    ) {
      throw new Error('Invalid rate limit response from Redis');
    }

    return { allowed: allowed === 1, remaining, resetTime };
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
