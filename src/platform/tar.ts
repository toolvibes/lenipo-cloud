import { Transform, type TransformCallback } from 'node:stream';

/**
 * Streams the content of the first file in a tar archive, as the Docker API returns a file of a
 * container: a 512-byte header with the size (octal at offset 124), then the data.
 */
export function extractSingleFile(): Transform {
  let header = Buffer.alloc(0);
  let remaining: number | null = null;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      let data = chunk;
      if (remaining === null) {
        header = Buffer.concat([header, data]);
        if (header.length < 512) return callback();
        const size = Number.parseInt(
          header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(),
          8,
        );
        if (!Number.isFinite(size)) return callback(new Error('Not a tar archive'));
        remaining = size;
        data = header.subarray(512);
      }
      if (remaining > 0 && data.length > 0) {
        const part = data.subarray(0, remaining);
        remaining -= part.length;
        this.push(part);
      }
      callback();
    },
    flush(callback) {
      callback(remaining === 0 ? undefined : new Error('The tar archive ended early'));
    },
  });
}

/** One block of a tar header: name, mode, size, mtime, checksum, type and ustar magic. */
function header(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number) =>
    block.write(value.padEnd(length, '\0').slice(0, length), offset, 'ascii');
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, '0')}\0`;
  field(name, 0, 100);
  field(octal(0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(Math.floor(mtime / 1000), 12), 136, 12);
  field(' '.repeat(8), 148, 8);
  field('0', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/**
 * A tar archive with one file, as the Docker API takes files into a container: the header, the
 * data streamed from `content`, padding to 512 bytes and the two empty end blocks.
 */
export async function* packSingleFile(
  name: string,
  size: number,
  content: AsyncIterable<Buffer>,
  mtime = Date.now(),
): AsyncGenerator<Buffer> {
  yield header(name, size, mtime);
  let written = 0;
  for await (const chunk of content) {
    written += chunk.length;
    yield chunk;
  }
  if (written !== size) throw new Error(`Expected ${size} bytes, got ${written}`);
  const padding = (512 - (size % 512)) % 512;
  yield Buffer.alloc(padding + 1024);
}
