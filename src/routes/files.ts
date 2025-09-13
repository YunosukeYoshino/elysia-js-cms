import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { User } from '@prisma/client';
import { Elysia, t } from 'elysia';
import { type Fields, type Files, type File as FormidableFile, IncomingForm } from 'formidable';
import mime from 'mime-types';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middlewares/auth';

/**
 * ファイルアップロードのドメインインターフェース
 * @description アップロードされたファイルの型定義
 */
interface FileUpload extends FormidableFile {
  filepath: string;
  originalFilename: string;
  newFilename: string;
  size: number;
}

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
    async ({
      request,
      user,
      set,
    }: {
      request: Request;
      user: User | null;
      set: { status: number };
    }) => {
      try {
        // 認証済みユーザーのIDを取得
        if (!user) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }
        const userId = Number(user.id);

        // アップロードディレクトリの作成
        try {
          await mkdir(UPLOAD_DIR, { recursive: true });
          await mkdir(THUMBS_DIR, { recursive: true });
        } catch (error) {
          console.error('ディレクトリの作成に失敗しました:', error);
          set.status = 500;
          return { success: false, message: 'サーバーエラー' };
        }

        // ファイルのアップロード処理
        const form = new IncomingForm({
          uploadDir: UPLOAD_DIR,
          keepExtensions: true,
          maxFileSize: 10 * 1024 * 1024, // 10MB
        });

        return new Promise<FileUploadResponse>((resolve) => {
          // formidableとの型互換性を保ちながら、型安全な実装を行う
          // ElysiaではRequestオブジェクトを直接渡す
          form.parse(request, async (err: Error | null, _fields: Fields, files: Files) => {
            if (err) {
              console.error('ファイルのアップロードに失敗しました:', err);
              set.status = 500;
              resolve({
                success: false,
                message: 'ファイルのアップロードに失敗しました',
              });
              return;
            }

            // ファイルの型を適切に定義
            const uploadedFile = files.file?.[0] as FileUpload;
            if (!uploadedFile) {
              set.status = 400;
              resolve({
                success: false,
                message: 'ファイルが見つかりません',
              });
              return;
            }

            try {
              // ファイルの保存とサムネイル生成
              const fileId = uuidv4();
              const originalName = uploadedFile.originalFilename || 'unknown';
              const mimeType = mime.lookup(originalName) || 'application/octet-stream';

              // データベースにファイル情報を保存
              const fileData = await prisma.file.create({
                data: {
                  id: Number(fileId),
                  fileName: originalName,
                  originalName,
                  mimeType,
                  filePath: uploadedFile.filepath,
                  fileSize: uploadedFile.size,
                  userId: userId,
                },
              });

              // 画像ファイルの場合、サムネイルを生成
              if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
                const thumbPath = join(THUMBS_DIR, `${fileData.id}_thumb.jpg`);
                await sharp(uploadedFile.filepath)
                  .resize(200, 200, { fit: 'inside' })
                  .jpeg({ quality: 80 })
                  .toFile(thumbPath);

                await prisma.file.update({
                  where: { id: fileData.id },
                  data: {
                    thumbnailPath: `/thumbnails/${fileData.id}_thumb.jpg`,
                  },
                });
              }

              resolve({
                success: true,
                message: 'ファイルのアップロードが完了しました',
                file: fileData,
              });
            } catch (error) {
              console.error('ファイル処理中にエラーが発生しました:', error);
              set.status = 500;
              resolve({
                success: false,
                message: 'ファイル処理中にエラーが発生しました',
              });
            }
          });
        });
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
      },
    },
  )
  // ファイルを提供するエンドポイント
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
          where: { fileName },
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
    async ({
      params,
      set,
      user,
    }: {
      params: { id: string };
      set: { status: number };
      user: User | null;
    }) => {
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
          const actualThumbPath = join(THUMBS_DIR, file.fileName);
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
