import type Redis from 'ioredis';
import { createRedisClient, readyRedis } from './redis';

export interface WindowRule {
  key: string;
  name: string;
  max: number;
  windowMs: number;
}
export interface HierarchicalResult {
  allowed: boolean;
  rule: string;
  limit: number;
  remaining: number;
  resetTime: number;
}
export interface HierarchicalStore {
  consume(rules: WindowRule[], penaltyKey: string): Promise<HierarchicalResult>;
  penalize(key: string): Promise<void>;
  destroy(): Promise<void>;
}
interface Penalty {
  count: number;
  until: number;
  expires: number;
}
const PENALTY_TTL: number = 15 * 60 * 1000;

/** 不正設定がRedisの無制限メモリ消費につながらないよう検証する。 */
export function validateRules(rules: WindowRule[]): void {
  if (rules.length === 0 || rules.length > 10) throw new Error('Invalid rate limit rule count');
  for (const rule of rules) {
    if (
      !Number.isSafeInteger(rule.max) ||
      rule.max < 1 ||
      rule.max > 100000 ||
      !Number.isSafeInteger(rule.windowMs) ||
      rule.windowMs < 1 ||
      rule.windowMs > 86400000
    )
      throw new Error('Invalid rate limit rule');
  }
  if (new Set(rules.map((rule: WindowRule): string => rule.key)).size !== rules.length)
    throw new Error('Duplicate rate limit keys');
}

/** ローリング窓を一括判定する。拒否時は他の階層の枠を消費しない。 */
export class MemoryHierarchicalStore implements HierarchicalStore {
  private windows: Map<string, number[]> = new Map();
  private expiries: Map<string, number> = new Map();
  private penalties: Map<string, Penalty> = new Map();
  constructor(
    private clock: () => number = Date.now,
    private maxKeys: number = 10000,
  ) {}

  async consume(rules: WindowRule[], penaltyKey: string): Promise<HierarchicalResult> {
    validateRules(rules);
    const now: number = this.clock();
    this.cleanup(now);
    const penalty: Penalty | undefined = this.penalties.get(penaltyKey);
    if (penalty && penalty.until > now)
      return { allowed: false, rule: 'penalty', limit: 0, remaining: 0, resetTime: penalty.until };
    if (
      this.windows.size +
        rules.filter((r: WindowRule): boolean => !this.windows.has(r.key)).length >
      this.maxKeys
    )
      throw new Error('Rate limit capacity exceeded');
    const evaluated = rules.map((rule: WindowRule) => {
      const events: number[] = (this.windows.get(rule.key) ?? []).filter(
        (timestamp: number): boolean => timestamp > now - rule.windowMs,
      );
      return { rule, events, resetTime: (events[0] ?? now) + rule.windowMs };
    });
    const denied = evaluated
      .filter(({ rule, events }): boolean => events.length >= rule.max)
      .sort((a, b): number => b.resetTime - a.resetTime)[0];
    if (denied)
      return {
        allowed: false,
        rule: denied.rule.name,
        limit: denied.rule.max,
        remaining: 0,
        resetTime: denied.resetTime,
      };
    let result: HierarchicalResult | undefined;
    for (const { rule, events, resetTime } of evaluated) {
      events.push(now);
      this.windows.set(rule.key, events);
      this.expiries.set(rule.key, now + rule.windowMs);
      const remaining: number = rule.max - events.length;
      if (!result || remaining / rule.max < result.remaining / result.limit)
        result = { allowed: true, rule: rule.name, limit: rule.max, remaining, resetTime };
    }
    if (!result) throw new Error('No rate limit result');
    return result;
  }

  async penalize(key: string): Promise<void> {
    const now: number = this.clock();
    this.cleanup(now);
    if (!this.penalties.has(key) && this.penalties.size >= this.maxKeys)
      throw new Error('Penalty capacity exceeded');
    const previous: Penalty | undefined = this.penalties.get(key);
    const count: number = Math.min(16, (previous?.count ?? 0) + 1);
    const delay: number = count < 3 ? 0 : Math.min(60000, 1000 * 2 ** (count - 3));
    this.penalties.set(key, { count, until: now + delay, expires: now + PENALTY_TTL });
  }

