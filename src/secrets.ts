import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A random secret for links, sessions and passwords: URL-safe, 256 bits. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** AES-256-GCM with a key derived from SECRET_KEY: iv.tag.ciphertext in base64url. */
export function encrypt(key: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function decrypt<T>(key: string, sealed: string): T {
  const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !data) throw new Error('Malformed secret');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
}
