import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FileStorage, StagedFileDeletion } from '../../domain/repositories/file-storage';
import { FileService, MAX_UPLOAD_SIZE } from '../../domain/services/file-service';
import { LocalFileStorage } from '../../lib/storage/local-file-storage';
import { createTestDatabase, seedUser, type TestDatabase } from './helpers';

/** 実ディスクへ委譲し、指定した境界だけを失敗させるテストアダプター。 */
class FaultStorage implements FileStorage {
  constructor(
    private readonly actual: FileStorage,
    private readonly failure: 'write' | 'thumbnail' | 'remove' | 'stage' | 'commit' | 'rollback',
  ) {}
  async write(name: string, file: File): Promise<string> {
    if (this.failure === 'write' || this.failure === 'remove')
      throw new Error('private write details');
    return this.actual.write(name, file);
  }
  async thumbnail(name: string): Promise<string> {
    if (this.failure === 'thumbnail') throw new Error('private image details');
    return this.actual.thumbnail(name);
  }
  async read(name: string, thumbnail: boolean): Promise<Blob> {
    return this.actual.read(name, thumbnail);
  }
  async remove(name: string, thumbnail: boolean): Promise<void> {
    if (this.failure === 'remove') throw new Error('private cleanup details');
    return this.actual.remove(name, thumbnail);
  }
  async stageDelete(name: string, thumbnail: boolean): Promise<StagedFileDeletion> {
    if (this.failure === 'stage') throw new Error('private staging details');
    const operation = await this.actual.stageDelete(name, thumbnail);
    return {
      commit: async (): Promise<void> => {
        if (this.failure === 'commit') throw new Error('private commit details');
        await operation.commit();
      },
      rollback: async (): Promise<void> => {
        if (this.failure === 'rollback') throw new Error('private restore details');
        await operation.rollback();
      },
    };
  }
}

