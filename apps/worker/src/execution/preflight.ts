import { observeEgress } from '../../../../packages/runtime/src/egress.js';
import { digest } from '../../../../packages/runtime/src/security.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
import { bindBillingEmail, selectBillingEmail } from '../../../../packages/rules/src/billing-email.js';
import { hasChatgptSessionCookie, verifySessionIdentity } from './credentials.js';
import { UpstreamError } from './http-utils.js';
import {
  tokenClaims,
  accessTokenRemainingSeconds,
  hasUsableAccessToken,
  rejectedSessionRefresh,
  sessionRefreshFailure,
  SESSION_REFRESH_SKEW_SECONDS,
} from './session-refresh.js';
import type { ExecutionServices } from './services.js';

const CHECKOUT_PATH = '/backend-api/payments/checkout';

async function refreshCheckoutSession(services: ExecutionServices) {
  const context = services.context;
  const originalCookies = context.environment.cookies;
  const originalAccount =
    context.accountId || context.session?.account?.id || context.session?.account?.account_id;
  const originalUser = context.userId || context.session?.user?.id;
  const { iat } = tokenClaims(context.session?.accessToken || context.session?.access_token);
  const query = new URLSearchParams({
    refresh: 'true',
    reason: 'token_expired',
    method: 'POST',
    path: CHECKOUT_PATH,
  });
  try {
    throwIfExecutionAborted(services.signal);
    const session = await services.chat(
      '建单前强制刷新 Session',
      '/api/auth/session?' + query,
      undefined,
      {
        'cache-control': 'no-cache',
        ...(typeof iat === 'number' && Number.isFinite(iat)
          ? { 'x-openai-failed-access-token-iat': String(iat) }
          : {}),
      },
    );
    throwIfExecutionAborted(services.signal);
    // A 200 with a rejected refresh still carries the previous access token.
    // 刷新被拒只说明这次没能换到新令牌（refresh token 已被其它使用方换走，
    // 或服务端不接受这次 refresh 请求），不等于 Session 失效：同一份 Cookie
    // 在浏览器里照常可用。只有连一枚未过期的 accessToken 都拿不到时才终止。
    const rejected = rejectedSessionRefresh(session);
    if (rejected && !hasUsableAccessToken(session)) {
      await services.log({
        name: '账号 Session 无法刷新',
        status: 'failed',
        category: 'event',
        response: {
          error: rejected,
          accessTokenRemainingSeconds: accessTokenRemainingSeconds(session),
          message: '登录令牌刷新被拒绝，且没有返回可用的 accessToken，账号需要重新登录后才能继续本单',
        },
        error: 'Session 刷新失败：' + rejected,
      });
      throw sessionRefreshFailure(rejected);
    }
    if (rejected)
      await services.log({
        name: 'Session 刷新被拒 · 沿用当前 accessToken',
        status: 'succeeded',
        category: 'event',
        response: {
          error: rejected,
          accessTokenRemainingSeconds: accessTokenRemainingSeconds(session),
          message: '刷新令牌未能更换，当前 accessToken 仍然有效，继续使用原登录会话',
        },
      });
    const accessToken = session?.accessToken || session?.access_token;
    const accountId = session?.account?.id || session?.account?.account_id;
    const userId = session?.user?.id;
    verifySessionIdentity(
      { ...context, accountId: originalAccount || accountId, userId: originalUser },
      session,
    );
    if ((originalAccount && !accountId) || (originalUser && !userId))
      throw new Error('刷新后的 Session 缺少原账号或用户标识，无法确认本单登录身份');
    const { exp } = tokenClaims(accessToken);
    const now = Date.now();
    if (
      (session.expires && !(Date.parse(session.expires) > now)) ||
      (typeof exp === 'number' && exp <= now / 1000)
    )
      throw new Error('刷新后的 Session 或 accessToken 已过期');
    context.session = { ...session, accessToken };
    context.accountId ||= accountId;
    context.userId ||= userId;
  } catch (error) {
    context.environment.cookies = originalCookies;
    throw error;
  }
}

