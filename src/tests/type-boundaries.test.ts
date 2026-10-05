import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import sharp from 'sharp';
import { getJwtSecret } from '../lib/jwt-config';
import prisma from '../lib/prisma';
import { MemoryRateLimitStore } from '../lib/rate-limit-store';
import { createSecureBackup, restoreSecureBackup } from '../lib/secure-backup';
import { createRateLimit } from '../middlewares/rate-limit';
import { filesRouter } from '../routes/files';

it('redacts backup passwords without mutating input records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cms-backup-test-'));
  const records = [{ id: 1, password: 'fixture-password', name: 'test' }];
  try {
    const path = join(directory, 'backup.json');
    await createSecureBackup(records, { encrypt: false, backupPath: path });
    const backup = await restoreSecureBackup(path);
    expect(backup.data).toEqual([{ id: 1, name: 'test' }]);
    expect(backup.metadata.recordCount).toBe(1);
    expect(records[0].password).toBe('fixture-password');
    await createSecureBackup(records, { encrypt: false, includePasswords: true, backupPath: path });
    expect((await restoreSecureBackup(path)).data).toEqual(records);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('adapts Fetch headers, preserves cookies and enforces per-client limits', async () => {
  const store = new MemoryRateLimitStore();
  const limited = createRateLimit({ windowMs: 60000, max: 1 }, store)
    .onRequest(({ set }) => {
      set.headers['set-cookie'] = ['a=1', 'b=2'];
    })
    .get('/', () => 'ok');
  const request = (ip: string) =>
    new Request('http://localhost/', { headers: { 'X-Real-IP': ip } });
  try {
    const first = await limited.handle(request('192.0.2.1'));
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(first.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect((await limited.handle(request('192.0.2.1'))).status).toBe(429);
    expect((await limited.handle(request('192.0.2.2'))).status).toBe(200);
  } finally {
    await store.destroy();
  }
});

it('resets the same rate-limit key from a Fetch request', async () => {
  const store = new MemoryRateLimitStore();
  const limited = createRateLimit({ windowMs: 60000, max: 1 }, store).get(
    '/',
    async ({ rateLimit }) => {
      await rateLimit.reset();
      return 'ok';
    },
  );
  try {
    for (let i = 0; i < 2; i++)
      expect((await limited.handle(new Request('http://localhost/'))).status).toBe(200);
  } finally {
    await store.destroy();
  }
});

describe('Fetch upload boundaries', () => {
  const app = new Elysia().use(filesRouter);
  let userId = 0;
  let token = '';
  const headers = () => ({ Authorization: 'Bearer ' + token });
  const upload = async (value: File | string | null, authorized = true): Promise<Response> => {
    const body = new FormData();
    if (value !== null) body.append('file', value);
    return app.handle(
      new Request('http://localhost/files/upload', {
        method: 'POST',
        headers: authorized ? headers() : {},
        body,
      }),
    );
  };
  const record = async (response: Response) => {
    expect(response.status).toBe(200);
    const data: { file: { id: number } } = await response.json();
    expect(Number.isSafeInteger(data.file.id)).toBe(true);
    return prisma.file.findUniqueOrThrow({ where: { id: data.file.id } });
  };
  beforeAll(async () => {
    await import('../scripts/prepare-db').then((m) => m.default('test'));
    const user = await prisma.user.create({
      data: {
        email: 'upload-boundary-' + Date.now() + '@example.com',
        password: 'unused-test-fixture',
      },
    });
    userId = user.id;
    token = await jwt({ secret: getJwtSecret() }).decorator.jwt.sign({
      userId,
      type: 'access',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  });
  afterAll(async () => {
    for (const file of await prisma.file.findMany({ where: { userId } })) {
      await unlink(file.filePath).catch(() => {});
      if (file.thumbnailPath)
        await unlink(join('uploads/thumbnails', basename(file.thumbnailPath))).catch(() => {});
    }
    await prisma.file.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });
  it('stores unique names and serves the original bytes', async () => {
    const first = await record(await upload(new File(['first'], '../same.txt')));
    const second = await record(await upload(new File(['second'], '../same.txt')));
    expect(first.fileName).not.toBe(second.fileName);
    expect(first.fileName).not.toContain('/');
    expect(first.originalName).toBe('../same.txt');
    expect(await Bun.file(first.filePath).text()).toBe('first');
    const response = await app.handle(
      new Request('http://localhost/files/content/' + first.fileName),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('first');
  });
  it('accepts exactly 10 MiB and rejects one byte more', async () => {
    const max = 10 * 1024 * 1024;
    expect((await record(await upload(new File([new Uint8Array(max)], 'max.txt')))).fileSize).toBe(
      max,
    );
    const count = await prisma.file.count({ where: { userId } });
    expect((await upload(new File([new Uint8Array(max + 1)], 'large.txt'))).status).toBe(413);
    expect(await prisma.file.count({ where: { userId } })).toBe(count);
  });
  it('rejects missing and non-file fields without weakening authentication', async () => {
    for (const value of [null, 'not-a-file']) {
      expect((await upload(value)).status).toBe(400);
      expect((await upload(value, false)).status).toBe(401);
    }
    expect((await upload(new File(['data'], 'test.txt'), false)).status).toBe(401);
  });
  it('cancels an oversized request before multipart parsing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await app.handle(
      new Request('http://localhost/files/upload', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'multipart/form-data; boundary=test' },
        body,
      }),
    );
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });
  it('rejects malformed multipart input', async () => {
    const response = await app.handle(
      new Request('http://localhost/files/upload', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'multipart/form-data; boundary=test' },
        body: 'invalid',
      }),
    );
    expect(response.status).toBe(400);
  });
  it('cleans the written file when persistence fails', async () => {
    const before = (await readdir('uploads')).sort();
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER test_upload_failure BEFORE INSERT ON File WHEN NEW.originalName = 'failure.txt' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    try {
      expect((await upload(new File(['failure'], 'failure.txt'))).status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_upload_failure');
    }
    expect((await readdir('uploads')).sort()).toEqual(before);
  });
  it('cleans files when image processing fails', async () => {
    const before = (await readdir('uploads')).sort();
    const count = await prisma.file.count({ where: { userId } });
    expect((await upload(new File(['invalid image'], 'invalid.png'))).status).toBe(500);
    expect((await readdir('uploads')).sort()).toEqual(before);
    expect(await prisma.file.count({ where: { userId } })).toBe(count);
  });
  it('serves thumbnails and removes both files on deletion', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const file = await record(await upload(new File([new Uint8Array(png)], 'image.png')));
    expect(file.thumbnailPath).toBeTruthy();
    const thumbnail = await app.handle(new Request('http://localhost/files' + file.thumbnailPath));
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toContain('image/jpeg');
    expect((await thumbnail.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const response = await app.handle(
      new Request('http://localhost/files/' + file.id, { method: 'DELETE', headers: headers() }),
    );
    expect(response.status).toBe(200);
    expect(await Bun.file(file.filePath).exists()).toBe(false);
    expect(
      await Bun.file(join('uploads/thumbnails', basename(file.thumbnailPath || ''))).exists(),
    ).toBe(false);
  });
});
