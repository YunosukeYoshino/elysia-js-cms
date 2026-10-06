import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from './prisma';

const revisionTables: string[] = [
  'Post',
  'Category',
  'CategoryOnPost',
  'Tag',
  'TagOnPost',
  'Comment',
  'Reaction',
  'Bookmark',
  'Follow',
  'PostView',
  'Notification',
  'User',
];
export const CONTENT_REVISION_TRIGGERS: string[] = revisionTables.flatMap(
  (table: string): string[] =>
    ['insert', 'update', 'delete'].map(
      (operation: string): string => `cache_content_${table}_${operation}`,
    ),
);

/** DB変更と同一トランザクションの版を読む。未移行・トリガー不足ではキャッシュを使わない。 */
export async function readContentRevision(client: PrismaClient = prisma): Promise<string> {
  const rows: { version: bigint | number }[] = await client.$queryRaw`
    SELECT version FROM CacheRevision WHERE id = 'content'
    AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
      AND name IN (${Prisma.join(CONTENT_REVISION_TRIGGERS)})) = ${CONTENT_REVISION_TRIGGERS.length}
  `;
  const version: bigint | number | undefined = rows[0]?.version;
  if (
    (typeof version !== 'bigint' && typeof version !== 'number') ||
    (typeof version === 'bigint' ? version < 0n : !Number.isSafeInteger(version) || version < 0)
  )
    throw new Error('Content cache revision is unavailable or incomplete');
  return String(version);
}
