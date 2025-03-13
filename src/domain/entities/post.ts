/**
 * 投稿エンティティ
 * @description 投稿のドメインモデル
 */
import type { Category } from './category';

/**
 * 投稿オブジェクトの型定義
 */
export interface PostJSON {
  id: string;
  title: string;
  content: string;
  published: boolean;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  categories: Record<string, unknown>[];
}

export class Post {
  constructor(
    private readonly _id: string,
    private _title: string,
    private _content: string,
    private _published: boolean,
    private readonly _authorId: string,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
    private _categories: Category[] = [],
  ) {}

  /**
   * 投稿IDを取得
   */
  get id(): string {
    return this._id;
  }

  /**
   * タイトルを取得
   */
  get title(): string {
    return this._title;
  }

  /**
   * タイトルを設定
   */
  set title(title: string) {
    this._title = title;
    this._updatedAt = new Date();
  }

  /**
   * コンテンツを取得
   */
  get content(): string {
    return this._content;
  }

  /**
   * コンテンツを設定
   */
  set content(content: string) {
    this._content = content;
    this._updatedAt = new Date();
  }

  /**
   * 公開状態を取得
   */
  get published(): boolean {
    return this._published;
  }

  /**
   * 公開状態を設定
   */
  set published(published: boolean) {
    this._published = published;
    this._updatedAt = new Date();
  }

  /**
   * 著者IDを取得
   */
  get authorId(): string {
    return this._authorId;
  }

  /**
   * 作成日時を取得
   */
  get createdAt(): Date {
    return this._createdAt;
  }

  /**
   * 更新日時を取得
   */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * カテゴリを取得
   */
  get categories(): Category[] {
    return [...this._categories];
  }

  /**
   * カテゴリを設定
   */
  set categories(categories: Category[]) {
    this._categories = [...categories];
    this._updatedAt = new Date();
  }

  /**
   * カテゴリを追加
   */
  addCategory(category: Category): void {
    if (!this._categories.some((c) => c.id === category.id)) {
      this._categories.push(category);
      this._updatedAt = new Date();
    }
  }

  /**
   * カテゴリを削除
   */
  removeCategory(categoryId: string): void {
    this._categories = this._categories.filter((c) => c.id !== categoryId);
    this._updatedAt = new Date();
  }

  /**
   * エンティティをプレーンオブジェクトに変換
   */
  toJSON(): PostJSON {
    return {
      id: this._id,
      title: this._title,
      content: this._content,
      published: this._published,
      authorId: this._authorId,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      categories: this._categories.map((c) => c.toJSON()),
    };
  }
}
