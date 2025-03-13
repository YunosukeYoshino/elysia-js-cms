/**
 * ユーザーエンティティ
 * @description ユーザーのドメインモデル
 */
export class User {
  constructor(
    private readonly _id: string,
    private readonly _email: string,
    private _name: string | null,
    private readonly _role: string,
  ) {}

  /**
   * ユーザーIDを取得
   */
  get id(): string {
    return this._id;
  }

  /**
   * メールアドレスを取得
   */
  get email(): string {
    return this._email;
  }

  /**
   * 名前を取得
   */
  get name(): string | null {
    return this._name;
  }

  /**
   * 名前を設定
   */
  set name(name: string | null) {
    this._name = name;
  }

  /**
   * ロールを取得
   */
  get role(): string {
    return this._role;
  }

  /**
   * 管理者かどうかを確認
   */
  isAdmin(): boolean {
    return this._role === 'admin';
  }

  /**
   * 特定のリソースに対するアクセス権限があるかを確認
   * @param resourceOwnerId リソース所有者のID
   */
  canAccess(resourceOwnerId: string): boolean {
    return this.isAdmin() || this._id === resourceOwnerId;
  }

  /**
   * エンティティをプレーンオブジェクトに変換
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this._id,
      email: this._email,
      name: this._name,
      role: this._role,
    };
  }
}
