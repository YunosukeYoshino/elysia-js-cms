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

/**
 * カテゴリ関連のAPIモデル定義
 */
export const CategoryApiModels = {
  CategoryCreateData: 'CategoryCreateData' as const,
  CategoryUpdateData: 'CategoryUpdateData' as const,
  CategoryQueryOptions: 'CategoryQueryOptions' as const,
} as const;

/**
 * 型安全なカテゴリモデルアクセサー
 */
export type CategoryModelType = typeof CategoryApiModels;
export type CategoryModelKeys = keyof CategoryModelType;

/**
 * カテゴリ型マッピング
 */
export type CategoryTypeMap = {
  CategoryCreateData: CategoryCreateData;
  CategoryUpdateData: CategoryUpdateData;
  CategoryQueryOptions: CategoryQueryOptions;
};
