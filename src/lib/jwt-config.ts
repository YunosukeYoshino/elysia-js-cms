const TEST_SECRET = 'default-secret-for-testing-please-change-in-prod';

/** 本番環境のJWT設定を検証する。 */
export function getJwtSecret(
  env: { NODE_ENV?: string; JWT_SECRET?: string } = process.env,
): string {
  const secret = env.JWT_SECRET;
  if (
    env.NODE_ENV === 'production' &&
    (!secret?.trim() ||
      [TEST_SECRET, 'your-secret-key-for-jwt-tokens', 'test-secret-key-for-testing-only'].includes(
        secret.trim(),
      ))
  ) {
    throw new Error('JWT_SECRET must be configured with a non-test secret in production');
  }
  return secret || TEST_SECRET;
}
