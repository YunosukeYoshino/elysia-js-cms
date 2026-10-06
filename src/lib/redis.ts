import Redis from 'ioredis';

/** 障害時に無期限待機・オフライン再実行しないRedis接続を作成する。 */
export function createRedisClient(url: string): Redis {
  const client: Redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 200,
    commandTimeout: 250,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (attempt: number): number => Math.min(attempt * 100, 2000),
  });
  // エラーは呼び出し元が記録し、URLや資格情報をログへ出さない。
  client.on('error', () => {});
  return client;
}

const connecting: WeakMap<Redis, Promise<void>> = new WeakMap();

/** 初回接続のみ待機し、再接続中は速やかに呼び出し元へ失敗を返す。 */
export async function readyRedis(client: Redis): Promise<Redis> {
  if (client.status === 'wait') {
    const pending: Promise<void> = client.connect().finally(() => connecting.delete(client));
    connecting.set(client, pending);
  }
  const pending: Promise<void> | undefined = connecting.get(client);
  if (pending) await pending;
  if (client.status !== 'ready') throw new Error('Redis temporarily unavailable');
  return client;
}
