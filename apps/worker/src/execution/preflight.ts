import { observeEgress } from '../../../../packages/runtime/src/egress.js';
import { digest } from '../../../../packages/runtime/src/security.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
import { bindBillingEmail, selectBillingEmail } from '../../../../packages/rules/src/billing-email.js';
import { hasChatgptSessionCookie, verifySessionIdentity } from './credentials.js';
import { UpstreamError } from './http-utils.js';
import {
  tokenClaims,
  accessTokenRemainingSeconds,
  rejectedSessionRefresh,
} from './session-refresh.js';
import type { ExecutionServices } from './services.js';

const CHECKOUT_PATH = '/backend-api/payments/checkout';

// 建单前总是尝试刷新一次 Session：刷新成功就用刷新回来的会话（保证拿的是最新的
// accessToken 与轮换后的 Cookie），刷新失败就沿用提交过来的 Session，不在这里判
// 会话失效。真正无效的会话会在紧随其后的受保护请求（/backend-api/accounts/check
// → 建单）上以 401 报错，那时再失败也不迟。
async function refreshCheckoutSession(services: ExecutionServices) {
  const context = services.context;
  const submittedSession = context.session;
  const submittedAccount =
    context.accountId || submittedSession?.account?.id || submittedSession?.account?.account_id;
  const submittedUser = context.userId || submittedSession?.user?.id;
  const { iat } = tokenClaims(submittedSession?.accessToken || submittedSession?.access_token);
  const query = new URLSearchParams({
    refresh: 'true',
    reason: 'token_expired',
    method: 'POST',
    path: CHECKOUT_PATH,
  });

  const fallback = async (reason: string) => {
    // 只固定会话内容，Cookie 保留服务端最新状态：传输层的 Cookie 罐已经按
    // Set-Cookie 轮换过，回滚 context 里的数组只会和实际发出的 Cookie 脱节，
    // 反让重试拿到被轮换掉的旧登录票据。
    context.session = submittedSession;
    await services.log({
      name: 'Session 刷新未成功 · 沿用提交的 Session',
      status: 'succeeded',
      category: 'event',
      response: {
        reason,
        accessTokenRemainingSeconds: accessTokenRemainingSeconds(submittedSession),
        message: '强制刷新没有返回可用会话，继续使用提交过来的 Session；会话真的无效时由后续建单请求报错',
      },
    });
  };

  let session: any;
  try {
    session = await services.chat(
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
  } catch (error) {
    throwIfExecutionAborted(services.signal);
    await fallback(String((error as Error)?.message || '刷新请求失败').slice(0, 200));
    return;
  }
  throwIfExecutionAborted(services.signal);

  // 只有"拿到一枚未过期、且属于本单原账号的令牌"才算刷新成功。
  const rejected = rejectedSessionRefresh(session);
  const accessToken = session?.accessToken || session?.access_token;
  const accountId = session?.account?.id || session?.account?.account_id;
  const userId = session?.user?.id;
  const { exp } = tokenClaims(accessToken);
  const expires = typeof session?.expires === 'string' ? Date.parse(session.expires) : Number.NaN;
  let failure = '';
  if (rejected) failure = '令牌刷新被拒绝：' + rejected;
  else if (!accessToken) failure = '刷新响应缺少 accessToken';
  else if (typeof exp === 'number' && Number.isFinite(exp) && exp <= Date.now() / 1000)
    failure = '刷新返回的 accessToken 已过期';
  else if (Number.isFinite(expires) && expires <= Date.now()) failure = '刷新返回的 Session 已过期';
  else if ((submittedAccount && !accountId) || (submittedUser && !userId))
    failure = '刷新后的 Session 缺少原账号或用户标识';
  else {
    try {
      verifySessionIdentity({ ...context, accountId: submittedAccount, userId: submittedUser }, session);
    } catch (error) {
      failure = (error as Error)?.message || '刷新后的 Session 与原订单身份不一致';
    }
  }
  if (failure) {
    await fallback(failure);
    return;
  }
  context.session = { ...session, accessToken };
  context.accountId ||= accountId;
  context.userId ||= userId;
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
  const forceSessionRefresh =
    services.assignment.paymentEnabled &&
    !services.assignment.demo &&
    !services.context.checkout &&
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
