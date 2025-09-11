import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * パスワードハッシュ化ユーティリティ
 * セキュリティの観点から、Argon2を使用することが推奨されますが、
 * ここではNode.jsの標準ライブラリを使用したPBKDF2の実装を提供します。
 *
 * 本番環境では以下のライブラリの使用を強く推奨：
 * - argon2
 * - bcrypt
 */

const PBKDF2_ITERATIONS = 100000; // 推奨される最小値
const SALT_LENGTH = 32;
const HASH_LENGTH = 64;

/**
 * ソルトを生成
 */
export function generateSalt(): string {
  return randomBytes(SALT_LENGTH).toString('hex');
}

/**
 * パスワードをハッシュ化
 */
export async function hashPassword(
  password: string,
  salt?: string,
): Promise<{ hash: string; salt: string }> {
  const saltBuffer = salt ? Buffer.from(salt, 'hex') : randomBytes(SALT_LENGTH);
  const saltHex = salt || saltBuffer.toString('hex');

  return new Promise((resolve, reject) => {
    const crypto = require('node:crypto');
    crypto.pbkdf2(
      password,
      saltBuffer,
      PBKDF2_ITERATIONS,
      HASH_LENGTH,
      'sha512',
      (err: Error | null, derivedKey: Buffer) => {
        if (err) reject(err);
        else
          resolve({
            hash: `${saltHex}:${derivedKey.toString('hex')}`,
            salt: saltHex,
          });
      },
    );
  });
}

/**
 * パスワードを検証
 */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  try {
    const [salt, hash] = hashedPassword.split(':');
    if (!salt || !hash) return false;

    const { hash: newHash } = await hashPassword(password, salt);
    const [, newHashOnly] = newHash.split(':');

    // タイミング攻撃を防ぐため、timingSafeEqualを使用
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(newHashOnly, 'hex'));
  } catch (error) {
    return false;
  }
}

/**
 * セキュアなランダム文字列を生成（トークン用）
 */
export function generateSecureToken(length = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * パスワード強度チェック
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('パスワードは8文字以上である必要があります');
  }

  if (password.length > 128) {
    errors.push('パスワードは128文字以下である必要があります');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('小文字を含む必要があります');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('大文字を含む必要があります');
  }

  if (!/\d/.test(password)) {
    errors.push('数字を含む必要があります');
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('特殊文字を含む必要があります');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
