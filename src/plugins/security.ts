import { Elysia } from 'elysia';

/**
 * Security headers plugin
 * Adds essential security headers to all responses
 */
export const securityPlugin = new Elysia({ name: 'security' }).onAfterHandle(({ set }) => {
  // Set security headers
  set.headers['X-Content-Type-Options'] = 'nosniff';
  set.headers['X-Frame-Options'] = 'DENY';
  set.headers['X-XSS-Protection'] = '1; mode=block';
  set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';

  // Content Security Policy for API endpoints
  set.headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none';";

  // Only set HSTS in production with HTTPS
  if (process.env.NODE_ENV === 'production') {
    set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload';
  }

  // Remove server information disclosure
  set.headers.Server = 'API';
});
