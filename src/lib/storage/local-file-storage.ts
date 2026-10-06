import { mkdir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { FileStorage, StagedFileDeletion } from '../../domain/repositories/file-storage';

/** ローカルディスク用のストレージアダプター。作成は必要時のみ行う。 */
export class LocalFileStorage implements FileStorage {
  /** テストでは専用一時ディレクトリを注入する。 */
  constructor(private readonly root: string = './uploads') {}

  private path(name: string, thumbnail: boolean): string {
    if (name !== basename(name) || name.includes('\\') || name === '.' || name === '..')
      throw new Error('Invalid storage key');
    return thumbnail ? join(this.root, 'thumbnails', name + '_thumb.jpg') : join(this.root, name);
  }

  /** 原本を保存する。 */
  async write(name: string, file: File): Promise<string> {
    await mkdir(join(this.root, 'thumbnails'), { recursive: true });
    const path = this.path(name, false);
    await Bun.write(path, file);
    return path;
  }

  /** 画像の縮小版を生成する。 */
  async thumbnail(name: string): Promise<string> {
    await mkdir(join(this.root, 'thumbnails'), { recursive: true });
    await sharp(this.path(name, false))
      .resize(200, 200, { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toFile(this.path(name, true));
    return '/thumbnails/' + name + '_thumb.jpg';
  }

  /** 存在を確認して読み取り可能な Blob を返す。 */
  async read(name: string, thumbnail: boolean): Promise<Blob> {
    const file = Bun.file(this.path(name, thumbnail));
    if (!(await file.exists())) throw new Error('Stored file is missing');
    return file;
  }

  /** アップロード失敗時の残骸を削除する。未作成は成功として扱う。 */
  async remove(name: string, thumbnail: boolean): Promise<void> {
    try {
      await unlink(this.path(name, thumbnail));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  /** 同じファイルシステム内で退避する。部分失敗はすでに退避したファイルを復元する。 */
  async stageDelete(name: string, thumbnail: boolean): Promise<StagedFileDeletion> {
    const paths: string[] = [this.path(name, false)];
    if (thumbnail) paths.push(this.path(name, true));
    const staged: Array<{ original: string; temporary: string }> = [];
    const rollback = async (): Promise<void> => {
      for (const entry of [...staged].reverse()) await rename(entry.temporary, entry.original);
    };
    try {
      for (const original of paths) {
        const temporary = original + '.delete-' + crypto.randomUUID();
        await rename(original, temporary);
        staged.push({ original, temporary });
      }
    } catch (error) {
      await rollback();
      throw error;
    }
    return {
      rollback,
      commit: async (): Promise<void> => {
        for (const entry of staged) await unlink(entry.temporary);
      },
    };
  }
}