  private cleanup(now: number): void {
    for (const [key, expiry] of this.expiries)
      if (expiry <= now) {
        this.expiries.delete(key);
        this.windows.delete(key);
      }
    for (const [key, penalty] of this.penalties)
      if (penalty.expires <= now) this.penalties.delete(key);
  }

  async destroy(): Promise<void> {
    this.windows.clear();
    this.expiries.clear();
    this.penalties.clear();
  }
}

// Redisの時計を使い、全階層を検査してから一括記録する。
const SLIDING_SCRIPT: string = `
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
local block = tonumber(redis.call('HGET', KEYS[#KEYS], 'until')) or 0
if block > now then return {0, 'penalty', 0, 0, block} end
local denied = nil
local selected = nil
for i=1,#KEYS-1 do
  local max = tonumber(ARGV[(i-1)*3+1])
  local window = tonumber(ARGV[(i-1)*3+2])
  local name = ARGV[(i-1)*3+3]
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now-window)
  local count = redis.call('ZCARD', KEYS[i])
  local first = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
  local reset = (tonumber(first[2]) or now)+window
  if count >= max then
    if not denied or reset > denied[5] then denied = {0, name, max, 0, reset} end
  elseif not selected or (max-count-1)/max < selected[4]/selected[3] then
    selected = {1, name, max, max-count-1, reset}
  end
end
if denied then return denied end
for i=1,#KEYS-1 do
  redis.call('ZADD', KEYS[i], now, ARGV[#ARGV])
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[(i-1)*3+2]))
end
return selected
`;
const PENALTY_SCRIPT: string = `
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
local count = math.min(16, (tonumber(redis.call('HGET', KEYS[1], 'count')) or 0)+1)
local delay = 0
if count >= 3 then delay = math.min(60000, 1000*2^(count-3)) end
redis.call('HSET', KEYS[1], 'count', count, 'until', now+delay)
redis.call('PEXPIRE', KEYS[1], ${PENALTY_TTL})
return count
`;

/** Redis 6以降のsorted setとLuaで複数サーバー間の同時判定を直列化する。 */
export class RedisHierarchicalStore implements HierarchicalStore {
  private client: Redis;
  constructor(
    url: string,
    private prefix: string = 'cms:v1:{limits}:',
  ) {
    this.client = createRedisClient(url);
  }

  async consume(rules: WindowRule[], penaltyKey: string): Promise<HierarchicalResult> {
    validateRules(rules);
    const args: (string | number)[] = rules.flatMap((rule: WindowRule): (string | number)[] => [
      rule.max,
      rule.windowMs,
      rule.name,
    ]);
    const value: unknown = await (await readyRedis(this.client)).eval(
      SLIDING_SCRIPT,
      rules.length + 1,
      ...rules.map((rule: WindowRule): string => this.prefix + rule.key),
      this.prefix + 'penalty:' + penaltyKey,
      ...args,
      crypto.randomUUID(),
    );
    if (!Array.isArray(value) || value.length !== 5)
      throw new Error('Invalid sliding window result');
    const [allowed, rule, limit, remaining, resetTime]: unknown[] = value;
    if (
      (allowed !== 0 && allowed !== 1) ||
      typeof rule !== 'string' ||
      typeof limit !== 'number' ||
      typeof remaining !== 'number' ||
      typeof resetTime !== 'number' ||
      !Number.isSafeInteger(limit) ||
      !Number.isSafeInteger(remaining) ||
      !Number.isSafeInteger(resetTime)
    )
      throw new Error('Invalid sliding window result');
    return { allowed: allowed === 1, rule, limit, remaining, resetTime };
  }

  async penalize(key: string): Promise<void> {
    await (await readyRedis(this.client)).eval(PENALTY_SCRIPT, 1, this.prefix + 'penalty:' + key);
  }

  async destroy(): Promise<void> {
    this.client.disconnect();
  }
}
