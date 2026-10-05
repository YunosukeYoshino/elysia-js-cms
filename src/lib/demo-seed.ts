/** 開発用シードの安全設定を検証する */
export function assertDemoSeedEnvironment(env: NodeJS.ProcessEnv): void {
  if (!['development', 'test'].includes(env.NODE_ENV || '') || env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo seed requires development/test mode and ALLOW_DEMO_SEED=true.');
  }
  const url = env.DATABASE_URL || '';
  if (!url.startsWith('file:') || !url.slice(5).split('?')[0].trim()) {
    throw new Error('Demo seed requires an explicit local SQLite DATABASE_URL.');
  }
  const pepper = env.JWT_SECRET || env.PEPPER_SECRET;
  if (
    !pepper ||
    pepper.trim().length < 32 ||
    pepper === 'your-secret-key-for-jwt-tokens' ||
    pepper === 'default-secret-for-testing-please-change-in-prod'
  ) {
    throw new Error('Demo seed requires a stable configured secret of at least 32 characters.');
  }
}
