import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { extractSingleFile, packSingleFile } from './tar.js';

function tar(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  const data = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  data.write(content);
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

describe('tar', () => {
  it('streams the first file, also across chunks', async () => {
    const archive = tar('lenipo-export.zip', 'PK'.repeat(400));
    const chunks = [archive.subarray(0, 100), archive.subarray(100, 700), archive.subarray(700)];
    expect(await text(Readable.from(chunks).pipe(extractSingleFile()))).toBe('PK'.repeat(400));
  });

  it('packs one file the way it reads back', async () => {
    const content = Buffer.from('PK'.repeat(700));
    const chunks: Buffer[] = [];
    for await (const chunk of packSingleFile(
      'restore.zip',
      content.length,
      Readable.from([content.subarray(0, 10), content.subarray(10)]),
    )) {
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    expect(archive.length % 512).toBe(0);
    expect(archive.subarray(257, 262).toString()).toBe('ustar');
    expect(await text(Readable.from([archive]).pipe(extractSingleFile()))).toBe('PK'.repeat(700));
  });
});
