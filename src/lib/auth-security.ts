/**
 * 認証セキュリティユーティリティ
 * ブルートフォース攻撃対策とアカウントロックアウト機能を提供
 */

import prisma from './prisma';

export const AUTH_CONFIG = {
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_TIME_MINUTES: 15,
  PASSWORD_RESET_EXPIRE_HOURS: 1,
  REFRESH_TOKEN_EXPIRE_DAYS: 30,
  ACCESS_TOKEN_EXPIRE_MINUTES: 15,
} as const;

/**
 * ログイン試行回数をインクリメント
 */
export async function incrementLoginAttempts(userId: number): Promise<void> {
  const lockoutTime = new Date(Date.now() + AUTH_CONFIG.LOCKOUT_TIME_MINUTES * 60 * 1000);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { loginAttempts: true },
  });

  if (!user) return;

  const newAttempts = user.loginAttempts + 1;

  await prisma.user.update({
    where: { id: userId },
    data: {
      loginAttempts: newAttempts,
      // 最大試行回数に達したらアカウントをロック
      lockedUntil: newAttempts >= AUTH_CONFIG.MAX_LOGIN_ATTEMPTS ? lockoutTime : undefined,
    },
  });
}

/**
 * ログイン試行回数をリセット
 */
export async function resetLoginAttempts(userId: number): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      loginAttempts: 0,
      lockedUntil: null,
    },
  });
}

/**
 * アカウントがロックされているかチェック
 */
export async function isAccountLocked(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lockedUntil: true },
  });

  if (!user?.lockedUntil) return false;

  // ロック期間が過ぎている場合はロックを解除
  if (user.lockedUntil <= new Date()) {
    await resetLoginAttempts(userId);
    return false;
  }

  return true;
}

/**
 * メールアドレスからアカウントロック状態をチェック
 */
export async function checkAccountLockByEmail(email: string): Promise<{
  isLocked: boolean;
  lockedUntil?: Date;
}> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, lockedUntil: true },
  });

  if (!user) return { isLocked: false };

  const isLocked = await isAccountLocked(user.id);

  return {
    isLocked,
    lockedUntil: isLocked ? (user.lockedUntil ?? undefined) : undefined,
  };
}

/**
 * リフレッシュトークンを作成
 */
export async function createRefreshToken(userId: number, token: string): Promise<void> {
  const expiresAt = new Date(
    Date.now() + AUTH_CONFIG.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.refreshToken.create({
    data: {
      token,
      userId,
      expiresAt,
    },
  });
}

/**
 * リフレッシュトークンを検証
 */
export async function validateRefreshToken(token: string): Promise<{ userId: number } | null> {
  const refreshToken = await prisma.refreshToken.findUnique({
    where: { token },
    select: { userId: true, expiresAt: true },
  });

  if (!refreshToken || refreshToken.expiresAt <= new Date()) {
    // 期限切れのトークンは削除
    if (refreshToken) {
      await prisma.refreshToken.delete({ where: { token } });
    }
    return null;
  }

  return { userId: refreshToken.userId };
}

/**
 * ユーザーの全リフレッシュトークンを削除（ログアウト時）
 */
export async function revokeAllRefreshTokens(userId: number): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { userId },
  });
}

/**
 * 特定のリフレッシュトークンを削除
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken
    .delete({
      where: { token },
    })
    .catch(() => {
      // トークンが既に削除されている場合は無視
    });
}

/**
 * リフレッシュトークンの所有者を検証して削除
 * セキュリティ強化: トークンが指定されたユーザーに属することを確認
 *
 * @param token - 削除するリフレッシュトークン
 * @param userId - トークンの所有者として期待されるユーザーID
 * @returns 削除が成功したかどうか
 */
export async function revokeRefreshTokenSecure(token: string, userId: number): Promise<boolean> {
  try {
    const deletedCount = await prisma.refreshToken.deleteMany({
      where: {
        token,
        userId, // 所有者検証
      },
    });

    // deletedCount.count > 0 の場合は削除成功
    return deletedCount.count > 0;
  } catch {
    // エラーの場合は削除失敗
    return false;
  }
}

/**
 * 期限切れのリフレッシュトークンをクリーンアップ
 */
export async function cleanupExpiredTokens(): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
}
