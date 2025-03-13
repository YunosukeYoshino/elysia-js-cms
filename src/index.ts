import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { Elysia } from 'elysia';
import { authRouter } from './routes/auth';
import { categoriesRouter } from './routes/categories';
import { filesRouter } from './routes/files';
import { postsRouter } from './routes/posts';

const app = new Elysia()
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
        ],
      },
    }),
  )
  .use(cors())
  .get(
    '/',
    () => 'ElysiaJS CMS API - お好みのツールでAPIを探索するには /swagger にアクセスしてください',
  )
  .group('/api', (app) =>
    app.use(authRouter).use(postsRouter).use(categoriesRouter).use(filesRouter),
  );

if (import.meta.main) {
  const port = process.env.PORT || 3001;
  app.listen(port);
  console.log(`🦊 ElysiaJS CMS APIサーバー起動中: ${app.server?.hostname}:${app.server?.port}`);
}

export type App = typeof app;
export default app;
