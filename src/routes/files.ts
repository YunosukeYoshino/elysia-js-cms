import { join } from 'node:path';
import type { User } from '@prisma/client';
import { Elysia, t } from 'elysia';
import { IncomingForm } from 'formidable';
import { containerPlugin, type ServiceContainer } from '../container';
import { authMiddleware } from '../middlewares/auth';

/**
 * ファイル管理関連のルーティング定義
 * サービス層を使用したプレゼンテーション層の実装
 */
export const filesRouter = new Elysia({ prefix: '/files' })
  .use(containerPlugin)
  .use(authMiddleware)
  .post(
    '/upload',
    async ({
      request,
      user,
      set,
      services,
    }: {
      request: Request;
      user: User | null;
      set: { status: number };
      services: ServiceContainer;
    }) => {
      try {
        // 認証済みユーザーのIDを取得
        if (!user) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }
        const userId = Number(user.id);

        // ファイルのアップロード処理
        const form = new IncomingForm({
          uploadDir: './uploads',
          keepExtensions: true,
          maxFileSize: 10 * 1024 * 1024, // 10MB
        });

        return await services.file.uploadFile(form, request, userId, set);
      } catch (error) {
        console.error('File upload error:', error);
        set.status = 500;
        return {
          success: false,
          message: 'Failed to upload file',
          error: String(error),
        };
      }
    },
    {
      detail: {
        tags: ['files'],
        summary: 'ファイルをアップロードする',
        description: '新しいファイルをサーバーにアップロードします',
        security: [{ bearerAuth: [] }],
      },
    },
  )
  // ファイルを提供するエンドポイント
  .get(
    '/content/:fileName',
    async ({ params, set, services }) => {
      try {
        const { fileName } = params;

        // ファイル情報を取得
        const fileInfo = await services.file.getFileByName(fileName);

        if (!fileInfo) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        // ファイルを読み込んで返す
        const { createReadStream } = await import('node:fs');
        const filePath = fileInfo.filePath;
        if (!filePath) {
          set.status = 500;
          return { success: false, message: 'Failed to resolve file path' };
        }
        const file = createReadStream(filePath);
        set.headers['Content-Type'] = fileInfo.mimeType;
        return file;
      } catch (error) {
        console.error('Error serving file:', error);
        set.status = 500;
        return { success: false, message: 'Failed to serve file' };
      }
    },
    {
      params: t.Object({
        fileName: t.String(),
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイルコンテンツを取得',
        description: 'ファイル名を指定してコンテンツを取得します',
      },
    },
  )
  // サムネイルを提供するエンドポイント
  .get(
    '/thumbnails/:fileName',
    async ({ params, set, services }) => {
      try {
        const { fileName } = params;

        // ファイル情報を取得
        const fileInfo = await services.file.getFileByName(fileName);

        if (!fileInfo || !fileInfo.thumbnailPath) {
          set.status = 404;
          return { success: false, message: 'Thumbnail not found' };
        }

        // サムネイルを読み込んで返す
        const { createReadStream } = await import('node:fs');
        const { thumbsDir } = services.file.getDirectoryPaths();
        const thumbPath = join(thumbsDir, `${fileInfo.id}_thumb.jpg`);
        const file = createReadStream(thumbPath);
        set.headers['Content-Type'] = 'image/jpeg';
        return file;
      } catch (error) {
        console.error('Error serving thumbnail:', error);
        set.status = 500;
        return { success: false, message: 'Failed to serve thumbnail' };
      }
    },
    {
      params: t.Object({
        fileName: t.String(),
      }),
      detail: {
        tags: ['files'],
        summary: 'サムネイルを取得',
        description: 'ファイル名を指定してサムネイルを取得します',
      },
    },
  )
  // ファイル一覧を取得
  .get(
    '/',
    async ({ query, services }) => {
      try {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;

        return await services.file.getFileList(page, limit);
      } catch (error) {
        console.error('Error fetching files:', error);
        return {
          success: false,
          message: 'Failed to fetch files',
          error: String(error),
        };
      }
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイル一覧を取得',
        description: 'アップロードされたファイルの一覧を取得します',
      },
    },
  )
  // 特定のファイルを取得
  .get(
    '/:id',
    async ({ params, set, services }) => {
      try {
        const fileId = Number(params.id);
        const result = await services.file.getFileById(fileId);

        if (!result.success) {
          set.status = 404;
        }

        return result;
      } catch (error) {
        console.error('Error fetching file:', error);
        set.status = 500;
        return {
          success: false,
          message: 'Failed to fetch file',
          error: String(error),
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        tags: ['files'],
        summary: '特定のファイル情報を取得',
        description: 'IDを指定してファイル情報を取得します',
      },
    },
  )
  // ファイルを削除
  .delete(
    '/:id',
    async ({
      params,
      set,
      user,
      services,
    }: {
      params: { id: string };
      set: { status: number };
      user: User | null;
      services: ServiceContainer;
    }) => {
      try {
        // 認証チェック
        if (!user) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }

        const fileId = Number(params.id);
        const result = await services.file.deleteFile(fileId, user);

        if (!result.success) {
          if (result.message === 'File not found') {
            set.status = 404;
          } else if (result.message === 'Permission denied') {
            set.status = 403;
          }
        }

        return result;
      } catch (error) {
        console.error('Error deleting file:', error);
        set.status = 500;
        return {
          success: false,
          message: 'Failed to delete file',
          error: String(error),
        };
      }
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイルを削除',
        description: 'IDを指定してファイルを削除します',
        security: [{ bearerAuth: [] }],
      },
    },
  );
