import { Elysia } from 'elysia';

/**
 * Response compression plugin
 * Note: This is a basic implementation. For production, consider using
 * dedicated compression middleware or reverse proxy compression.
 */
export const compressionPlugin = new Elysia({ name: 'compression' }).onAfterHandle(
  ({ response, set, request }) => {
    // Check if client supports compression
    const acceptEncoding = request.headers['accept-encoding'] || '';
    const supportsGzip = acceptEncoding.includes('gzip');

    // Only indicate compression support for JSON responses
    if (supportsGzip && response && typeof response === 'object') {
      set.headers.vary = 'accept-encoding';
    }

    return response;
  },
);
