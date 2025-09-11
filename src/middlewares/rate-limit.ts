/**
 * レート制限ミドルウェア
 * ブルートフォース攻撃やAPI乱用を防ぐためのレート制限機能を提供
 */

import { Elysia } from 'elysia';

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

export interface RateLimitOptions {
  windowMs: number; // 時間窓（ミリ秒）
  max: number; // 最大リクエスト数
  message?: string; // エラーメッセージ
  keyGenerator?: (request: any) => string; // キー生成関数
  skipSuccessfulRequests?: boolean; // 成功したリクエストをカウントしないか
}

class RateLimiter {
  private store: RateLimitStore = {};
  private options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions) {
    this.options = {
      windowMs: options.windowMs,
      max: options.max,
      message: options.message || 'リクエスト制限に達しました。しばらく待ってから再試行してください。',
      keyGenerator: options.keyGenerator || ((request: any) => {
        // IPアドレスを取得（プロキシ環境を考慮）
        const forwarded = request.headers['x-forwarded-for'];
        const ip = forwarded ? forwarded.split(',')[0].trim() : 
                   request.headers['x-real-ip'] || 
                   request.ip || 
                   'unknown';
        return ip;
      }),
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
    };

    // 定期的に古いエントリをクリーンアップ
    setInterval(() => {
      this.cleanup();
    }, this.options.windowMs);
  }

  private cleanup() {
    const now = Date.now();
    Object.keys(this.store).forEach(key => {
      if (this.store[key].resetTime <= now) {
        delete this.store[key];
      }
    });
  }

  check(request: any): { allowed: boolean; remaining: number; resetTime: number } {
    const key = this.options.keyGenerator(request);
    const now = Date.now();
    
    if (!this.store[key] || this.store[key].resetTime <= now) {
      this.store[key] = {
        count: 1,
        resetTime: now + this.options.windowMs,
      };
      return {
        allowed: true,
        remaining: this.options.max - 1,
        resetTime: this.store[key].resetTime,
      };
    }

    const current = this.store[key];
    
    if (current.count >= this.options.max) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: current.resetTime,
      };
    }

    current.count++;
    return {
      allowed: true,
      remaining: this.options.max - current.count,
      resetTime: current.resetTime,
    };
  }

  increment(request: any) {
    const key = this.options.keyGenerator(request);
    if (this.store[key]) {
      this.store[key].count++;
    }
  }

  reset(request: any) {
    const key = this.options.keyGenerator(request);
    delete this.store[key];
  }
}

/**
 * レート制限ミドルウェアを作成
 */
export function createRateLimit(options: RateLimitOptions) {
  const limiter = new RateLimiter(options);

  return new Elysia()
    .derive(async ({ request, set }) => {
      const result = limiter.check(request);
      
      // レスポンスヘッダーを設定
      set.headers = {
        ...set.headers,
        'X-RateLimit-Limit': options.max.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': new Date(result.resetTime).toISOString(),
      };

      if (!result.allowed) {
        set.status = 429;
        throw new Error(limiter.options.message);
      }

      return {
        rateLimit: {
          increment: () => limiter.increment(request),
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
  keyGenerator: (request: any) => {
    // IPアドレスベースの制限
    const forwarded = request.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : 
               request.headers['x-real-ip'] || 
               request.ip || 
               'unknown';
    return `auth:${ip}`;
  },
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
  keyGenerator: (request: any) => {
    const forwarded = request.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : 
               request.headers['x-real-ip'] || 
               request.ip || 
               'unknown';
    return `register:${ip}`;
  },
});