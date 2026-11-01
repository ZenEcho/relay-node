import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { errorMessage } from './errors.js';
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
const privateKey =
  /authorization|cookie|secret|cvv|cvc|password|signature|nonce|access.?token|session.?token|api.?key|^key$|^token$|^credential$|sessionjson|^session$|sentinel|attestation|client.?secret|confirm.*token|rqdata|responsekey|pageaccess|card.?number|^number$|captcha.*url|cipher|keyhash|tokenhash|claimtoken|workerlease|verification.*access/i;
export function cleanText(value: string, maxLength = 12000): string {
  return value
    .replace(/\bctoken_[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g, '[REDACTED]')
    .replace(
      /((?:access|session)[_-]?token|api[_-]?key|cvv|cvc|password|client_secret)\s*[:=]\s*[^\s,;&]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|pk|pi)_(?:live|test|[A-Za-z0-9]+)_?[A-Za-z0-9_]*secret[A-Za-z0-9_]*/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[CARD]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/([?#&](?:access|token|client_secret|key)=)[^\s&#]+/gi, '$1[REDACTED]')
    .slice(0, maxLength);
}
export function redact(value: unknown, depth = 0): any {
  if (depth > 10) return '[TRUNCATED]';
  if (typeof value === 'string') {
    try {
      if (/^[\[{]/.test(value.trim())) return redact(JSON.parse(value), depth + 1);
    } catch {}
    return cleanText(value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((x) => redact(x, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [k, privateKey.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
    );
  return value;
}
export function equalHash(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export class AppError extends Error {
  retryAfterMs?: number;
  constructor(
    public statusCode: number,
    message: unknown,
    public code = 'ERROR',
  ) {
    super(errorMessage(message));
  }
}
export function assert(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new AppError(status, message);
}
