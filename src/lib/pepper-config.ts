const JWT_PLACEHOLDER: string = 'your-secret-key-for-jwt-tokens';
const DEVELOPMENT_PEPPER: string = 'dev-fallback-pepper-for-local-testing-only';
const PUBLIC_SECRETS: readonly string[] = [
  JWT_PLACEHOLDER,
  DEVELOPMENT_PEPPER,
  'default-secret-for-testing-please-change-in-prod',
  'test-secret-key-for-testing-only',
];

/** 公開ペッパーを許可するローカル実行モードかを判定する。 */
function isLocalMode(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/** 公開済みのサンプル値かを判定する。 */
export function isPublicPasswordSecret(secret: string): boolean {
  return PUBLIC_SECRETS.includes(secret.trim());
}

/** 既存ハッシュの互換性のため、有効なJWT_SECRETを優先してそのまま返す。 */
export function getConfiguredPasswordPepper(env: NodeJS.ProcessEnv): string | undefined {
  for (const value of [env.JWT_SECRET, env.PEPPER_SECRET]) {
    if (!value?.trim() || value.trim() === JWT_PLACEHOLDER) continue;
    if (!isLocalMode(env) && isPublicPasswordSecret(value)) continue;
    return value;
  }
  return undefined;
}

/** 未設定・不明なモードでは公開フォールバックを拒否する。 */
export function getPasswordPepper(env: NodeJS.ProcessEnv = process.env): string {
  const configured: string | undefined = getConfiguredPasswordPepper(env);
  if (configured) return configured;
  if (isLocalMode(env)) return DEVELOPMENT_PEPPER;
  throw new Error(
    'Configure a non-public JWT_SECRET or PEPPER_SECRET. Password fallback requires explicit NODE_ENV=development or test.',
  );
}

/** 旧プレースホルダー設定で作成したローカルハッシュだけを追加で照合する。 */
export function getPasswordVerificationPeppers(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary: string = getPasswordPepper(env);
  if (isLocalMode(env) && env.JWT_SECRET === JWT_PLACEHOLDER && primary !== DEVELOPMENT_PEPPER) {
    return [primary, DEVELOPMENT_PEPPER];
  }
  return [primary];
}
