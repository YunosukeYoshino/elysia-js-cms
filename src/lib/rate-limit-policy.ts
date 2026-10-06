import { isIP } from 'node:net';
import type { CachedUser } from './auth-cache';
import {
  type HierarchicalResult,
  type HierarchicalStore,
  MemoryHierarchicalStore,
  RedisHierarchicalStore,
  type WindowRule,
} from './hierarchical-rate-limit-store';

export interface WindowConfig {
  max: number;
  windowMs: number;
}
export interface RateLimitPolicy {
  global: WindowConfig;
  ip: WindowConfig;
  user: WindowConfig;
  auth: WindowConfig;
  upload: WindowConfig;
  burst: WindowConfig;
  adminMultiplier: number;
  trustedProxies: string[];
  restrictedIPs: Record<string, WindowConfig>;
}
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  global: { max: 10000, windowMs: 60000 },
  ip: { max: 120, windowMs: 60000 },
  user: { max: 300, windowMs: 60000 },
  auth: { max: 10, windowMs: 60000 },
  upload: { max: 5, windowMs: 60000 },
  burst: { max: 20, windowMs: 1000 },
  adminMultiplier: 10,
  trustedProxies: [],
  restrictedIPs: {},
};

function windowConfig(value: unknown): value is WindowConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'max' in value &&
    typeof value.max === 'number' &&
    Number.isSafeInteger(value.max) &&
    value.max >= 1 &&
    value.max <= 10000 &&
    'windowMs' in value &&
    typeof value.windowMs === 'number' &&
    Number.isSafeInteger(value.windowMs) &&
    value.windowMs >= 1 &&
    value.windowMs <= 86400000
  );
}

/** 不明な環境設定を拒否し、起動時に明示的なエラーにする。 */
export function readRateLimitPolicy(
  raw: string | undefined = process.env.RATE_LIMIT_POLICY,
): RateLimitPolicy {
  const policy: RateLimitPolicy = structuredClone(DEFAULT_RATE_LIMIT_POLICY);
  if (!raw) return policy;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Invalid RATE_LIMIT_POLICY');
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key === 'global' ||
      key === 'ip' ||
      key === 'user' ||
      key === 'auth' ||
      key === 'upload' ||
      key === 'burst'
    ) {
      if (!windowConfig(value)) throw new Error('Invalid rate limit window');
      policy[key] = value;
    } else if (key === 'adminMultiplier') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10)
        throw new Error('Invalid administrator multiplier');
      policy.adminMultiplier = value;
    } else if (key === 'trustedProxies') {
      if (
        !Array.isArray(value) ||
        !value.every(
          (entry: unknown): entry is string => typeof entry === 'string' && isIP(entry) !== 0,
        )
      )
        throw new Error('Invalid trusted proxies');
      policy.trustedProxies = value;
    } else if (key === 'restrictedIPs') {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid restricted IPs');
      for (const [ip, rule] of Object.entries(value)) {
        if (!isIP(ip) || !windowConfig(rule)) throw new Error('Invalid restricted IP rule');
        policy.restrictedIPs[normalizeIP(ip)] = rule;
      }
    } else throw new Error(`Unknown rate limit setting: ${key}`);
  }
  return policy;
}

