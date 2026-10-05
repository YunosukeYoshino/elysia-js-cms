import { mkdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Elysia, t } from 'elysia';
import mime from 'mime-types';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';

/**
 * ファイルアップロードのドメインインターフェース
 * @description アップロードされたファイルの型定義
 */
/**
 * ファイルアップロードのレスポンスインターフェース
 * @description ファイルアップロードの結果を表現するドメインオブジェクト
 */
interface FileUploadResponse {
  success: boolean;
  message: string;
  file?: {
    id: number;
    originalName: string;
    mimeType: string;
    filePath: string;
    fileSize: number;
    thumbnailPath?: string | null;
    userId: number;
  };
}

/**
 * ファイル管理関連のルーティング定義
 * DDDアプローチに基づき、プレゼンテーション層としてのルーティングを実装
 */
// アップロードされたファイルの保存先ディレクトリ
const UPLOAD_DIR = './uploads';
const THUMBS_DIR = './uploads/thumbnails';

// 初期化時にディレクトリを作成
try {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(THUMBS_DIR, { recursive: true });
  console.log('Upload directories created successfully');
} catch (error) {
  console.error('Error creating upload directories:', error);
}

export const filesRouter = new Elysia({ prefix: '/files' })
  .use(authMiddleware)
  .post(
    '/upload',
    async ({ request, user, set }): Promise<FileUploadResponse> => {
      if (!user) {
        set.status = 401;
        return { success: false, message: 'Unauthorized' };
      }
      const maxSize = 10 * 1024 * 1024;
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let upload: FormDataEntryValue | null;
      try {
        if (reader)
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > maxSize + 64 * 1024) {
              await reader.cancel();
              set.status = 413;
              return { success: false, message: 'Upload too large' };
            }
            chunks.push(part.value);
          }
        upload = (
          await new Response(Buffer.concat(chunks), { headers: request.headers }).formData()
        ).get('file');
      } catch {
        set.status = 400;
        return { success: false, message: 'Invalid multipart upload' };
      } finally {
        reader?.releaseLock();
      }
      if (!(upload instanceof File)) {
        set.status = 400;
        return { success: false, message: 'File not found' };
      }
      if (upload.size > maxSize) {
        set.status = 413;
        return { success: false, message: 'Upload too large' };
      }
      const fileName = uuidv4();
      const filePath = join(UPLOAD_DIR, fileName);
      const thumbName = fileName + '_thumb.jpg';
      const thumbPath = join(THUMBS_DIR, thumbName);
      try {
        await Bun.write(filePath, upload);
        const mimeType = mime.lookup(upload.name) || 'application/octet-stream';
        let thumbnailPath: string | null = null;
        if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
          await sharp(filePath)
            .resize(200, 200, { fit: 'inside' })
            .jpeg({ quality: 80 })
            .toFile(thumbPath);
          thumbnailPath = '/thumbnails/' + thumbName;
        }
        const file = await prisma.file.create({
          data: {
            fileName,
            originalName: upload.name || 'unknown',
            mimeType,
            filePath,
            fileSize: upload.size,
            userId: user.id,
            thumbnailPath,
          },
        });
        return { success: true, message: 'File uploaded successfully', file };
      } catch (error) {
        await Promise.all([filePath, thumbPath].map((path) => unlink(path).catch(() => {})));
        console.error('File upload failed:', error);
        set.status = 500;
        return { success: false, message: 'Failed to upload file' };
      }
    },
    { parse: 'none', detail: { tags: ['files'], summary: 'Upload a file' } },
  )
  .get(
    '/content/:fileName',
    async ({ params, set }) => {
      try {
        const { fileName } = params;
        const filePath = join(UPLOAD_DIR, fileName);

        // ファイルの存在確認とMIMEタイプの取得
        const fileInfo = await prisma.file.findFirst({
          where: { fileName },
        });

        if (!fileInfo) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        // ファイルを読み込んで返す
        const { createReadStream } = await import('node:fs');
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
    async ({ params, set }) => {
      try {
        const { fileName } = params;
        const thumbPath = join(THUMBS_DIR, fileName);

        // ファイルの存在確認とMIMEタイプの取得
        const fileInfo = await prisma.file.findFirst({
          where: { thumbnailPath: '/thumbnails/' + fileName },
        });

        if (!fileInfo || !fileInfo.thumbnailPath) {
          set.status = 404;
          return { success: false, message: 'Thumbnail not found' };
        }

        // サムネイルを読み込んで返す
        const { createReadStream } = await import('node:fs');
        const file = createReadStream(thumbPath);
        set.headers['Content-Type'] = fileInfo.mimeType;
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
    async ({ query }) => {
      try {
        const page = Number(query.page) || 1;
        const limit = Number(query.limit) || 20;
        const skip = (page - 1) * limit;

        const files = await prisma.file.findMany({
          skip,
          take: limit,
          orderBy: {
            createdAt: 'desc',
          },
        });

        const total = await prisma.file.count();

        return {
          success: true,
          data: files,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
          },
        };
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
    async ({ params, set }) => {
      try {
        const fileId = Number(params.id);

        const file = await prisma.file.findUnique({
          where: { id: fileId },
        });

        if (!file) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        return {
          success: true,
          data: file,
        };
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
    async ({ params, set, user }) => {
      try {
        // 認証チェック
        if (!user) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }
        const userId = Number(user.id);

        const fileId = Number(params.id);

        // ファイル情報を取得
        const file = await prisma.file.findUnique({
          where: { id: fileId },
        });

        if (!file) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        // 所有者チェック（管理者でない場合）
        if (file.userId !== userId && user.role !== 'admin') {
          set.status = 403;
          return { success: false, message: 'Permission denied' };
        }

        // DBからファイル情報を削除
        await prisma.file.delete({
          where: { id: fileId },
        });

        // ディスクからファイルを削除
        const actualFilePath = join(UPLOAD_DIR, file.fileName);
        await unlink(actualFilePath).catch((err) =>
          console.error(`Failed to delete file ${actualFilePath}:`, err),
        );

        // サムネイルがある場合は削除
        if (file.thumbnailPath) {
          const actualThumbPath = join(THUMBS_DIR, basename(file.thumbnailPath));
          await unlink(actualThumbPath).catch((err) =>
            console.error(`Failed to delete thumbnail ${actualThumbPath}:`, err),
          );
        }

        return {
          success: true,
          message: 'File deleted successfully',
        };
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
      },
    },
  );
