import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { App } from '../src/index';
import app from '../src/index';
import prisma from '../src/lib/prisma';

describe('Files Routes', () => {
  let server: ReturnType<App['listen']>;
  const testEmail = `test-files-${Date.now()}@example.com`;
  const testPassword = 'password123';
  const testName = 'Files Test User';
  let userId: number;
  const testUploadDir = './test-uploads';
  const testThumbsDir = './test-uploads/thumbnails';

  beforeAll(async () => {
    try {
      // テスト用にディレクトリを作成
      await mkdir(testUploadDir, { recursive: true });
      await mkdir(testThumbsDir, { recursive: true });

      // テスト用のファイルを作成
      const testFilePath = join(testUploadDir, 'test-file.txt');
      await writeFile(testFilePath, 'This is a test file');

      // テスト用にサーバーを起動
      server = app.listen(0);

      // テストユーザーを作成
      const user = await prisma.user.create({
        data: {
          email: testEmail,
          password: testPassword,
          name: testName,
          role: 'user',
        },
      });

      userId = user.id;

      // テスト用のファイルレコードをDBに作成
      await prisma.file.create({
        data: {
          id: 9999,
          fileName: 'test-file.txt',
          originalName: 'test-file.txt',
          mimeType: 'text/plain',
          filePath: testFilePath,
          fileSize: 19, // "This is a test file" の長さ
          userId: userId,
        },
      });
    } catch (error) {
      console.error('Error during test setup:', error);
    }
  });

  afterAll(async () => {
    try {
      // テスト用ファイルを削除
      await prisma.file.deleteMany({
        where: { userId },
      });

      // テストユーザーを削除
      await prisma.user.delete({
        where: { id: userId },
      });

      // テスト用ディレクトリを削除
      await rm(testUploadDir, { recursive: true, force: true });

      // サーバーを停止
      server.stop();

      // Prismaの接続をクローズ
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error cleaning up after tests:', error);
    }
  });

  // ファイル一覧APIの存在確認テスト
  it('should have files list endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/api/files'));

    // ステータスコードが200(成功)または401(認証エラー)のいずれかであることを確認
    expect([200, 401]).toContain(response.status);
  });

  // 存在しないファイルへのリクエストテスト
  it('should handle non-existent file requests', async () => {
    const response = await app.handle(new Request('http://localhost/api/files/99999'));

    // ステータスコードが404(Not Found)または401(認証エラー)のいずれかであることを確認
    expect([404, 401]).toContain(response.status);
  });

  // ファイルアップロードエンドポイントの存在確認テスト
  it('should have file upload endpoint', async () => {
    const formData = new FormData();

    const response = await app.handle(
      new Request('http://localhost/api/files/upload', {
        method: 'POST',
        body: formData,
      }),
    );

    // ステータスコードが400, 401, 500のいずれかであることを確認
    // (認証エラー、ファイル不足エラー、または内部エラー)
    expect([400, 401, 500]).toContain(response.status);
  });
});
