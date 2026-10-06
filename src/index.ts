import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { responseCompression } from './middlewares/compression';
import { createContentCache } from './middlewares/content-cache';
import { domainErrorPlugin } from './middlewares/domain-error';
import { createHierarchicalRateLimit } from './middlewares/hierarchical-rate-limit';
import { authRouter } from './routes/auth';
import { categoriesRouter } from './routes/categories';
import { filesRouter } from './routes/files';
import { interactionsRouter } from './routes/interactions';
import { postsRouter } from './routes/posts';
import { rateLimitAdminRouter } from './routes/rate-limit-admin';
import { PostService } from './services/post-service';

/**
 * ElysiaJS CMS APIアプリケーション
 * @description APIのメインエントリーポイント。ミドルウェアとルートを構成します。
 */
const app = new Elysia()
  .use(responseCompression)
  .use(domainErrorPlugin)
  .use(
    swagger({
      documentation: {
        info: {
          title: 'ElysiaJS CMS API',
          version: '1.0.0',
          description: '軽重CMSのためのRESTful API',
        },
        tags: [
          { name: 'auth', description: '認証関連のエンドポイント' },
          { name: 'posts', description: '投稿管理エンドポイント' },
          { name: 'categories', description: 'カテゴリ管理エンドポイント' },
          { name: 'files', description: 'ファイル管理エンドポイント' },
          { name: 'interactions', description: 'コメント・リアクション・通知' },
        ],
      },
    }),
  )
  .use(cors({ origin: (): boolean => true }))
  .get(
    '/',
    () => 'ElysiaJS CMS API - お好みのツールでAPIを探索するには /swagger にアクセスしてください',
  )
  .group('/api', (app) =>
    app
      .use(createHierarchicalRateLimit())
      .use(createContentCache({ nextPublication: () => new PostService().nextPublication() }))
      .use(rateLimitAdminRouter)
      .use(authRouter)
      .use(interactionsRouter)
      .use(postsRouter)
      .use(categoriesRouter)
      .use(filesRouter),
  );

if (import.meta.main) {
  const port = process.env.PORT ? Number.parseInt(process.env.PORT) : 3001;
  app.listen({
    port,
    hostname: '0.0.0.0',
  });
  console.log(
    `🦊 ElysiaJS CMS APIサーバー起動中: http://${app.server?.hostname}:${app.server?.port}`,
  );
}

export type App = typeof app;
export default app;
