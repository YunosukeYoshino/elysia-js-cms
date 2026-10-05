import { expect, it } from 'bun:test';
import sharp from 'sharp';

for (const format of ['png', 'jpeg', 'webp', 'avif'] as const) {
  it(`decodes and resizes native ${format} images`, async () => {
    const input: Buffer = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 4,
        background: { r: 120, g: 80, b: 30, alpha: 1 },
      },
    })
      .toFormat(format)
      .toBuffer();
    const output: Buffer = await sharp(input).resize(16, 12).png().toBuffer();
    expect(await sharp(output).metadata()).toMatchObject({ width: 16, height: 12, format: 'png' });
    await expect(sharp(input.subarray(0, 8)).resize(16, 12).toBuffer()).rejects.toThrow();
  });
}
