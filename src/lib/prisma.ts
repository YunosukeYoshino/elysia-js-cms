import { PrismaClient } from '@prisma/client';

/**
 * Prismaクライアントインスタンス
 * @description データベース操作のためのシングルトンインスタンス
 */
const prisma = new PrismaClient();

export default prisma;