describe('FileService real database and disk integration', () => {
  let fixture: TestDatabase;
  let service: FileService;
  let storage: LocalFileStorage;
  let ownerId = 0;
  let otherId = 0;
  beforeAll(async () => {
    fixture = await createTestDatabase();
    storage = new LocalFileStorage(join(fixture.directory, 'uploads'));
    service = new FileService(fixture.database, storage);
    ownerId = (await seedUser(fixture.database, 'file-owner')).id;
    otherId = (await seedUser(fixture.database, 'other-owner')).id;
  });
  afterAll(async () => {
    await fixture.close();
  });
  const owner = () => ({ id: ownerId, role: 'user' });
  const upload = (name = 'original.txt') => service.upload(new File(['file body'], name), ownerId);
  const filesOnDisk = async () => (await readdir(join(fixture.directory, 'uploads'))).sort();

  it('uploads unique storage keys, reads exact content and deletes as owner', async () => {
    const file = await upload('../original.txt');
    const second = await upload('../original.txt');
    expect(file.fileName).not.toBe(second.fileName);
    expect(file.fileName).not.toContain('/');
    expect(file.originalName).toBe('../original.txt');
    expect(await service.getById(file.id)).toEqual(file);
    const content = await service.content(file.fileName);
    expect(content.mimeType).toBe('text/plain');
    expect(await content.body.text()).toBe('file body');
    expect((await service.list()).data.some((entry) => entry.id === file.id)).toBe(true);
    expect((await service.delete(file.id, owner())).cleanupPending).toBe(false);
    expect(await Bun.file(file.filePath).exists()).toBe(false);
    expect(await fixture.database.file.findUnique({ where: { id: file.id } })).toBeNull();
  });

  it('creates a thumbnail and removes both assets when an administrator deletes', async () => {
    const bytes = await sharp({
      create: { width: 10, height: 10, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const file = await service.upload(new File([new Uint8Array(bytes)], 'image.png'), ownerId);
    if (!file.thumbnailPath) throw new Error('Thumbnail missing');
    const thumbnail = await service.content(file.thumbnailPath.slice('/thumbnails/'.length), true);
    expect(thumbnail.mimeType).toBe('image/jpeg');
    expect((await thumbnail.body.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await service.delete(file.id, { id: otherId, role: 'admin' })).cleanupPending).toBe(
      false,
    );
    expect(await Bun.file(file.filePath).exists()).toBe(false);
    expect(
      await Bun.file(
        join(fixture.directory, 'uploads/thumbnails', file.fileName + '_thumb.jpg'),
      ).exists(),
    ).toBe(false);
  });

  it('uses safe MIME defaults and leaves SVG unprocessed', async () => {
    const unknown = await upload('');
    expect(unknown.originalName).toBe('unknown');
    expect(unknown.mimeType).toBe('application/octet-stream');
    const svg = await upload('image.svg');
    expect(svg.mimeType).toBe('image/svg+xml');
    expect(svg.thumbnailPath).toBeNull();
  });

  it('rejects oversized files before disk or database writes', async () => {
    const before = await filesOnDisk();
    const count = await fixture.database.file.count();
    await expect(
      service.upload(new File([new Uint8Array(MAX_UPLOAD_SIZE + 1)], 'large.txt'), ownerId),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    expect(await filesOnDisk()).toEqual(before);
    expect(await fixture.database.file.count()).toBe(count);
  });

  it('compensates written files for DB and image processing failures', async () => {
    const before = await filesOnDisk();
    const count = await fixture.database.file.count();
    await expect(
      service.upload(new File(['orphan'], 'orphan.txt'), 99999999),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED', status: 500 });
    await expect(
      service.upload(new File(['not an image'], 'broken.png'), ownerId),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    expect(await filesOnDisk()).toEqual(before);
    expect(await fixture.database.file.count()).toBe(count);
    const failing = new FileService(fixture.database, new FaultStorage(storage, 'thumbnail'));
    await expect(failing.upload(new File(['image'], 'valid.png'), ownerId)).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
    expect(await filesOnDisk()).toEqual(before);
  });

  it('reports storage-write and cleanup failures as distinct safe errors', async () => {
    for (const failure of ['write', 'remove']) {
      const failing = new FileService(
        fixture.database,
        new FaultStorage(storage, failure === 'write' ? 'write' : 'remove'),
      );
      await expect(
        failing.upload(new File(['data'], 'failure.txt'), ownerId),
      ).rejects.toMatchObject({
        code: failure === 'write' ? 'UPLOAD_FAILED' : 'UPLOAD_CLEANUP_FAILED',
        status: 500,
      });
    }
  });

  it('enforces ID/pagination bounds, missing files and ownership before disk changes', async () => {
    await expect(service.getById(0)).rejects.toMatchObject({
      code: 'INVALID_FILE_ID',
      status: 422,
    });
    await expect(service.getById(99999999)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      status: 404,
    });
    for (const [page, limit] of [
      [0, 20],
      [1, 0],
      [1, 101],
      [1.5, 20],
      [Number.MAX_SAFE_INTEGER, 100],
    ])
      await expect(service.list(page, limit)).rejects.toMatchObject({
        code: 'INVALID_PAGINATION',
        status: 422,
      });
    await expect(service.content('../missing')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(service.content('missing_thumb.jpg', true)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    const file = await upload();
    await expect(service.delete(file.id, { id: otherId, role: 'user' })).rejects.toMatchObject({
      code: 'FILE_FORBIDDEN',
      status: 403,
    });
    expect(await Bun.file(file.filePath).exists()).toBe(true);
    await unlink(file.filePath);
    await expect(service.content(file.fileName)).rejects.toMatchObject({
      code: 'FILE_CONTENT_MISSING',
      status: 404,
    });
  });

  it('retains DB rows and original bytes when staging or DB deletion fails', async () => {
    const file = await upload('rollback.txt');
    const failing = new FileService(fixture.database, new FaultStorage(storage, 'stage'));
    await expect(failing.delete(file.id, owner())).rejects.toMatchObject({
      code: 'FILE_STAGE_FAILED',
    });
    await fixture.database.$executeRawUnsafe(
      "CREATE TRIGGER file_delete_failure BEFORE DELETE ON File WHEN OLD.originalName = 'rollback.txt' BEGIN SELECT RAISE(ABORT, 'private database failure'); END",
    );
    try {
      await expect(service.delete(file.id, owner())).rejects.toMatchObject({
        code: 'FILE_DELETE_FAILED',
      });
    } finally {
      await fixture.database.$executeRawUnsafe('DROP TRIGGER file_delete_failure');
    }
    expect(await service.getById(file.id)).toEqual(file);
    expect(await Bun.file(file.filePath).text()).toBe('file body');
  });

  it('restores the original when staging the thumbnail fails part-way through deletion', async () => {
    const file = await upload('partial-stage.txt');
    await fixture.database.file.update({
      where: { id: file.id },
      data: { thumbnailPath: '/thumbnails/' + file.fileName + '_thumb.jpg' },
    });
    const before = await filesOnDisk();
    await expect(service.delete(file.id, owner())).rejects.toMatchObject({
      code: 'FILE_STAGE_FAILED',
    });
    expect(await Bun.file(file.filePath).text()).toBe('file body');
    expect(await filesOnDisk()).toEqual(before);
    expect(await fixture.database.file.findUnique({ where: { id: file.id } })).not.toBeNull();
  });

  it('reports failed restoration without falsely claiming deletion succeeded', async () => {
    const file = await upload('restore-failure.txt');
    await fixture.database.$executeRawUnsafe(
      "CREATE TRIGGER file_restore_failure BEFORE DELETE ON File WHEN OLD.originalName = 'restore-failure.txt' BEGIN SELECT RAISE(ABORT, 'private failure'); END",
    );
    const failing = new FileService(fixture.database, new FaultStorage(storage, 'rollback'));
    try {
      await expect(failing.delete(file.id, owner())).rejects.toMatchObject({
        code: 'FILE_RESTORE_FAILED',
      });
    } finally {
      await fixture.database.$executeRawUnsafe('DROP TRIGGER file_restore_failure');
    }
    expect(await service.getById(file.id)).toEqual(file);
    expect((await filesOnDisk()).some((name) => name.startsWith(file.fileName + '.delete-'))).toBe(
      true,
    );
  });

  it('keeps failed post-commit cleanup quarantined and reports cleanupPending', async () => {
    const file = await upload('cleanup-pending.txt');
    const failing = new FileService(fixture.database, new FaultStorage(storage, 'commit'));
    const result = await failing.delete(file.id, owner());
    expect(result.cleanupPending).toBe(true);
    expect(await fixture.database.file.findUnique({ where: { id: file.id } })).toBeNull();
    await expect(service.content(file.fileName)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect((await filesOnDisk()).some((name) => name.startsWith(file.fileName + '.delete-'))).toBe(
      true,
    );
  });

  it('handles concurrent deletes consistently and never restores a deleted record', async () => {
    const file = await upload('concurrent.txt');
    const results = await Promise.allSettled([
      service.delete(file.id, owner()),
      service.delete(file.id, owner()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await fixture.database.file.findUnique({ where: { id: file.id } })).toBeNull();
    expect(await Bun.file(file.filePath).exists()).toBe(false);
  });

  it('bounds page results and retained heap over repeated queries of 2,000 records', async () => {
    await fixture.database.file.createMany({
      data: Array.from({ length: 2000 }, (_, index) => ({
        fileName: 'generated-' + index,
        originalName: 'generated.txt',
        mimeType: 'text/plain',
        filePath: 'not-created-fixture',
        fileSize: 9,
        userId: ownerId,
      })),
    });
    for (let index = 0; index < 10; index++) await service.list(1, 100);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let index = 0; index < 200; index++) {
      const result = await service.list((index % 20) + 1, 100);
      expect(result.data).toHaveLength(100);
      expect(result.pagination.total).toBeGreaterThanOrEqual(2000);
    }
    Bun.gc(true);
    const retained = process.memoryUsage().heapUsed - before;
    expect(retained).toBeLessThan(32 * 1024 * 1024);
    expect(performance.now() - started).toBeLessThan(15000);
    console.log('FileService load regression:', {
      records: 2000,
      queries: 200,
      retainedHeapBytes: retained,
      elapsedMs: Math.round(performance.now() - started),
    });
  });
});
