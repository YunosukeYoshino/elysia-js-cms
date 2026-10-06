import prisma from './prisma';
import { AUTH_CACHE_TTL_MS, type SharedCache, sharedCache } from './shared-cache';

export interface CachedUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
}

/** Redis内容は信用せず、保存した最小プロフィールだけを受け入れる。 */
export function isCachedUser(value: unknown): value is CachedUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    Number.isSafeInteger(value.id) &&
    'email' in value &&
    typeof value.email === 'string' &&
    'name' in value &&
    (value.name === null || typeof value.name === 'string') &&
    'role' in value &&
    typeof value.role === 'string'
  );
}

interface AuthCacheEntry {
  version: number;
  user: CachedUser;
}

function isAuthEntry(value: unknown): value is AuthCacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    'user' in value &&
    isCachedUser(value.user)
  );
}

/** 権限と存在はDBで確認し、並列キャッシュ読取でRedisの往復遅延を隠す。 */
export async function getAuthenticatedUser(
  userId: number,
  cache: SharedCache = sharedCache,
): Promise<CachedUser | null> {
  const key: string = userId.toString();
  const [current, local] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, updatedAt: true },
    }),
    cache.authLocal(key, isAuthEntry),
  ]);
  if (!current) return null;
  const matches = (entry: AuthCacheEntry | null): entry is AuthCacheEntry =>
    entry !== null &&
    entry.user.id === current.id &&
    entry.user.role === current.role &&
    entry.version === current.updatedAt.getTime();
  if (matches(local)) {
    cache.recordAuthLocalHit();
    return { id: current.id, email: local.user.email, name: local.user.name, role: current.role };
  }
  const lookup = await cache.lookup('auth', key, isAuthEntry);
  const entry: AuthCacheEntry | null = lookup.value;
  if (lookup.hit && matches(entry)) {
    await cache.fillAuthLocal(key, entry);
    return { id: current.id, email: entry.user.email, name: entry.user.name, role: current.role };
  }
  const user: CachedUser | null = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (user) {
    const fresh: AuthCacheEntry = { version: current.updatedAt.getTime(), user };
    if (lookup.token) await cache.fill(lookup.token, fresh, AUTH_CACHE_TTL_MS);
    await cache.fillAuthLocal(key, fresh);
  }
  return user;
}
