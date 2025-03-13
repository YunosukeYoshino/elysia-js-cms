import { Elysia, t } from 'elysia';
import { authorize } from '../middlewares/auth';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { mkdir, unlink } from 'fs/promises';
import { join, extname } from 'path';
import mime from 'mime-types';
import sharp from 'sharp';
import { formidable } from 'formidable';
import { createReadStream, writeFileSync } from 'fs';

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

// ファイルアップロード処理のヘルパー関数
async function handleFileUpload(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024, // 10MB
      uploadDir: UPLOAD_DIR,
      filename: (name, ext, part, form) => {
        const uniqueId = uuidv4();
        const extension = extname(part.originalFilename || 'file');
        return `${uniqueId}${extension}`;
      },
      keepExtensions: true
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ fields, files });
    });
  });
}

export const filesRouter = new Elysia({ prefix: '/files' })
  // Swagger用のタグを定義
  .meta({
    tags: ['files']
  })
  // 認証ミドルウェアを使用
  .use(authorize)
  // ファイルをアップロード
  .post(
    '/upload',
    async ({ request, set, user }) => {
      try {
        // 認証済みユーザーのIDを取得
        const userId = user?.id;
        
        if (!userId) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }

        // formidableを使ってファイルをパース
        const { files } = await handleFileUpload(request);
        const uploadedFile = Object.values(files)[0]?.[0];
        
        if (!uploadedFile) {
          set.status = 400;
          return { success: false, message: 'No file uploaded' };
        }

        const originalName = uploadedFile.originalFilename || 'untitled';
        const fileName = uploadedFile.newFilename;
        const fileExt = extname(fileName);
        const mimeType = mime.lookup(fileExt) || 'application/octet-stream';
        const filePath = uploadedFile.filepath;
        const fileSize = uploadedFile.size;
        
        let thumbnailPath = null;
        
        // 画像ファイルの場合はサムネイルを生成
        if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
          thumbnailPath = join(THUMBS_DIR, fileName);
          await sharp(filePath)
            .resize(200, 200, { fit: 'inside' })
            .toFile(thumbnailPath);
          
          // 相対パスに変換
          thumbnailPath = `/thumbnails/${fileName}`;  // URLパスとして保存
        }
        
        // データベースにファイル情報を保存
        const fileEntry = await prisma.file.create({
          data: {
            fileName,
            originalName,
            mimeType,
            filePath: `/files/${fileName}`,  // URLパスとして保存
            thumbnailPath,
            fileSize,
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
      detail: {
        tags: ['files'],
        summary: 'ファイルをアップロードする',
        description: '新しいファイルをサーバーにアップロードします'
      }
    }
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
          where: { fileName }
        });
        
        if (!fileInfo) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }
        
        // ファイルを読み込んで返す
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
        fileName: t.String()
      }),
      detail: {
        tags: ['files'],
        summary: 'ファイルコンテンツを取得',
        description: 'ファイル名を指定してコンテンツを取得します'
      }
    }
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
          where: { fileName }
        });
        
        if (!fileInfo || !fileInfo.thumbnailPath) {
          set.status = 404;
          return { success: false, message: 'Thumbnail not found' };
        }
        
        // サムネイルを読み込んで返す
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
        fileName: t.String()
      }),
      detail: {
        tags: ['files'],
        summary: 'サムネイルを取得',
        description: 'ファイル名を指定してサムネイルを取得します'
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
    async ({ params, set, user }) => {
      try {
        // 認証チェック
        if (!user?.id) {
          set.status = 401;
          return { success: false, message: 'Unauthorized' };
        }

        const fileId = Number(params.id);
        
        // ファイル情報を取得
        const file = await prisma.file.findUnique({
          where: { id: fileId }
        });

        if (!file) {
          set.status = 404;
          return { success: false, message: 'File not found' };
        }

        // 所有者チェック（管理者でない場合）
        if (file.userId !== user.id && user.role !== 'admin') {
          set.status = 403;
          return { success: false, message: 'Permission denied' };
        }

        // DBからファイル情報を削除
        await prisma.file.delete({
          where: { id: fileId }
        });

        // ディスクからファイルを削除
        const actualFilePath = join(UPLOAD_DIR, file.fileName);
        await unlink(actualFilePath).catch(err => console.error(`Failed to delete file ${actualFilePath}:`, err));

        // サムネイルがある場合は削除
        if (file.thumbnailPath) {
          const actualThumbPath = join(THUMBS_DIR, file.fileName);
          await unlink(actualThumbPath).catch(err => console.error(`Failed to delete thumbnail ${actualThumbPath}:`, err));
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
