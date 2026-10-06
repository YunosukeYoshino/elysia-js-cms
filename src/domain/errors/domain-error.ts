/** HTTP に依存せずサービスの失敗理由を表す例外。 */
export class DomainError extends Error {
  /** 安全に公開できるエラーコード・メッセージを保持する。 */
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
