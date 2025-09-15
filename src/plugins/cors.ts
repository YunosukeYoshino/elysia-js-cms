import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';

/**
 * CORS (Cross-Origin Resource Sharing) plugin
 * Configures CORS based on environment settings
 */
export const corsPlugin = new Elysia({ name: 'cors' }).use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? process.env.ALLOWED_ORIGINS?.split(',') || false
        : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
    maxAge: 86400, // 24 hours
  }),
);
