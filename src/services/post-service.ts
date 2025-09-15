import type { Prisma } from '@prisma/client';
import { BaseService } from './base-service';

export interface PostCreateData {
  title: string;
  content: string;
  published?: boolean;
  categoryIds?: number[];
  authorId: number;
}

export interface PostUpdateData {
  title?: string;
  content?: string;
  published?: boolean;
  categoryIds?: number[];
}

export interface PostQueryOptions {
  published?: boolean;
  authorId?: number;
  categoryId?: number;
  take?: number;
  skip?: number;
}

/**
 * Post service
 * Handles all post-related business logic
 */
export class PostService extends BaseService {
  /**
   * Get posts with filtering and pagination
   */
  async getPosts(options: PostQueryOptions = {}) {
    try {
      const { published, authorId, categoryId, take = 10, skip = 0 } = options;

      const whereClause: Prisma.PostWhereInput = {};

      if (published !== undefined) {
        whereClause.published = published === true;
      }

      if (authorId) {
        whereClause.authorId = authorId;
      }

      if (categoryId) {
        whereClause.categories = {
          some: {
            categoryId: categoryId,
          },
        };
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
          skip: Number(skip),
          take: Number(take),
        },
      };
    } catch (error) {
      this.handleError(error, 'PostService.getPosts');
    }
  }

  /**
   * Get a single post by ID
   */
  async getPostById(id: number) {
    try {
      const post = await this.prisma.post.findUnique({
        where: { id },
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
      });

      if (!post) {
        return {
          success: false,
          error: '投稿が見つかりません',
        };
      }

      // Transform post to include categories directly
      return {
        success: true,
        data: {
          ...post,
          categories: post.categories.map((c) => c.category),
        },
      };
    } catch (error) {
      this.handleError(error, 'PostService.getPostById');
    }
  }

  /**
   * Create a new post
   */
  async createPost(data: PostCreateData) {
    try {
      const { title, content, published = false, categoryIds = [], authorId } = data;

      const post = await this.prisma.post.create({
        data: {
          title,
          content,
          published,
          authorId,
          categories: {
            create: categoryIds.map((categoryId) => ({
              categoryId,
            })),
          },
        },
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
      });

      this.log(`Post created: ${post.title} by user ${authorId}`);

      // Transform post to include categories directly
      return {
        success: true,
        data: {
          ...post,
          categories: post.categories.map((c) => c.category),
        },
      };
    } catch (error) {
      this.handleError(error, 'PostService.createPost');
    }
  }

  /**
   * Update a post
   */
  async updatePost(id: number, data: PostUpdateData, userId: number, userRole: string) {
    try {
      // Check if post exists
      const existingPost = await this.prisma.post.findUnique({
        where: { id },
      });

      if (!existingPost) {
        return {
          success: false,
          error: '投稿が見つかりません',
        };
      }

      // Check permissions (author or admin)
      if (existingPost.authorId !== userId && userRole !== 'admin') {
        return {
          success: false,
          error: 'この操作を行う権限がありません',
        };
      }

      const { title, content, published, categoryIds } = data;

      // Update post within transaction
      const updatedPost = await this.prisma.$transaction(async (tx) => {
        // If categoryIds are provided, update categories
        if (categoryIds) {
          await tx.categoryOnPost.deleteMany({
            where: { postId: id },
          });

          await tx.categoryOnPost.createMany({
            data: categoryIds.map((categoryId) => ({
              postId: id,
              categoryId,
            })),
          });
        }

        // Update post
        return await tx.post.update({
          where: { id },
          data: {
            ...(title && { title }),
            ...(content !== undefined && { content }),
            ...(published !== undefined && { published }),
          },
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
        });
      });

      this.log(`Post updated: ${updatedPost.title} by user ${userId}`);

      // Transform post to include categories directly
      return {
        success: true,
        data: {
          ...updatedPost,
          categories: updatedPost.categories.map((c) => c.category),
        },
      };
    } catch (error) {
      this.handleError(error, 'PostService.updatePost');
    }
  }

  /**
   * Delete a post
   */
  async deletePost(id: number, userId: number, userRole: string) {
    try {
      // Check if post exists
      const existingPost = await this.prisma.post.findUnique({
        where: { id },
      });

      if (!existingPost) {
        return {
          success: false,
          error: '投稿が見つかりません',
        };
      }

      // Check permissions (author or admin)
      if (existingPost.authorId !== userId && userRole !== 'admin') {
        return {
          success: false,
          error: 'この操作を行う権限がありません',
        };
      }

      // Delete post and related categories within transaction
      await this.prisma.$transaction(async (tx) => {
        await tx.categoryOnPost.deleteMany({
          where: { postId: id },
        });

        await tx.post.delete({
          where: { id },
        });
      });

      this.log(`Post deleted: ID ${id} by user ${userId}`);

      return {
        success: true,
        message: '投稿を削除しました',
      };
    } catch (error) {
      this.handleError(error, 'PostService.deletePost');
    }
  }
}
