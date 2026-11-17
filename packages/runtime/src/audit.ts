import { randomUUID } from 'node:crypto';
import { cleanText } from './security.js';
import type { Step } from '../../contracts/src/execution.js';
import { transportDiagnostic, transportAttempts } from './transport-diagnostics.js';

// Audit payloads have explicit limits. Never silently drop an oversized response.
const sensitive =
  /authorization|cookie|secret|cvv|cvc|password|passwd|^pwd$|signature|nonce|token|(?:api|app|auth|access).?key|^neek$|^key$|credential|sessionjson|^session$|latestsession|sentinel|attestation|rqdata|responsekey|pageaccess|card.?number|\[number\]|^number$|(?:^|\[)pan\]?$|captcha.*url|cipher|keyhash|tokenhash|workerlease|verification.*access|^cdkcode$/i;
const secretParameter =
  /^(?:auth|authorization|access|access_token|session|session_token|token|api[_-]?key|key|secret|password|pass|signature|sig|client_secret|accessToken)$/i;

function safeUrl(value: string) {
  return value.replace(/(?:https?|socks5h?):\/\/[^\s"'<>]+/gi, (address) => {
    try {
      const url = new URL(address);
      let changed = false;
      if (url.username || url.password) {
        url.username = 'REDACTED';
        url.password = '';
        changed = true;
      }
      for (const key of [...url.searchParams.keys()])
        if (secretParameter.test(key) || sensitive.test(key)) {
          url.searchParams.set(key, '[REDACTED]');
          changed = true;
        }
      if (/access|token|secret|session/i.test(url.hash)) {
        url.hash = '[REDACTED]';
        changed = true;
      }
      // Preserve exact Origin/header values and benign query encoding.
      return changed ? url.href : address;
    } catch {
      return '[INVALID URL]';
    }
  });
}

