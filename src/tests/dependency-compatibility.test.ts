import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromFile } from '@prisma/config';
import { Elysia, t } from 'elysia';

describe('Patched dependency compatibility', () => {
  it('loads nested Prisma configuration through the patched merger', async (): Promise<void> => {
    const directory: string = await mkdtemp(join(tmpdir(), 'cms-prisma-config-'));
    const configFile: string = join(directory, 'prisma.config.ts');
    try {
      await writeFile(
        configFile,
        `export default {
          schema: './schema.prisma',
          migrations: { path: './migrations', seed: 'bun run seed' },
          engine: 'classic',
          datasource: { url: 'file:./test.db' }
        };`,
      );

      const result: Awaited<ReturnType<typeof loadConfigFromFile>> = await loadConfigFromFile({
        configFile,
        configRoot: directory,
      });

      expect(result.error).toBeUndefined();
      expect(result.resolvedPath).toBe(configFile);
      expect(result.config?.schema).toBe(join(directory, 'schema.prisma'));
      expect(result.config?.migrations).toEqual({
        path: join(directory, 'migrations'),
        seed: 'bun run seed',
      });
      expect(result.config?.engine).toBe('classic');
      if (result.config?.engine === 'classic') {
        expect(result.config.datasource.url).toBe('file:./test.db');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const app: { handle(request: Request): Promise<Response> } = new Elysia().post(
    '/upload',
    () => 'accepted',
    {
      body: t.Object({ image: t.File({ type: 'image/png' }) }),
    },
  );

  it('accepts a PNG using the patched Elysia file-type peer', async (): Promise<void> => {
    const png: Buffer<ArrayBuffer> = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ZkAAAAASUVORK5CYII=',
      'base64',
    );
    const body: FormData = new FormData();
    body.set('image', new File([png], 'image.png', { type: 'image/png' }));

    const response: Response = await app.handle(
      new Request('http://localhost/upload', { method: 'POST', body }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('accepted');
  });

  it('rejects a forged PNG MIME type', async (): Promise<void> => {
    const body: FormData = new FormData();
    body.set('image', new File(['not a PNG image'], 'image.png', { type: 'image/png' }));

    const response: Response = await app.handle(
      new Request('http://localhost/upload', { method: 'POST', body }),
    );

    expect(response.status).toBe(422);
  });
});
