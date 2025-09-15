import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';

/**
 * Swagger/OpenAPI documentation plugin
 * Provides interactive API documentation
 */
export const swaggerPlugin = new Elysia({ name: 'swagger' }).use(
  swagger({
    path: '/swagger',
    documentation: {
      info: {
        title: 'ElysiaJS CMS API',
        version: '1.0.0',
        description: '軽量CMSのためのRESTful API',
      },
      servers: [
        {
          url:
            process.env.NODE_ENV === 'production'
              ? process.env.API_URL || 'https://api.example.com'
              : 'http://localhost:3001',
          description:
            process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server',
        },
      ],
      tags: [
        { name: 'auth', description: '認証関連のエンドポイント' },
        { name: 'posts', description: '投稿管理エンドポイント' },
        { name: 'categories', description: 'カテゴリ管理エンドポイント' },
        { name: 'files', description: 'ファイル管理エンドポイント' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  }),
);
