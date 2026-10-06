import type { File as FileRecord } from '@prisma/client';
import mime from 'mime-types';
import { DomainError } from '../errors/domain-error';
import type { FileStorage, StagedFileDeletion } from '../repositories/file-storage';
import type { FileRepository } from '../repositories/service-database';

export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
export interface FileActor {
  id: number;
  role: string;
}

/** アップロードとファイル削除の業務処理。ストレージ障害は補償処理を行う。 */
export class FileService {
  /** DB とストレージ、名前の生成処理を注入する。 */
  constructor(
    private readonly repository: FileRepository,
    private readonly storage: FileStorage,
    private readonly createName: () => string = () => crypto.randomUUID(),
  ) {}

  /** 原本・縮小版・DB レコードを作成し、途中失敗時にはファイルを除去する。 */
  async upload(upload: File, userId: number): Promise<FileRecord> {
    if (upload.size > MAX_UPLOAD_SIZE)
      throw new DomainError('UPLOAD_TOO_LARGE', 413, 'Upload too large');
    const name = this.createName();
    try {
      const filePath = await this.storage.write(name, upload);
      const mimeType = mime.lookup(upload.name) || 'application/octet-stream';
      const thumbnailPath =
        mimeType.startsWith('image/') && mimeType !== 'image/svg+xml'
          ? await this.storage.thumbnail(name)
          : null;
      return await this.repository.file.create({
        data: {
          fileName: name,
          originalName: upload.name || 'unknown',
          mimeType,
          filePath,
          fileSize: upload.size,
          userId,
          thumbnailPath,
        },
      });
    } catch {
      const cleanup = await Promise.allSettled([
        this.storage.remove(name, false),
        this.storage.remove(name, true),
      ]);
      if (cleanup.some((result) => result.status === 'rejected'))
        throw new DomainError(
          'UPLOAD_CLEANUP_FAILED',
          500,
          'Upload failed; storage cleanup requires retry',
        );
      throw new DomainError('UPLOAD_FAILED', 500, 'Failed to upload file');
    }
  }

  /** 境界を検証してファイル一覧を返す。 */
  async list(
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    data: FileRecord[];
    pagination: { total: number; page: number; limit: number; pages: number };
  }> {
    const skip = (page - 1) * limit;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(skip)
    )
      throw new DomainError('INVALID_PAGINATION', 422, 'Invalid pagination');
    const [data, total] = await this.repository.$transaction([
      this.repository.file.findMany({
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.repository.file.count(),
    ]);
    return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /** ファイルのメタデータを取得する。 */
  async getById(id: number): Promise<FileRecord> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      throw new DomainError('INVALID_FILE_ID', 422, 'Invalid file ID');
    const file = await this.repository.file.findUnique({ where: { id } });
    if (!file) throw new DomainError('FILE_NOT_FOUND', 404, 'File not found');
    return file;
  }

  /** DB のキーを解決してからコンテンツを開く。リクエストのパスを直接使用しない。 */
  async content(
    name: string,
    thumbnail: boolean = false,
  ): Promise<{ body: Blob; mimeType: string }> {
    const file = await this.repository.file.findFirst({
      where: thumbnail ? { thumbnailPath: '/thumbnails/' + name } : { fileName: name },
    });
    if (!file)
      throw new DomainError(
        'FILE_NOT_FOUND',
        404,
        thumbnail ? 'Thumbnail not found' : 'File not found',
      );
    try {
      return {
        body: await this.storage.read(file.fileName, thumbnail),
        mimeType: thumbnail ? 'image/jpeg' : file.mimeType,
      };
    } catch {
      throw new DomainError('FILE_CONTENT_MISSING', 404, 'Stored file not found');
    }
  }

  /** 退避後に DB 削除を行い、DB 失敗時に復元する。確定後のゴミ削除失敗は明示する。 */
  async delete(
    id: number,
    actor: FileActor,
  ): Promise<{ success: true; message: string; cleanupPending: boolean }> {
    const file = await this.getById(id);
    if (file.userId !== actor.id && actor.role !== 'admin')
      throw new DomainError('FILE_FORBIDDEN', 403, 'Permission denied');
    let staged: StagedFileDeletion;
    try {
      staged = await this.storage.stageDelete(file.fileName, file.thumbnailPath !== null);
    } catch {
      throw new DomainError('FILE_STAGE_FAILED', 500, 'Failed to prepare file deletion');
    }
    try {
      await this.repository.$transaction(async (tx) => {
        await tx.file.delete({ where: { id } });
      });
    } catch {
      try {
        await staged.rollback();
      } catch {
        throw new DomainError(
          'FILE_RESTORE_FAILED',
          500,
          'File deletion failed; storage restoration requires retry',
        );
      }
      throw new DomainError('FILE_DELETE_FAILED', 500, 'Failed to delete file');
    }
    let cleanupPending = false;
    try {
      await staged.commit();
    } catch {
      cleanupPending = true;
    }
    return { success: true, message: 'File deleted successfully', cleanupPending };
  }
}
