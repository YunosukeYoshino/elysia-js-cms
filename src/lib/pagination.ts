/** ページ指定を検証する */
export function parsePagination({
  take = '10',
  skip = '0',
}: {
  take?: string;
  skip?: string;
}): { take: number; skip: number } | null {
  if (take.trim() !== take || skip.trim() !== skip) return null;
  if (!/^-?[0-9]+$/.test(take) || !/^[0-9]+$/.test(skip)) return null;
  const limit: number = Number(take);
  const offset: number = Number(skip);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return null;
  return { take: limit, skip: offset };
}
