import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
import { hasChatgptSessionCookie, verifySessionIdentity } from './credentials.js';
import type { ExecutionServices } from './services.js';

export function isExpiredAccessToken(error: unknown): boolean {
  const value = error as {
    status?: number;
    code?: string;
    message?: string;
    data?: any;
  } | null;
  if (value?.status !== 401) return false;
  return (
    [value.code, value.data?.error?.code, value.data?.detail?.code].includes('token_expired') ||
    /\btoken_expired\b|\b(?:access|oauth|authentication)\s+token\s+(?:has\s+|is\s+)?expired\b/i.test(
      value.message || '',
    )
  );
}

export function tokenClaims(token: unknown): { iat?: number; exp?: number } {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()) || {};
  } catch {
    return {};
  }
}

export async function refreshExpiredAccessToken(
  context: RuntimeContext,
  chat: ExecutionServices['chat'],
  path: string,
  signal?: AbortSignal,
) {
  throwIfExecutionAborted(signal);
  const previousSession = context.session;
  const previousAccount = context.accountId;
  const accountId = previousAccount || previousSession?.account?.id || previousSession?.account?.account_id;
  const userId = context.userId || previousSession?.user?.id;
  const identity = { ...context, accountId, userId };
  const cookies = context.environment.cookies.map((cookie) => ({ ...cookie }));
  if (!accountId) throw new Error('accessToken 已过期，缺少原账号身份，不能自动刷新后重试');
  if (!hasChatgptSessionCookie(cookies))
    throw new Error('accessToken 已过期，缺少用于刷新的 Session Cookie，请重新获取完整 Session');
  try {
    context.accountId = accountId;
    const initial = await chat('读取登录 Session', '/api/auth/session', undefined, {
      'cache-control': 'no-cache',
    }).catch(() => {
      throwIfExecutionAborted(signal);
      return previousSession;
    });
    throwIfExecutionAborted(signal);
    if (initial?.accessToken || initial?.access_token) verifySessionIdentity(identity, initial);
    const iat = tokenClaims(previousSession?.accessToken).iat ?? tokenClaims(initial?.accessToken).iat;
    const query = new URLSearchParams({
      refresh: 'true',
      reason: 'token_expired',
      method: 'GET',
      path,
    });
    const refreshed = await chat('刷新过期 accessToken', '/api/auth/session?' + query, undefined, {
      'cache-control': 'no-cache',
      ...(typeof iat === 'number' && Number.isFinite(iat)
        ? { 'x-openai-failed-access-token-iat': String(iat) }
        : {}),
    });
    throwIfExecutionAborted(signal);
    verifySessionIdentity(identity, refreshed);
    const token = refreshed.accessToken || refreshed.access_token;
    const expiry = tokenClaims(token).exp;
    if (token === previousSession?.accessToken || (typeof expiry === 'number' && expiry <= Date.now() / 1000))
      throw new Error('accessToken 已过期，Session 刷新未返回新的有效访问令牌');
    if (refreshed.expires && !(Date.parse(refreshed.expires) > Date.now()))
      throw new Error('刷新响应的有效期无效，未重试原请求');
    const nextSession = { ...refreshed, accessToken: token };
    context.session = nextSession;
    const info = await chat(
      '核验刷新后的原账号',
      '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
    );
    throwIfExecutionAborted(signal);
    const accounts = Object.values(info?.accounts || {}) as any[];
    const selected = accounts.find((entry) => (entry.account?.account_id || entry.account?.id) === accountId);
    if (!selected) throw new Error('刷新后的认证无法读取原账号，未重试原请求');
    verifySessionIdentity(identity, {
      accessToken: token,
      account: selected.account,
      user: info.user,
    });
    if (userId && !nextSession.user?.id && !info.user?.id)
      throw new Error('刷新后的认证无法核验原用户，未重试原请求');
    // Keep the accepted account/user binding and rotated cookie set together.
    context.userId = userId || nextSession.user?.id || info.user?.id;
  } catch (error) {
    context.session = previousSession;
    context.accountId = previousAccount;
    context.environment.cookies = cookies;
    throw error;
  }
}
