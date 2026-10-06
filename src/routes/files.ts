import { Elysia, t } from 'elysia';
import { DomainError } from '../domain/errors/domain-error';
import { FileService, MAX_UPLOAD_SIZE } from '../domain/services/file-service';
import prisma from '../lib/prisma';
import { LocalFileStorage } from '../lib/storage/local-file-storage';
import { authMiddleware } from '../middlewares/auth';
import { domainErrorPlugin } from '../middlewares/domain-error';

/** リクエスト層でストリームを制限してから multipart を解析する。 */
export async function readUpload(request: Request): Promise<File> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let upload: FormDataEntryValue | null;
  try {
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_UPLOAD_SIZE + 64 * 1024) {
          await reader.cancel();
          throw new DomainError('UPLOAD_TOO_LARGE', 413, 'Upload too large');
        }
        chunks.push(part.value);
      }
    }
    upload = (
      await new Response(Buffer.concat(chunks), { headers: request.headers }).formData()
    ).get('file');
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_MULTIPART', 400, 'Invalid multipart upload');
  } finally {
    reader?.releaseLock();
  }
  if (!(upload instanceof File)) throw new DomainError('FILE_REQUIRED', 400, 'File not found');
  return upload;
}

/** ファイル用コントローラー。HTTP の解釈のみ担当し、業務処理はサービスへ委譲する。 */
export const createFilesRouter = (
  service: FileService = new FileService(prisma, new LocalFileStorage()),
) =>
  new Elysia({ name: 'cms.file-routes', prefix: '/files' })
    .use(domainErrorPlugin)
    .use(authMiddleware)
    .post(
      '/upload',
      async ({ request, user }) => {
        if (!user) throw new DomainError('AUTH_REQUIRED', 401, 'Unauthorized');
        const file = await service.upload(await readUpload(request), user.id);
        return { success: true, message: 'File uploaded successfully', file };
      },
      { parse: 'none', detail: { tags: ['files'], summary: 'ファイルをアップロード' } },
    )
    .get(
      '/content/:fileName',
      async ({ params, set }) => {
        const result = await service.content(params.fileName);
        set.headers['Content-Type'] = result.mimeType;
        return result.body;
      },
      {
        params: t.Object({ fileName: t.String() }),
        detail: { tags: ['files'], summary: 'ファイルコンテンツを取得' },
      },
    )
    .get(
      '/thumbnails/:fileName',
      async ({ params, set }) => {
        const result = await service.content(params.fileName, true);
        set.headers['Content-Type'] = result.mimeType;
        return result.body;
      },
      {
        params: t.Object({ fileName: t.String() }),
        detail: { tags: ['files'], summary: 'サムネイルを取得' },
      },
    )
    .get(
      '/',
      async ({ query }) => ({
        success: true,
        ...(await service.list(
          query.page === undefined ? 1 : Number(query.page),
          query.limit === undefined ? 20 : Number(query.limit),
        )),
      }),
      {
        query: t.Object({ page: t.Optional(t.String()), limit: t.Optional(t.String()) }),
        detail: { tags: ['files'], summary: 'ファイル一覧を取得' },
      },
    )
    .get(
      '/:id',
      async ({ params }) => ({ success: true, data: await service.getById(params.id) }),
      {
        params: t.Object({ id: t.Numeric({ minimum: 1, maximum: 2147483647, multipleOf: 1 }) }),
        detail: { tags: ['files'], summary: 'ファイル情報を取得' },
      },
    )
    .delete(
      '/:id',
      ({ params, user }) => {
        if (!user) throw new DomainError('AUTH_REQUIRED', 401, 'Unauthorized');
        return service.delete(params.id, user);
      },
      {
        params: t.Object({ id: t.Numeric({ minimum: 1, maximum: 2147483647, multipleOf: 1 }) }),
        detail: { tags: ['files'], summary: 'ファイルを削除' },
      },
    );

export const filesRouter = createFilesRouter();
