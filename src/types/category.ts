/**
 * Category-related type definitions
 */

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
