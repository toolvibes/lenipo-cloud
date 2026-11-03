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
