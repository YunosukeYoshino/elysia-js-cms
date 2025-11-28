/**
 * レート制限ミドルウェア
 * ブルートフォース攻撃やAPI乱用を防ぐためのレート制限機能を提供
 * セキュリティ強化とメモリリーク修正版
 */

import { Elysia } from 'elysia';
import { extractClientIP, generateRateLimitKey, type RequestLike } from '../lib/network';
import {
  createRateLimitStore,
  type RateLimitData,
  type RateLimitStore,
} from '../lib/rate-limit-store';

export interface RateLimitOptions {
  windowMs: number; // 時間窓（ミリ秒）
  max: number; // 最大リクエスト数
  message?: string; // エラーメッセージ
  keyGenerator?: (request: RequestLike) => string; // キー生成関数
  skipSuccessfulRequests?: boolean; // 成功したリクエストをカウントしないか
}

class RateLimiter {
  private store: RateLimitStore;
  private options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions, store?: RateLimitStore) {
    this.options = {
      windowMs: options.windowMs,
      max: options.max,
      message:
        options.message || 'リクエスト制限に達しました。しばらく待ってから再試行してください。',
      keyGenerator: options.keyGenerator || extractClientIP, // 共通のIP抽出関数を使用
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
    };

    // Use provided store or create default
    this.store = store || createRateLimitStore();
  }

  /**
   * リソースのクリーンアップ（メモリリーク対策）
   */
  async destroy(): Promise<void> {
    await this.store.destroy();
  }

  async check(
    request: RequestLike,
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const key = this.options.keyGenerator(request);
    const now = Date.now();

    const existing = await this.store.get(key);

    if (!existing || existing.resetTime <= now) {
      const newData: RateLimitData = {
        count: 1,
        resetTime: now + this.options.windowMs,
      };

      await this.store.set(key, newData, this.options.windowMs);

      return {
        allowed: true,
        remaining: this.options.max - 1,
        resetTime: newData.resetTime,
      };
    }

    if (existing.count >= this.options.max) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: existing.resetTime,
      };
    }

    try {
      const newCount = await this.store.increment(key);
      return {
        allowed: true,
        remaining: this.options.max - newCount,
        resetTime: existing.resetTime,
      };
    } catch {
      // Fallback to manual increment if store doesn't support atomic increment
      existing.count++;
      await this.store.set(key, existing, existing.resetTime - now);

      return {
        allowed: true,
        remaining: this.options.max - existing.count,
        resetTime: existing.resetTime,
      };
    }
  }

  async reset(request: RequestLike): Promise<void> {
    const key = this.options.keyGenerator(request);
    await this.store.delete(key);
  }
}

/**
 * レート制限ミドルウェアを作成
 */
export function createRateLimit(options: RateLimitOptions, store?: RateLimitStore) {
  const limiter = new RateLimiter(options, store);

  return new Elysia().derive(async ({ request, set }) => {
    const result = await limiter.check(request);

    // レスポンスヘッダーを設定（標準的なUnixタイムスタンプ形式）
    set.headers = {
      ...set.headers,
      'X-RateLimit-Limit': options.max.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.floor(result.resetTime / 1000).toString(), // Unixタイムスタンプ（秒）
    };

    if (!result.allowed) {
      set.status = 429;
      throw new Error(limiter.options.message);
    }

    return {
      rateLimit: {
        reset: () => limiter.reset(request),
      },
    };
  });
}

/**
 * 認証エンドポイント用のレート制限
 */
export const authRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 5, // 15分間に5回まで
  message: 'ログイン試行回数が上限に達しました。15分後に再試行してください。',
  keyGenerator: (request: RequestLike) => generateRateLimitKey('auth', request),
});

/**
 * 一般API用のレート制限
 */
export const generalRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 15分間に100回まで
  message: 'リクエスト制限に達しました。15分後に再試行してください。',
});

/**
 * 登録エンドポイント用のレート制限
 */
export const registerRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000, // 1時間
  max: 3, // 1時間に3回まで
  message: 'アカウント作成の制限に達しました。1時間後に再試行してください。',
  keyGenerator: (request: RequestLike) => generateRateLimitKey('register', request),
});
