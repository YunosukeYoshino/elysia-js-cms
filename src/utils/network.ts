/**
 * Network utilities for IP extraction and request handling
 * Centralized implementation following ElysiaJS patterns
 */

export interface RequestLike {
  headers: Record<string, string | undefined>;
  ip?: string;
  url?: string;
}

/**
 * Extract client IP address with proxy support
 * Handles X-Forwarded-For, X-Real-IP, and direct IP
 *
 * @param request - Request-like object with headers and ip
 * @returns Extracted IP address or 'unknown' if not found
 */
export function extractClientIP(request: RequestLike): string {
  // Check X-Forwarded-For header (proxy chains)
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    // Take the first IP in the chain (original client)
    const firstIP = forwarded.split(',')[0].trim();
    if (firstIP && firstIP !== 'unknown') {
      return firstIP;
    }
  }

  // Check X-Real-IP header (single proxy)
  const realIP = request.headers['x-real-ip'];
  if (realIP && realIP !== 'unknown') {
    return realIP;
  }

  // Direct IP (no proxy)
  if (request.ip && request.ip !== 'unknown') {
    return request.ip;
  }

  // Fallback for unknown cases
  return 'unknown';
}

/**
 * Generate rate limit key with prefix and IP
 *
 * @param prefix - Rate limit category prefix
 * @param request - Request-like object
 * @returns Rate limit key string
 */
export function generateRateLimitKey(prefix: string, request: RequestLike): string {
  const ip = extractClientIP(request);
  return `${prefix}:${ip}`;
}

/**
 * Validate IP address format (basic validation)
 *
 * @param ip - IP address string
 * @returns true if valid IPv4 or IPv6 format
 */
export function isValidIP(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;

  // IPv4 regex - fixed escaping
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6 regex (simplified) - covers common cases
  const ipv6Regex =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$|^([0-9a-fA-F]{1,4}:){1,7}:$/;

  return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

/**
 * Extract user agent with truncation for security
 *
 * @param request - Request-like object
 * @returns Truncated user agent string
 */
export function extractUserAgent(request: RequestLike): string {
  const userAgent = request.headers['user-agent'];
  if (!userAgent) return 'unknown';

  // Truncate to prevent header injection attacks
  return userAgent.substring(0, 255);
}
