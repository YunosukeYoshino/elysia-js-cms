import type { Prisma } from '@prisma/client';
import { BaseService } from './base-service';

export interface CategoryCreateData {
  name: string;
  slug: string;
}

export interface CategoryUpdateData {
  name?: string;
  slug?: string;
}

export interface CategoryQueryOptions {
  published?: boolean;
  take?: number;
  skip?: number;
}

/**
 * Category service
 * Handles all category-related business logic
 */
export class CategoryService extends BaseService {
  /**
   * Get all categories
   */
  async getCategories() {
    try {
      const categories = await this.prisma.category.findMany({
        orderBy: {
          name: 'asc',
        },
      });

      return { data: categories };
    } catch (error) {
      this.handleError(error, 'CategoryService.getCategories');
    }
  }

  /**
   * Get a single category by ID
   */
  async getCategoryById(id: number) {
    try {
      const category = await this.prisma.category.findUnique({
        where: { id },
      });

      if (!category) {
        throw new Error('CATEGORY_NOT_FOUND');
      }

      return category;
    } catch (error) {
      if (error instanceof Error && error.message === 'CATEGORY_NOT_FOUND') {
        throw error;
      }
      this.handleError(error, 'CategoryService.getCategoryById');
    }
  }

  /**
   * Create a new category
   */
  async createCategory(data: CategoryCreateData) {
    try {
      const { name, slug } = data;

      // Check if slug already exists
      const existingCategory = await this.prisma.category.findUnique({
        where: { slug },
      });

      if (existingCategory) {
        return {
          success: false,
          error: 'このスラッグは既に使用されています',
        };
      }

      const category = await this.prisma.category.create({
        data: {
          name,
          slug,
        },
      });

      this.log(`Category created: ${category.name} (${category.slug})`);

      return {
        success: true,
        data: category,
      };
    } catch (error) {
      this.handleError(error, 'CategoryService.createCategory');
    }
  }

  /**
   * Update a category
   */
  async updateCategory(id: number, data: CategoryUpdateData) {
    try {
      // Check if category exists
      const existingCategory = await this.prisma.category.findUnique({
        where: { id },
      });

      if (!existingCategory) {
        return {
          success: false,
          error: 'カテゴリが見つかりません',
        };
      }

      const { name, slug } = data;

      // Check slug uniqueness if it's being changed
      if (slug && slug !== existingCategory.slug) {
        const slugExists = await this.prisma.category.findUnique({
          where: { slug },
        });

        if (slugExists) {
          return {
            success: false,
            error: 'このスラッグは既に使用されています',
          };
        }
      }

      const updatedCategory = await this.prisma.category.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(slug && { slug }),
        },
      });

      this.log(`Category updated: ${updatedCategory.name} (${updatedCategory.slug})`);

      return {
        success: true,
        data: updatedCategory,
      };
    } catch (error) {
      this.handleError(error, 'CategoryService.updateCategory');
    }
  }

  /**
   * Delete a category
   */
  async deleteCategory(id: number) {
    try {
      // Check if category exists
      const existingCategory = await this.prisma.category.findUnique({
        where: { id },
      });

      if (!existingCategory) {
        return {
          success: false,
          error: 'カテゴリが見つかりません',
        };
      }

      // Check if category is used by any posts
      const postsWithCategory = await this.prisma.categoryOnPost.findFirst({
        where: { categoryId: id },
      });

      if (postsWithCategory) {
        return {
          success: false,
          error: 'このカテゴリは投稿に使用されているため削除できません',
        };
      }

      await this.prisma.category.delete({
        where: { id },
      });

      this.log(`Category deleted: ${existingCategory.name} (${existingCategory.slug})`);

      return {
        success: true,
        message: 'カテゴリを削除しました',
      };
    } catch (error) {
      this.handleError(error, 'CategoryService.deleteCategory');
    }
  }

  /**
   * Get posts by category
   */
  async getPostsByCategory(id: number, options: CategoryQueryOptions = {}) {
    try {
      // Check if category exists
      const category = await this.prisma.category.findUnique({
        where: { id },
      });

      if (!category) {
        return {
          success: false,
          error: 'カテゴリが見つかりません',
        };
      }

      const { published, take = 10, skip = 0 } = options;

      const whereClause: Prisma.PostWhereInput = {
        categories: {
          some: {
            categoryId: id,
          },
        },
      };

      if (published !== undefined) {
        whereClause.published = published === true;
      }

      const [posts, total] = await Promise.all([
        this.prisma.post.findMany({
          where: whereClause,
          include: {
            author: {
              select: { id: true, name: true, email: true },
            },
            categories: {
              include: {
                category: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: Number(take),
          skip: Number(skip),
        }),
        this.prisma.post.count({ where: whereClause }),
      ]);

      // Transform posts to include categories directly
      const transformedPosts = posts.map((post) => ({
        ...post,
        categories: post.categories.map((c) => c.category),
      }));

      return {
        success: true,
        data: transformedPosts,
        meta: {
          total,
          category,
          skip: Number(skip),
          take: Number(take),
        },
      };
    } catch (error) {
      this.handleError(error, 'CategoryService.getPostsByCategory');
    }
  }
}