/** IPv4-mapped IPv6とIPv6の表記差による制限回避を防ぐ。 */
export function normalizeIP(ip: string): string {
  const unscoped: string = ip.split('%')[0];
  if (isIP(unscoped) !== 6) return unscoped;
  const normalized: string = new URL(`http://[${unscoped}]/`).hostname.slice(1, -1);
  const mapped: RegExpMatchArray | null = normalized.match(
    /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/,
  );
  if (!mapped) return normalized;
  const high: number = Number.parseInt(mapped[1], 16);
  const low: number = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** 信頼済み接続元だけの転送ヘッダーを右端から検証する。 */
export function trustedClientIP(
  peer: string | undefined,
  headers: Headers,
  trustedProxies: string[],
): string {
  if (!peer || !isIP(peer)) return 'unknown';
  const normalizedPeer: string = normalizeIP(peer);
  const trusted: Set<string> = new Set(trustedProxies.map(normalizeIP));
  if (!trusted.has(normalizedPeer)) return normalizedPeer;
  const forwarded: string | null = headers.get('x-forwarded-for');
  if (!forwarded) return normalizedPeer;
  const chain: string[] = forwarded.split(',').map((entry: string): string => entry.trim());
  if (chain.length > 20 || chain.some((ip: string): boolean => !isIP(ip) || ip.includes('%')))
    return normalizedPeer;
  let current: string = normalizedPeer;
  for (let i: number = chain.length - 1; i >= 0 && trusted.has(current); i--)
    current = normalizeIP(chain[i]);
  return current;
}

export type EndpointKind = 'auth' | 'upload' | 'api';
export interface LimitIdentity {
  ip: string;
  user: CachedUser | null;
  endpoint: EndpointKind;
}
export interface Admission extends HierarchicalResult {
  unavailable: boolean;
}
export interface LimitStats {
  allowed: number;
  denied: number;
  unavailable: number;
  penalties: number;
  backend: 'memory' | 'redis';
  lastDenial: { rule: string; at: string } | null;
}

/** 共通・接続元・ユーザー・エンドポイント・短期バーストの積集合を適用する。 */
export class HierarchicalRateLimiter {
  private metrics: LimitStats;
  constructor(
    private store: HierarchicalStore,
    readonly policy: RateLimitPolicy = readRateLimitPolicy(),
    backend: 'memory' | 'redis' = 'memory',
    private log: (message: string) => void = console.warn,
  ) {
    this.metrics = {
      allowed: 0,
      denied: 0,
      unavailable: 0,
      penalties: 0,
      backend,
      lastDenial: null,
    };
  }

  private penaltyKey(identity: LimitIdentity): string {
    return `${identity.endpoint}:${identity.ip}`;
  }

  /** Redis障害時は503にし、各サーバーに独立した枠を発行しない。 */
  async check(identity: LimitIdentity): Promise<Admission> {
    const { ip, user, endpoint } = identity;
    const multiplier: number = user?.role === 'admin' ? this.policy.adminMultiplier : 1;
    const rules: WindowRule[] = [];
    const add = (name: string, key: string, window: WindowConfig, factor: number = 1): void => {
      rules.push({
        name,
        key: `${name}:${key}`,
        max: window.max * factor,
        windowMs: window.windowMs,
      });
    };
    add('global', 'all', this.policy.global);
    add('ip', ip, this.policy.ip, user ? Math.max(2, multiplier) : 1);
    add('burst', ip, this.policy.burst, user ? Math.max(2, multiplier) : 1);
    if (user) add('user', user.id.toString(), this.policy.user, multiplier);
    if (endpoint !== 'api') add(endpoint, ip, this.policy[endpoint], multiplier);
    const restricted: WindowConfig | undefined = this.policy.restrictedIPs[ip];
    if (restricted) add('restricted-ip', ip, restricted);
    try {
      const result: HierarchicalResult = await this.store.consume(rules, this.penaltyKey(identity));
      if (result.allowed) this.metrics.allowed++;
      else {
        this.metrics.denied++;
        this.metrics.lastDenial = { rule: result.rule, at: new Date().toISOString() };
        if (this.metrics.denied === 1 || this.metrics.denied % 100 === 0)
          this.log(
            JSON.stringify({
              event: 'rate-limit-denied',
              rule: result.rule,
              count: this.metrics.denied,
            }),
          );
        if (endpoint === 'upload' && result.rule !== 'penalty') await this.penalize(identity);
      }
      return { ...result, unavailable: false };
    } catch {
      this.metrics.unavailable++;
      if (this.metrics.unavailable === 1 || this.metrics.unavailable % 100 === 0)
        this.log(
          JSON.stringify({ event: 'rate-limit-unavailable', backend: this.metrics.backend }),
        );
      return {
        allowed: false,
        unavailable: true,
        rule: 'unavailable',
        limit: 0,
        remaining: 0,
        resetTime: Date.now() + 1000,
      };
    }
  }

  /** 認証失敗と過剰アップロードを15分間記憶し、待機時間を1秒から60秒まで増加する。 */
  async penalize(identity: LimitIdentity): Promise<void> {
    try {
      await this.store.penalize(this.penaltyKey(identity));
      this.metrics.penalties++;
    } catch {
      this.metrics.unavailable++;
    }
  }

  /** 個人識別子を含めない、プロセス単位の集計を返す。 */
  stats(): LimitStats {
    return structuredClone(this.metrics);
  }
  async destroy(): Promise<void> {
    await this.store.destroy();
  }
}

/** Redis構成時の障害はfail-closed、未構成時だけ上限付きメモリを利用する。 */
export function createHierarchicalRateLimiter(
  url: string | undefined = process.env.REDIS_URL,
): HierarchicalRateLimiter {
  return new HierarchicalRateLimiter(
    url ? new RedisHierarchicalStore(url) : new MemoryHierarchicalStore(),
    readRateLimitPolicy(),
    url ? 'redis' : 'memory',
  );
}
export const hierarchicalRateLimiter: HierarchicalRateLimiter = createHierarchicalRateLimiter();
