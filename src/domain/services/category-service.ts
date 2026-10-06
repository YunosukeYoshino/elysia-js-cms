import { type Category, Prisma } from '@prisma/client';
import { DomainError } from '../errors/domain-error';
import type { CategoryRepository } from '../repositories/service-database';

/** カテゴリの一意性と投稿への依存関係を管理する。 */
export class CategoryService {
  /** DB リポジトリを注入する。 */
  constructor(
    private readonly repository: CategoryRepository,
    private readonly afterMutation: () => Promise<void> = async () => {},
  ) {}

  /** 名前順で一覧を返す。 */
  async list(): Promise<Category[]> {
    return this.repository.category.findMany({ orderBy: { name: 'asc' } });
  }

  /** 指定カテゴリを取得し、不正 ID と未存在を区別する。 */
  async getById(id: number): Promise<Category> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      throw new DomainError('INVALID_CATEGORY_ID', 422, 'Invalid category ID');
    const category = await this.repository.category.findUnique({ where: { id } });
    if (!category) throw new DomainError('CATEGORY_NOT_FOUND', 404, 'カテゴリが見つかりません');
    return category;
  }

  /** DB の一意制約を使って同時作成でも重複を防ぐ。 */
  async create(input: { name: string; slug: string }): Promise<Category> {
    let category: Category;
    try {
      category = await this.repository.category.create({ data: input });
    } catch (error) {
      throw this.mapError(error);
    }
    await this.afterMutation();
    return category;
  }

  /** 既存カテゴリを更新する。 */
  async update(id: number, input: { name?: string; slug?: string }): Promise<Category> {
    await this.getById(id);
    let category: Category;
    try {
      category = await this.repository.category.update({ where: { id }, data: input });
    } catch (error) {
      throw this.mapError(error);
    }
    await this.afterMutation();
    return category;
  }

  /** 関連投稿の確認と削除を同じトランザクション内で実施する。 */
  async delete(id: number): Promise<{ message: string }> {
    await this.getById(id);
    try {
      await this.repository.$transaction(async (tx) => {
        if (await tx.categoryOnPost.findFirst({ where: { categoryId: id } }))
          throw new DomainError(
            'CATEGORY_IN_USE',
            400,
            'このカテゴリは投稿に使用されているため削除できません',
          );
        await tx.category.delete({ where: { id } });
      });
    } catch (error) {
      throw this.mapError(error);
    }
    await this.afterMutation();
    return { message: 'カテゴリを削除しました' };
  }

  private mapError(error: unknown): DomainError {
    if (error instanceof DomainError) return error;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002')
        return new DomainError(
          'CATEGORY_EXISTS',
          400,
          'この名前またはスラッグは既に使用されています',
        );
      if (error.code === 'P2003')
        return new DomainError(
          'CATEGORY_IN_USE',
          400,
          'このカテゴリは投稿に使用されているため削除できません',
        );
      if (error.code === 'P2025')
        return new DomainError('CATEGORY_NOT_FOUND', 404, 'カテゴリが見つかりません');
    }
    return new DomainError('CATEGORY_WRITE_FAILED', 500, 'カテゴリの保存に失敗しました');
  }
}