export function auditRedact(value: unknown): any {
  const secrets = new Set<string>();
  const collect = (v: any, depth = 0) => {
    if (depth > 24 || !v) return;
    if (typeof v === 'string') {
      try {
        if (/^[\[{]/.test(v.trim())) collect(JSON.parse(v), depth + 1);
      } catch {}
      for (const match of v.matchAll(/(?:https?|socks5h?):\/\/[^\s"'<>]+/gi)) {
        try {
          const url = new URL(match[0]);
          for (const item of [url.username, url.password])
            if (item.length >= 4) secrets.add(decodeURIComponent(item));
          for (const [key, item] of url.searchParams)
            if ((secretParameter.test(key) || sensitive.test(key)) && item.length >= 4) secrets.add(item);
        } catch {}
      }
      return;
    }
    if (typeof v !== 'object') return;
    for (const [key, item] of Object.entries(v)) {
      if (sensitive.test(key) && typeof item === 'string' && item.length >= 4) {
        secrets.add(item);
        if (/^Bearer /i.test(item)) secrets.add(item.slice(7));
      } else collect(item, depth + 1);
    }
  };
  collect(value);
  let remaining = 240 * 1024;
  const visit = (v: any, depth = 0): any => {
    if (remaining <= 0) return '[TRUNCATED: audit record exceeds 240K characters]';
    if (depth > 24) return '[TRUNCATED: nesting exceeds 24]';
    if (typeof v === 'string') {
      try {
        if (/^[\[{]/.test(v.trim())) return visit(JSON.parse(v), depth + 1);
      } catch {}
      let text = safeUrl(v)
        .replace(/\boc_(?:live|test)_[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(
          /((?:secret|token|credential|session|cookie|authorization|api[_-]?key|cvv|cvc|password)["']?\s*[:=]\s*)["']?[^\s,;&"'<>]+/gi,
          '$1[REDACTED]',
        );
      for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
      text = cleanText(text, Infinity);
      const limit = Math.min(64 * 1024, remaining);
      remaining -= Math.min(text.length, limit);
      return text.length > limit
        ? text.slice(0, limit) + `\n[TRUNCATED: ${text.length} characters, kept ${limit}]`
        : text;
    }
    if (Array.isArray(v)) {
      const result = [];
      for (const item of v.slice(0, 1000)) {
        if (remaining <= 0) break;
        result.push(visit(item, depth + 1));
      }
      if (result.length < v.length) result.push(`[TRUNCATED: ${v.length - result.length} remaining items]`);
      return result;
    }
    if (v && typeof v === 'object') {
      const result: Record<string, any> = {};
      const entries = Object.entries(v);
      for (const [key, item] of entries.slice(0, 1000)) {
        if (remaining <= 0) {
          result._truncated = '[TRUNCATED: record size limit]';
          break;
        }
        remaining -= key.length;
        Object.defineProperty(result, key, {
          value: sensitive.test(key) ? '[REDACTED]' : visit(item, depth + 1),
          enumerable: true,
          configurable: true,
        });
      }
      if (entries.length > 1000) result._truncated = `[TRUNCATED: ${entries.length - 1000} remaining fields]`;
      return result;
    }
    remaining -= 16;
    return typeof v === 'bigint' ? v.toString() : v;
  };
  return visit(value);
}

export function auditError(error: unknown, depth = 0): any {
  if (depth > 4) return '[TRUNCATED: error cause depth]';
  const e = error as any;
  return auditRedact({
    name: e?.name || 'Error',
    message: e?.message || String(error),
    code: e?.code,
    status: e?.upstreamStatus || e?.status || e?.statusCode,
    retryAfterMs: e?.retryAfterMs,
    stack: e?.stack,
    errno: e?.errno,
    syscall: e?.syscall,
    hostname: e?.hostname,
    address: e?.address,
    port: e?.port,
    ...(e?.runtimeDiagnostic
      ? {
          runtimeDiagnostic: {
            component: e.runtimeDiagnostic.component === 'reference_bridge' ? 'reference_bridge' : undefined,
            reason: /^[A-Z_]{1,64}$/.test(e.runtimeDiagnostic.reason || '')
              ? e.runtimeDiagnostic.reason
              : undefined,
            retryable: e.runtimeDiagnostic.retryable === true,
          },
        }
      : {}),
    ...(e?.diagnostic ? { transportDiagnostic: transportDiagnostic(e.diagnostic) } : {}),
    ...(e?.transportAttempts ? { transportAttempts: transportAttempts(e.transportAttempts) } : {}),
    ...(e?.cause ? { cause: auditError(e.cause, depth + 1) } : {}),
  });
}

export function auditRequest(input: {
  url: string;
  headers?: Record<string, any>;
  body?: string;
  [key: string]: any;
}) {
  const type = Object.entries(input.headers || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  let body: any = input.body;
  if (body && String(type).includes('application/x-www-form-urlencoded')) {
    body = Object.create(null);
    for (const [key, value] of new URLSearchParams(input.body))
      body[key] = key in body ? [...(Array.isArray(body[key]) ? body[key] : [body[key]]), value] : value;
  } else if (body) {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  const query: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of new URL(input.url).searchParams)
    query[key] = key in query ? [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value] : value;
  return { ...input, ...(Object.keys(query).length ? { query } : {}), body };
}

export type AuditEntry = Omit<Step, 'id' | 'runId' | 'at'>;
export type AuditSink = (entry: AuditEntry) => Promise<void>;
export async function trace<T>(
  sink: AuditSink | undefined,
  name: string,
  request: unknown,
  action: (capture: (response: unknown, httpStatus?: number) => void) => Promise<T>,
  category: Step['category'] = 'operation',
): Promise<T> {
  if (!sink) return action(() => {});
  const start = Date.now();
  const base = {
    traceId: randomUUID(),
    name,
    category,
    request,
    startedAt: new Date(start).toISOString(),
  };
  await sink(
    auditRedact({
      ...base,
      status: 'running',
      response: { received: false, reason: '等待响应；进程中断时结果可能未知' },
    }),
  );
  let response: unknown = { received: false, reason: '未收到响应' },
    httpStatus: number | undefined;
  try {
    const result = await action((value, status) => {
      response = value;
      httpStatus = status;
    });
    await sink(
      auditRedact({
        ...base,
        status: httpStatus && (httpStatus < 200 || httpStatus >= 300) ? 'failed' : 'succeeded',
        response,
        httpStatus,
        durationMs: Date.now() - start,
        completedAt: new Date().toISOString(),
      }),
    );
    return result;
  } catch (error) {
    const partial = (error as any)?.httpResponse;
    if (partial?.status) {
      response = partial;
      httpStatus = partial.status;
    }
    await sink(
      auditRedact({
        ...base,
        status: 'failed',
        response,
        httpStatus,
        durationMs: Date.now() - start,
        completedAt: new Date().toISOString(),
        error: (error as Error)?.message || String(error),
        errorDetail: auditError(error),
      }),
    );
    throw error;
  }
}
