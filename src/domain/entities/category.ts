/**
 * カテゴリエンティティ
 * @description カテゴリのドメインモデル
 */
export class Category {
  constructor(
    private readonly _id: string,
    private _name: string,
    private _slug: string,
  ) {}

  /**
   * カテゴリIDを取得
   */
  get id(): string {
    return this._id;
  }

  /**
   * 名前を取得
   */
  get name(): string {
    return this._name;
  }

  /**
   * 名前を設定
   */
  set name(name: string) {
    this._name = name;
  }

  /**
   * スラッグを取得
   */
  get slug(): string {
    return this._slug;
  }

  /**
   * スラッグを設定
   */
  set slug(slug: string) {
    this._slug = slug;
  }

  /**
   * エンティティをプレーンオブジェクトに変換
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      name: this._name,
      slug: this._slug,
    };
  }
}
