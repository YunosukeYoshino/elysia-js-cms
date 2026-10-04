const TEST_SECRET = 'default-secret-for-testing-please-change-in-prod';

/** 本番環境のJWT設定を検証する。 */
export function getJwtSecret(
  env: { NODE_ENV?: string; JWT_SECRET?: string } = process.env,
): string {
  const secret = env.JWT_SECRET;
  if (env.NODE_ENV === 'production' && (!secret?.trim() || secret.trim() === TEST_SECRET)) {
    throw new Error('JWT_SECRET must be configured with a non-test secret in production');
  }
  return secret || TEST_SECRET;
}
