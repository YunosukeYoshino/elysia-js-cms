import type { PrismaClient } from '@prisma/client';

/** サービスに渡すデータアクセス契約。Prisma クライアントをアダプターとして利用する。 */
export type AuthRepository = Pick<PrismaClient, 'user' | 'refreshToken' | '$transaction'>;
export type CategoryRepository = Pick<PrismaClient, 'category' | '$transaction'>;
export type FileRepository = Pick<PrismaClient, 'file' | '$transaction'>;
