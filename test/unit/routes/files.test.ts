import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { join } from 'path';
import { Elysia } from 'elysia';
import { filesRouter } from '../../../src/routes/files';
import { generateTestToken } from '../../helpers';

// ファイル操作のモック
const mockWrite = mock(() => Promise.resolve());
const mockMkdir = mock(() => Promise.resolve());
const mockUnlink = mock(() => Promise.resolve());

// Sharpのモック
const mockResize = mock(() => ({ toFile: mockToFile }));
const mockToFile = mock(() => Promise.resolve());
const mockSharp = mock(() => ({ resize: mockResize }));

// Prismaクライアントのモック
const mockPrisma = {
  file: {
    create: mock((data) => {
      return {
        id: 1,
        ...data.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }),
    findMany: mock(() => {
      return [
        {
          id: 1,
          fileName: 'test-file.jpg',
          originalName: 'original.jpg',
          mimeType: 'image/jpeg',
          filePath: '/files/test-file.jpg',
          thumbnailPath: '/thumbnails/test-file.jpg',
          fileSize: 1024,
          userId: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
    }),
    count: mock(() => 1),
    findUnique: mock((query) => {
      if (query.where.id === 1) {
        return {
          id: 1,
          fileName: 'test-file.jpg',
          originalName: 'original.jpg',
          mimeType: 'image/jpeg',
          filePath: '/files/test-file.jpg',
          thumbnailPath: '/thumbnails/test-file.jpg',
          fileSize: 1024,
          userId: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      return null;
    }),
    delete: mock(() => Promise.resolve()),
  },
};

// Bunのモック
global.Bun = {
  ...global.Bun,
  write: mockWrite,
  file: mock(() => ({
    size: 1024,
    type: 'image/jpeg',
  })),
};

// 各種モジュールのモック
mock.module('fs/promises', () => ({
  mkdir: mockMkdir,
  unlink: mockUnlink,
}));

mock.module('sharp', () => mockSharp);

mock.module('../../../src/lib/prisma', () => {
  return { default: mockPrisma };
});

describe('Files Router', () => {
  let app: Elysia;
  let adminToken: string;
  let regularToken: string;

  beforeAll(async () => {
    // テスト用のトークン生成
    adminToken = await generateTestToken(1, 'admin');
    regularToken = await generateTestToken(2, 'user');

    // ファイルルーターをセットアップ
    app = new Elysia().use(filesRouter);
  });

  describe('GET /files', () => {
    it('should return a list of files', async () => {
      const response = await app.handle(new Request('http://localhost/files'));

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.pagination).toBeDefined();
    });
  });

  describe('GET /files/:id', () => {
    it('should return a specific file', async () => {
      const response = await app.handle(new Request('http://localhost/files/1'));

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(1);
    });

    it('should return 404 for non-existent file', async () => {
      const response = await app.handle(new Request('http://localhost/files/999'));

      const body = await response.json();
      expect(response.status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  describe('DELETE /files/:id', () => {
    it('should require authentication', async () => {
      const response = await app.handle(
        new Request('http://localhost/files/1', { method: 'DELETE' }),
      );

      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
    });

    it('should allow deletion with valid token', async () => {
      const response = await app.handle(
        new Request('http://localhost/files/1', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });
});
