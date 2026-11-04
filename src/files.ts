import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Backups and exports at rest (E-157): AES-256-GCM with a key derived from SECRET_KEY, so the files
 * can go to a second site as they are. Layout: "LCF1", 12 bytes IV, the ciphertext, 16 bytes tag.
 */
const MAGIC = Buffer.from('LCF1');
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + IV;

export function fileKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'lenipo-cloud', 'files v1', 32));
}

/** Encrypts `plain` into `sealed` and removes `plain`, also when that fails. */
export async function sealFile(plain: string, sealed: string, key: Buffer): Promise<void> {
  try {
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const out = createWriteStream(sealed);
    out.write(Buffer.concat([MAGIC, iv]));
    await pipeline(createReadStream(plain), cipher, out, { end: false });
    await new Promise<void>((resolve, reject) =>
      out.end(cipher.getAuthTag(), (error?: Error | null) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    await rm(sealed, { force: true });
    throw error;
  } finally {
    await rm(plain, { force: true });
  }
}

async function sealedParts(
  file: string,
): Promise<{ iv: Buffer; tag: Buffer; size: number } | null> {
  const { size } = await stat(file);
  if (size < HEADER + TAG) return null;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(HEADER);
    await handle.read(head, 0, HEADER, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const tag = Buffer.alloc(TAG);
    await handle.read(tag, 0, TAG, size - TAG);
    return { iv: head.subarray(MAGIC.length), tag, size };
  } finally {
    await handle.close();
  }
}

/**
 * The plain content of a file; files from before the encryption pass through as they are. A
 * tampered file fails at its end.
 */
export async function openFile(file: string, key: Buffer): Promise<Readable> {
  const parts = await sealedParts(file);
  if (!parts) return createReadStream(file);
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv);
  decipher.setAuthTag(parts.tag);
  const body = createReadStream(file, { start: HEADER, end: parts.size - TAG - 1 });
  body.on('error', (error) => decipher.destroy(error));
  return body.pipe(decipher);
}

/** Decrypts into `plain`, e.g. to hand a backup to an instance; checks the tag on the way. */
export async function unsealFile(file: string, plain: string, key: Buffer): Promise<void> {
  try {
    await pipeline(await openFile(file, key), createWriteStream(plain, { mode: 0o600 }));
  } catch (error) {
    await rm(plain, { force: true });
    throw error;
  }
}
