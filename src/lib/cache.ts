import { Elysia } from "elysia";

const cache = new Map<string, { data: unknown; expires: number }>();

export const cachePlugin = new Elysia({ name: "cache" }).derive(() => ({
	cache: {
		get: <T>(key: string): T | null => {
			const cached = cache.get(key);
			if (cached && cached.expires > Date.now()) {
				return cached.data as T;
			}
			return null;
		},
		set: (key: string, data: unknown, ttl: number) => {
			cache.set(key, { data, expires: Date.now() + ttl });
		},
		invalidate: (prefix: string) => {
			for (const key of cache.keys()) {
				if (key.startsWith(prefix)) {
					cache.delete(key);
				}
			}
		},
	},
}));
