import { Elysia } from 'elysia';
import { compressionPlugin } from './compression';
import { corsPlugin } from './cors';
import { securityPlugin } from './security';
import { swaggerPlugin } from './swagger';

/**
 * Plugin orchestration and setup
 * Applies all plugins in the correct order for optimal functionality
 */
export const setupPlugins = new Elysia({ name: 'setup-plugins' })
  // CORS must be early in the chain to handle preflight requests
  .use(corsPlugin)
  // Security headers for all responses
  .use(securityPlugin)
  // Response compression for better performance
  .use(compressionPlugin)
  // Swagger documentation (last as it's not critical for API function)
  .use(swaggerPlugin);

export { compressionPlugin } from './compression';
// Re-export individual plugins for selective use
export { corsPlugin } from './cors';
export { securityPlugin } from './security';
export { swaggerPlugin } from './swagger';
