/**
 * Rate limit storage abstraction
 * Supports in-memory (development) and Redis (production) backends
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
 * In-memory rate limit store (development/testing)
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private store: Map<string, RateLimitData> = new Map();
  private cleanupInterval: Timer | null = null;

  constructor(cleanupIntervalMs: number = 60000) {
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  async get(key: string): Promise<RateLimitData | null> {
    const data = this.store.get(key);

    if (!data) return null;

    // Check if expired
    if (data.resetTime <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return data;
  }

  async set(key: string, data: RateLimitData, _ttlMs: number): Promise<void> {
    // TTL is handled by resetTime in the data structure
    this.store.set(key, data);
  }

  async increment(key: string): Promise<number> {
    const existing = await this.get(key);
    if (!existing) {
      throw new Error('Key does not exist for increment');
    }

    existing.count++;
    await this.set(key, existing, 0); // ttl not needed, resetTime is set

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
 * Redis rate limit store (production)
 * Requires redis package to be installed
 */
// Interface for Redis client to avoid 'any' type
interface RedisClient {
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  multi(): RedisMulti;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  del(key: string): Promise<number>;
  quit(): Promise<void>;
}

interface RedisMulti {
  hmset(key: string, ...args: (string | number)[]): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  exec(): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  private redis: RedisClient | null = null;
  private connected: boolean = false;

  constructor(
    private redisUrl: string = 'redis://localhost:6379',
    private keyPrefix: string = 'rate_limit:',
  ) {}

  private async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Dynamic import to make Redis optional
      const Redis = await import('ioredis').then((m) => m.default);
      this.redis = new Redis(this.redisUrl);
      this.connected = true;

      console.log('✅ Redis rate limiter connected');
    } catch (_error) {
      console.error('❌ Redis connection failed. Falling back to memory store.');
      throw new Error('Redis not available. Install ioredis: bun add ioredis');
    }
  }

  async get(key: string): Promise<RateLimitData | null> {
    await this.connect();

    const fullKey = this.keyPrefix + key;
    const data = await this.redis.hmget(fullKey, 'count', 'resetTime');

    if (!data[0] || !data[1]) return null;

    const rateLimitData: RateLimitData = {
      count: parseInt(data[0], 10),
      resetTime: parseInt(data[1], 10),
    };

    // Check if expired
    if (rateLimitData.resetTime <= Date.now()) {
      await this.delete(key);
      return null;
    }

    return rateLimitData;
  }

  async set(key: string, data: RateLimitData, ttlMs: number): Promise<void> {
    await this.connect();

    const fullKey = this.keyPrefix + key;
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    await this.redis
      .multi()
      .hmset(fullKey, 'count', data.count, 'resetTime', data.resetTime)
      .expire(fullKey, ttlSeconds)
      .exec();
  }

  async increment(key: string): Promise<number> {
    await this.connect();

    const fullKey = this.keyPrefix + key;
    const newCount = await this.redis.hincrby(fullKey, 'count', 1);

    return newCount;
  }

  async delete(key: string): Promise<void> {
    await this.connect();

    const fullKey = this.keyPrefix + key;
    await this.redis.del(fullKey);
  }

  async cleanup(): Promise<void> {
    // Redis handles TTL automatically, no manual cleanup needed
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    if (this.redis && this.connected) {
      await this.redis.quit();
      this.connected = false;
    }
  }
}

/**
 * Create appropriate rate limit store based on environment
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
