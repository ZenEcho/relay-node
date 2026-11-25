import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
import { hasChatgptSessionCookie, verifySessionIdentity } from './credentials.js';
import type { ExecutionServices } from './services.js';

// NextAuth reports a rejected refresh as HTTP 200 with an `error` field while
// it still returns the previous access token. A rejected refresh token is
// terminal: OpenAI revokes the token family, so the next protected write ends
// with token_revoked and only a new login can recover the account.
export const sessionRevokedMessage = 'Session 已失效，请重新登录并获取新的 Session。';

export function rejectedSessionRefresh(session: unknown): string | undefined {
  const value = (session as { error?: unknown } | null)?.error;
  return typeof value === 'string' && value ? value : undefined;
}

export function sessionRefreshFailure(reason?: unknown) {
  const detail = typeof reason === 'string' && reason ? reason : 'RefreshAccessTokenError';
  return Object.assign(new Error(sessionRevokedMessage + '（令牌刷新失败：' + detail + '）'), {
    code: 'SESSION_REVOKED',
  });
}

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

// Refresh tokens are single use: 每刷新一次，旧 refresh token 就被换掉。所以只有
// accessToken 真的快过期时才主动续期，否则白白消耗掉账号唯一的 refresh token，
// 让同一份 Session 的其它使用方（浏览器、插件、下次执行）都刷不动。
export const SESSION_REFRESH_SKEW_SECONDS = 15 * 60;

function sessionAccessToken(session: unknown): string | undefined {
  const value = session as Record<string, unknown> | null | undefined;
  const token = value?.['accessToken'] ?? value?.['access_token'];
  return typeof token === 'string' && token ? token : undefined;
}

export function accessTokenRemainingSeconds(session: unknown, now = Date.now()): number | undefined {
  const { exp } = tokenClaims(sessionAccessToken(session));
  return typeof exp === 'number' && Number.isFinite(exp) ? exp - Math.floor(now / 1000) : undefined;
}

export function hasUsableAccessToken(
  session: unknown,
  skewSeconds = 60,
  now = Date.now(),
): boolean {
  if (!sessionAccessToken(session)) return false;
  const remaining = accessTokenRemainingSeconds(session, now);
  return typeof remaining === 'number' && remaining > skewSeconds;
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
    // 刷新被拒也可能是"这枚 refresh token 已被别的使用方换过"，而不是账号被吊销。
    // 只要返回的 accessToken 本身还能用，就继续用当前令牌，让真正的受保护请求
    // 去证明它是否失效；只有连可用令牌都拿不到时才是真的需要重新登录。
    const rejected = rejectedSessionRefresh(refreshed);
    if (rejected && !hasUsableAccessToken(refreshed)) throw sessionRefreshFailure(rejected);
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
