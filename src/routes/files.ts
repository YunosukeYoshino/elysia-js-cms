import { Elysia, t } from 'elysia';
import { files } from '@elysiajs/files';
import { authorize } from '../middlewares/auth';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, unlink } from 'fs/promises';
import { join, extname } from 'path';
import mime from 'mime-types';
import sharp from 'sharp';

const prisma = new PrismaClient();

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
  // Swagger用のタグを定義
  .meta({
    tags: ['files']
  })
  // ファイルアップロードプラグインを使用
  .use(
    files({
      limit: '10mb' // アップロードサイズ制限
    })
  )
  // ファイルをアップロード
  .post(
    '/upload',
    async ({ body, set }) => {
      try {
        // 認証済みユーザーのIDを取得（ここでは仮に1を使用）
        // 実際には認証ミドルウェアからユーザーIDを取得します
        const userId = 1;

        // ファイルが存在するか確認
        if (!body.file) {
          set.status = 400;
          return { success: false, message: 'No file uploaded' };
        }

        const file = body.file;
        const originalName = file.name;
        const fileExt = extname(originalName);
        const mimeType = mime.lookup(fileExt) || 'application/octet-stream';
        
        // ユニークなファイル名を生成
        const uniqueId = uuidv4();
        const fileName = `${uniqueId}${fileExt}`;
        const filePath = join(UPLOAD_DIR, fileName);
        
        // ファイルをディスクに保存
        await Bun.write(filePath, file);
        
        let thumbnailPath = null;
        
        // 画像ファイルの場合はサムネイルを生成
        if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
          thumbnailPath = join(THUMBS_DIR, fileName);
          await sharp(filePath)
            .resize(200, 200, { fit: 'inside' })
            .toFile(thumbnailPath);
          
          // 相対パスに変換
          thumbnailPath = thumbnailPath.replace('./', '/');
        }
        
        // データベースにファイル情報を保存
        const fileEntry = await prisma.file.create({
          data: {
            fileName,
            originalName,
            mimeType,
            filePath: filePath.replace('./', '/'),
            thumbnailPath,
            fileSize: file.size,
            userId
          }
        });

        return {
          success: true,
          file: fileEntry
        };
      } catch (error) {
        console.error('File upload error:', error);
        set.status = 500;
        return { success: false, message: 'Failed to upload file', error: String(error) };
      }
    },
    {
      body: t.Object({
        file: t.File(),
        description: t.Optional(t.String())
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイルをアップロードする',
        description: '新しいファイルをサーバーにアップロードします'
      }
    }
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
            createdAt: 'desc'
          }
        });

        const total = await prisma.file.count();

        return {
          success: true,
          data: files,
          pagination: {
            total,
            page,
            limit,
            pages: Math.ceil(total / limit)
          }
        };
      } catch (error) {
        console.error('Error fetching files:', error);
        return { success: false, message: 'Failed to fetch files', error: String(error) };
      }
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String())
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイル一覧を取得',
        description: 'アップロードされたファイルの一覧を取得します'
      }
    }
  )
  // 特定のファイルを取得
  .get(
    '/:id',
    async ({ params, set }) => {
      try {
        const fileId = Number(params.id);
        
        const file = await prisma.file.findUnique({
          where: { id: fileId }
        });

        if (!file) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        return {
          success: true,
          data: file
        };
      } catch (error) {
        console.error('Error fetching file:', error);
        set.status = 500;
        return { success: false, message: 'Failed to fetch file', error: String(error) };
      }
    },
    {
      params: t.Object({
        id: t.String()
      }),
      detail: {
        tags: ['files'],
        summary: '特定のファイル情報を取得',
        description: 'IDを指定してファイル情報を取得します'
      }
    }
  )
  // ファイルを削除
  .delete(
    '/:id',
    async ({ params, set }) => {
      try {
        const fileId = Number(params.id);
        
        // ファイル情報を取得
        const file = await prisma.file.findUnique({
          where: { id: fileId }
        });

        if (!file) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        // DBからファイル情報を削除
        await prisma.file.delete({
          where: { id: fileId }
        });

        // ディスクからファイルを削除
        const filePath = `.${file.filePath}`;
        await unlink(filePath).catch(err => console.error(`Failed to delete file ${filePath}:`, err));

        // サムネイルがある場合は削除
        if (file.thumbnailPath) {
          const thumbPath = `.${file.thumbnailPath}`;
          await unlink(thumbPath).catch(err => console.error(`Failed to delete thumbnail ${thumbPath}:`, err));
        }

        return {
          success: true,
          message: 'File deleted successfully'
        };
      } catch (error) {
        console.error('Error deleting file:', error);
        set.status = 500;
        return { success: false, message: 'Failed to delete file', error: String(error) };
      }
    },
    {
      params: t.Object({
        id: t.String()
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイルを削除',
        description: 'IDを指定してファイルを削除します'
      }
    }
  );