export async function sampleExecutionEgress(services: ExecutionServices, required = false) {
  const { context, assignment } = services;
  const { environment } = context;
  const proxied = environment.networkMode === 'proxy' || !!environment.proxyUrl;
  const simulated = assignment.demo === true;
  const request = {
    environmentId: environment.id,
    profile: environment.profile,
    executionMode: assignment.mode,
    requestedCountry: environment.country,
    networkMode: proxied ? 'proxy' : 'direct',
  };
  delete context.exitProbe;
  let result: Awaited<ReturnType<typeof observeEgress>>;
  const asProbe = (call: (input: any) => Promise<any>) => async (input: any) => {
    try {
      return await call(input);
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      return { status: error.status, data: error.data, body: '' };
    }
  };
  try {
    // The two traces race on separate transports so a blocked endpoint cannot
    // add its timeout to the order; the first confirmed exit wins.
    result = await observeEgress(
      asProbe((input) =>
        services.request(proxied ? '检查本单代理出口' : '检查执行节点本机出口', input),
      ),
      services.probeRequest ? asProbe((input) => services.probeRequest!(input)) : undefined,
    );
  } catch (error) {
    throwIfExecutionAborted(services.signal);
    const failure = error as { code?: string; name?: string };
    if (failure?.code === 'EXECUTION_ABORTED' || failure?.name === 'AbortError') throw error;
    await services.log({
      name: '记录本单网络出口',
      status: 'failed',
      category: 'event',
      request,
      response: { observed: false, checkedAt: new Date().toISOString(), simulated },
      error: '无法确认本次执行的网络出口',
    });
    if (required) throw error;
    return;
  }
  const previousFingerprint = context.exitFingerprint;
  context.exitIp = result.ip;
  context.exitCountry = result.country;
  context.exitFingerprint = digest(result.ip).slice(0, 12);
  context.exitProbe = { observedAt: new Date().toISOString(), source: result.source, simulated };
  const verified = !proxied || result.country === environment.country;
  if (required) context.proxyVerified = verified;
  await services.log({
    name: '记录本单网络出口',
    status: verified ? 'succeeded' : 'failed',
    category: 'event',
    request,
    response: {
      ...context.exitProbe,
      observed: true,
      exitFingerprint: context.exitFingerprint,
      country: result.country,
      requestedCountry: environment.country,
      verified,
      networkMode: request.networkMode,
      ...(previousFingerprint !== undefined
        ? { exitChanged: previousFingerprint !== context.exitFingerprint }
        : {}),
    },
  });
  if (required && !verified)
    throw Object.assign(
      new Error(
        `代理出口国家与订单地区不匹配：期望 ${environment.country}，实际 ${result.country}`,
      ),
      { code: 'PROXY_COUNTRY_MISMATCH' },
    );
}

export async function preflightExecution(services: ExecutionServices) {
  // Once the original environment is verified, subsequent samples are diagnostic.
  const required = !services.context.proxyVerified;
  if (required) services.setStage('proxy_check');
  await sampleExecutionEgress(services, required);
  // 只在 accessToken 真的快过期（或没有）时才强制续期。refresh token 是一次性
  // 的，把大量还有效的会话拿去强制刷新，会把账号唯一的 refresh token 烧掉，
  // 之后同一份 Session 的其它使用方（浏览器/插件/下次执行）就都刷不动了。
  const remainingSeconds = accessTokenRemainingSeconds(services.context.session);
  const tokenNeedsRefresh =
    typeof remainingSeconds !== 'number' || remainingSeconds <= SESSION_REFRESH_SKEW_SECONDS;
  const forceSessionRefresh =
    services.assignment.paymentEnabled &&
    !services.assignment.demo &&
    !services.context.checkout &&
    tokenNeedsRefresh &&
    hasChatgptSessionCookie(services.context.environment.cookies);
  if (forceSessionRefresh) {
    // A forced refresh is an account check; attribute its failure there.
    services.setStage('subscription_check');
    await refreshCheckoutSession(services);
  } else if (
    !services.context.session?.accessToken ||
    (!services.context.billingEmailBinding &&
      selectBillingEmail('chatgpt', services.context.session).source !== 'session')
  ) {
    const refreshed = await services.chat('读取登录 Session', '/api/auth/session');
    verifySessionIdentity(services.context, refreshed);
    services.context.session = refreshed;
  }
  services.context.billing ||= services.assignment.billing ? { ...services.assignment.billing } : null;
  if (!services.context.billingEmailBinding) {
    const binding = bindBillingEmail(services.context, 'chatgpt', services.context.billing?.email);
    // This one-time checkpoint lets the controller validate the Session
    // identity and lock the selected email before merchant or Stripe writes.
    await services.checkpoint('billing_email_ready');
    if (binding.source !== 'session')
      await services.log({
        name: '确认本单账单邮箱',
        status: 'succeeded',
        category: 'event',
        response: {
          source: binding.source,
          message: binding.email
            ? 'Session 未返回有效邮箱，使用已配置的默认邮箱。'
            : 'Session 未返回有效邮箱且未设置默认邮箱，本单保留空邮箱。',
        },
      });
  } else bindBillingEmail(services.context, 'chatgpt');
  services.assignment.billing = services.context.billing || undefined;
  if (forceSessionRefresh || !services.context.originalSubscription) {
    services.setStage('subscription_check');
    const info = await services.chat(
      '查询原账号订阅',
      '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
    );
    const accounts = Object.values(info.accounts || {}) as any[];
    const selected = services.context.accountId
      ? accounts.find((a) => (a.account?.account_id || a.account?.id) === services.context.accountId)
      : info.accounts?.default || accounts[0];
    const accountId = selected?.account?.account_id || selected?.account?.id;
    if (!accountId) throw new Error('订阅查询未返回原账号');
    if (services.context.accountId && services.context.accountId !== accountId)
      throw new Error('订阅账号与原凭证不一致');
    if (forceSessionRefresh)
      verifySessionIdentity(services.context, {
        accessToken: services.context.session?.accessToken,
        account: selected.account,
        user: info.user,
      });
    services.context.accountId = accountId;
    services.context.userId ||= info.user?.id;
    services.context.originalSubscription = selected.entitlement || {};
  }
  if (services.context.originalSubscription?.has_active_subscription)
    throw new Error('账号已有有效订阅，请先核对套餐，执行器未发起新付款');
  await services.checkpoint('subscription_ready');
}
