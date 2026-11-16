import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
export { AppError, assert } from '../../rules/src/errors.js';
export { cleanText, redact } from '../../rules/src/privacy.js';
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class Vault {
  private key: Buffer;
  constructor(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('ENCRYPTION_KEY 必须是 32 字节十六进制密钥');
    this.key = Buffer.from(key, 'hex');
  }
  seal(value: unknown): string {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), bytes].map((x) => x.toString('base64url')).join('.');
  }
  open<T>(value: string): T {
    const [iv, tag, bytes] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(bytes), d.final()]).toString('utf8'));
  }
}
export function equalHash(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
