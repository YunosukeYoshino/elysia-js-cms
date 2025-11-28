/**
 * IP抽出とリクエスト処理のためのネットワークユーティリティ
 * ElysiaJSのパターンに従った一元化された実装
 */

export interface RequestLike {
  headers: Record<string, string | undefined>;
  ip?: string;
  url?: string;
}

/**
 * クライアントのIPアドレスを抽出（プロキシ対応）
 * X-Forwarded-For, X-Real-IP, および直接のIPを処理
 *
 * @param request - ヘッダーとIPを持つリクエスト風オブジェクト
 * @returns 抽出されたIPアドレス、または見つからない場合は 'unknown'
 */
export function extractClientIP(request: RequestLike): string {
  // X-Forwarded-Forヘッダー（プロキシチェーン）を確認
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    // チェーン内の最初のIP（元のクライアント）を取得
    const firstIP = forwarded.split(',')[0].trim();
    if (firstIP && firstIP !== 'unknown') {
      return firstIP;
    }
  }

  // X-Real-IPヘッダー（単一プロキシ）を確認
  const realIP = request.headers['x-real-ip'];
  if (realIP && realIP !== 'unknown') {
    return realIP;
  }

  // 直接のIP（プロキシなし）
  if (request.ip && request.ip !== 'unknown') {
    return request.ip;
  }

  // 不明な場合のフォールバック
  return 'unknown';
}

/**
 * プレフィックスとIPを使用してレート制限キーを生成
 *
 * @param prefix - レート制限カテゴリのプレフィックス
 * @param request - リクエスト風オブジェクト
 * @returns レート制限キー文字列
 */
export function generateRateLimitKey(prefix: string, request: RequestLike): string {
  const ip = extractClientIP(request);
  return `${prefix}:${ip}`;
}

/**
 * IPアドレスの形式を検証（基本的な検証）
 *
 * @param ip - IPアドレス文字列
 * @returns 有効なIPv4またはIPv6形式の場合はtrue
 */
export function isValidIP(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;

  // IPv4正規表現 - エスケープを修正
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6正規表現（簡略化） - 一般的なケースをカバー
  const ipv6Regex =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^([0-9a-fA-F]{1,4}:){1,7}:$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

/**
 * セキュリティのために切り詰められたユーザーエージェントを抽出
 *
 * @param request - リクエスト風オブジェクト
 * @returns 切り詰められたユーザーエージェント文字列
 */
export function extractUserAgent(request: RequestLike): string {
  const userAgent = request.headers['user-agent'];
  if (!userAgent) return 'unknown';

  // ヘッダー注入攻撃を防ぐために切り詰める
  return userAgent.substring(0, 255);
}
