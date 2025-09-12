/**
 * Network utilities tests
 */

import { describe, expect, it } from 'bun:test';
import { extractClientIP, extractUserAgent, generateRateLimitKey, isValidIP } from '../network';

describe('Network Utilities', () => {
  describe('extractClientIP', () => {
    it('should extract IP from X-Forwarded-For header', () => {
      const request = {
        headers: {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
        },
      };

      expect(extractClientIP(request)).toBe('192.168.1.1');
    });

    it('should extract IP from X-Real-IP header when X-Forwarded-For is not present', () => {
      const request = {
        headers: {
          'x-real-ip': '192.168.1.2',
        },
      };

      expect(extractClientIP(request)).toBe('192.168.1.2');
    });

    it('should extract IP from direct ip property', () => {
      const request = {
        headers: {},
        ip: '192.168.1.3',
      };

      expect(extractClientIP(request)).toBe('192.168.1.3');
    });

    it('should return "unknown" when no IP is available', () => {
      const request = {
        headers: {},
      };

      expect(extractClientIP(request)).toBe('unknown');
    });

    it('should skip "unknown" values in X-Forwarded-For', () => {
      const request = {
        headers: {
          'x-forwarded-for': 'unknown, 192.168.1.4',
          'x-real-ip': '192.168.1.5',
        },
      };

      expect(extractClientIP(request)).toBe('192.168.1.5');
    });
  });

  describe('generateRateLimitKey', () => {
    it('should generate rate limit key with prefix and IP', () => {
      const request = {
        headers: {
          'x-forwarded-for': '192.168.1.1',
        },
      };

      expect(generateRateLimitKey('auth', request)).toBe('auth:192.168.1.1');
    });

    it('should handle unknown IP', () => {
      const request = {
        headers: {},
      };

      expect(generateRateLimitKey('register', request)).toBe('register:unknown');
    });
  });

  describe('isValidIP', () => {
    it('should validate IPv4 addresses', () => {
      expect(isValidIP('192.168.1.1')).toBe(true);
      expect(isValidIP('10.0.0.1')).toBe(true);
      expect(isValidIP('172.16.0.1')).toBe(true);
      expect(isValidIP('127.0.0.1')).toBe(true);
    });

    it('should validate IPv6 addresses', () => {
      expect(isValidIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
      expect(isValidIP('::1')).toBe(true);
      expect(isValidIP('::')).toBe(true);
    });

    it('should reject invalid IP addresses', () => {
      expect(isValidIP('256.256.256.256')).toBe(false);
      expect(isValidIP('192.168.1')).toBe(false);
      expect(isValidIP('invalid')).toBe(false);
      expect(isValidIP('')).toBe(false);
      expect(isValidIP('unknown')).toBe(false);
    });
  });

  describe('extractUserAgent', () => {
    it('should extract user agent', () => {
      const request = {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      };

      expect(extractUserAgent(request)).toBe(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      );
    });

    it('should return "unknown" when no user agent', () => {
      const request = {
        headers: {},
      };

      expect(extractUserAgent(request)).toBe('unknown');
    });

    it('should truncate long user agent strings', () => {
      const longUserAgent = 'A'.repeat(300);
      const request = {
        headers: {
          'user-agent': longUserAgent,
        },
      };

      const result = extractUserAgent(request);
      expect(result.length).toBe(255);
      expect(result).toBe('A'.repeat(255));
    });
  });
});
