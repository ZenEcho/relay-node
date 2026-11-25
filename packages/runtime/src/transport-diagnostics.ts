const phases = new Set([
  'connect',
  'proxy_connect',
  'tls_handshake',
  'request_write',
  'response_headers',
  'response_body',
  'unknown',
  'complete',
]);
const reasons = new Set([
  'timeout',
  'dns',
  'connection_refused',
  'connection_reset',
  'connection_closed',
  'unexpected_eof',
  'certificate',
  'tls_alert',
  'protocol',
  'proxy_status',
  'proxy_auth',
  'unknown',
]);
export const nativeTransportErrorCodes = [
  'UPSTREAM_READ_FAILED',
  'UPSTREAM_RESPONSE_TOO_LARGE',
  'PROXY_FORBIDDEN',
  'PROXY_AUTH_REQUIRED',
  'PROXY_SOCKS_HTTP_RESPONSE',
  'PROXY_PROTOCOL_MISMATCH',
  'PROXY_CONNECT_FAILED',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_DNS_FAILED',
  'UPSTREAM_CONNECTION_FAILED',
  'UPSTREAM_CONNECTION_CLOSED',
  'UPSTREAM_TLS_FAILED',
  'UPSTREAM_TRANSPORT_FAILED',
  'NATIVE_TRANSPORT_FAILED',
  'NATIVE_TRANSPORT_TIMEOUT',
  'TRANSPORT_CLOSED',
  'TRANSPORT_NOT_READY',
  'TRANSPORT_BUDGET_EXHAUSTED',
] as const;
export type NativeTransportErrorCode = (typeof nativeTransportErrorCodes)[number];
const codes = new Set<string>(nativeTransportErrorCodes);
export function nativeTransportErrorCode(value: unknown): NativeTransportErrorCode {
  return typeof value === 'string' && codes.has(value)
    ? (value as NativeTransportErrorCode)
    : 'UPSTREAM_TRANSPORT_FAILED';
}
export type TransportDiagnostic = {
  phase: string;
  reason?: string;
  elapsedMs?: number;
  proxyConnectStatus?: number;
  requestWritten?: boolean;
  responseStarted?: boolean;
  connectionReused?: boolean;
  dialCompleted?: boolean;
};
const finiteMs = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000
    ? Math.round(value)
    : undefined;
/** Native helpers and error objects are not a free-form logging surface. */
export function transportDiagnostic(value: unknown): TransportDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const output: TransportDiagnostic = {
    phase: typeof input.phase === 'string' && phases.has(input.phase) ? input.phase : 'unknown',
  };
  if (typeof input.reason === 'string' && reasons.has(input.reason)) output.reason = input.reason;
  const elapsedMs = finiteMs(input.elapsedMs);
  if (elapsedMs !== undefined) output.elapsedMs = elapsedMs;
  if (
    Number.isInteger(input.proxyConnectStatus) &&
    Number(input.proxyConnectStatus) >= 100 &&
    Number(input.proxyConnectStatus) <= 599
  )
    output.proxyConnectStatus = Number(input.proxyConnectStatus);
  for (const key of ['requestWritten', 'responseStarted', 'connectionReused', 'dialCompleted'] as const)
    if (typeof input[key] === 'boolean') output[key] = input[key];
  return output;
}
export type TransportAttempt = {
  requestId: string;
  attemptId: string;
  attempt: number;
  method: 'GET' | 'POST';
  targetHost?: string;
  outcome: 'running' | 'retrying' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  elapsedMs: number;
  totalElapsedMs: number;
  errorCode?: NativeTransportErrorCode;
  diagnostic?: TransportDiagnostic;
  retryDelayMs?: number;
  retryStopReason?: string;
  httpStatus?: number;
};
const stopReasons = new Set([
  'not_safe_to_retry',
  'attempt_limit',
  'budget_exhausted',
  'closed',
  'connection_reset_failed',
]);
const outcomes = new Set(['running', 'retrying', 'succeeded', 'failed']);
const targetHosts = new Set([
  'chatgpt.com',
  'auth.openai.com',
  'api.stripe.com',
  'm.stripe.com',
  'r.stripe.com',
  'sentinel.openai.com',
  'www.cloudflare.com',
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isoDate = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export function transportTargetHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return targetHosts.has(host) ? host : undefined;
  } catch {
    return;
  }
}
export function transportAttempt(value: unknown): TransportAttempt | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (
    typeof input.requestId !== 'string' ||
    !uuid.test(input.requestId) ||
    typeof input.attemptId !== 'string' ||
    !uuid.test(input.attemptId) ||
    !Number.isInteger(input.attempt) ||
    Number(input.attempt) < 1 ||
    Number(input.attempt) > 3 ||
    (input.method !== 'GET' && input.method !== 'POST') ||
    typeof input.outcome !== 'string' ||
    !outcomes.has(input.outcome) ||
    typeof input.startedAt !== 'string' ||
    !isoDate.test(input.startedAt)
  )
    return;
  const output: TransportAttempt = {
    requestId: input.requestId,
    attemptId: input.attemptId,
    attempt: Number(input.attempt),
    method: input.method,
    outcome: input.outcome as TransportAttempt['outcome'],
    startedAt: input.startedAt,
    elapsedMs: finiteMs(input.elapsedMs) ?? 0,
    totalElapsedMs: finiteMs(input.totalElapsedMs) ?? 0,
  };
  if (typeof input.targetHost === 'string' && targetHosts.has(input.targetHost))
    output.targetHost = input.targetHost;
  if (typeof input.completedAt === 'string' && isoDate.test(input.completedAt))
    output.completedAt = input.completedAt;
  if (typeof input.errorCode === 'string' && codes.has(input.errorCode))
    output.errorCode = input.errorCode as NativeTransportErrorCode;
  const diagnostic = transportDiagnostic(input.diagnostic);
  if (diagnostic) output.diagnostic = diagnostic;
  const delay = finiteMs(input.retryDelayMs);
  if (delay !== undefined && delay <= 1500) output.retryDelayMs = delay;
  if (typeof input.retryStopReason === 'string' && stopReasons.has(input.retryStopReason))
    output.retryStopReason = input.retryStopReason;
  if (
    Number.isInteger(input.httpStatus) &&
    Number(input.httpStatus) >= 100 &&
    Number(input.httpStatus) <= 599
  )
    output.httpStatus = Number(input.httpStatus);
  return output;
}
export function transportAttempts(value: unknown): TransportAttempt[] | undefined {
  if (!Array.isArray(value)) return;
  return value
    .slice(0, 3)
    .map(transportAttempt)
    .filter((entry): entry is TransportAttempt => !!entry);
}
