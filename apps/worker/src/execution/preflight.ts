import { observeEgress } from '../../../../packages/runtime/src/egress.js';
import { digest } from '../../../../packages/runtime/src/security.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
import { bindBillingEmail, selectBillingEmail } from '../../../../packages/rules/src/billing-email.js';
import { hasChatgptSessionCookie, verifySessionIdentity } from './credentials.js';
import { UpstreamError } from './http-utils.js';
import type { ExecutionServices } from './services.js';

async function readCheckoutSession(services: ExecutionServices) {
  const context = services.context;
  const originalCookies = context.environment.cookies;
  const originalAccount =
    context.accountId || context.session?.account?.id || context.session?.account?.account_id;
  const originalUser = context.userId || context.session?.user?.id;
  try {
    const session = await services.chat('建单前读取最新 Session', '/api/auth/session', undefined, {
      'cache-control': 'no-cache',
    });
    const accountId = session?.account?.id || session?.account?.account_id;
    const userId = session?.user?.id;
    verifySessionIdentity(
      { ...context, accountId: originalAccount || accountId, userId: originalUser },
      session,
    );
    if ((originalAccount && !accountId) || (originalUser && !userId))
      throw new Error('最新 Session 缺少原账号或用户标识，无法确认本单登录身份');
    if (session.expires && !(Date.parse(session.expires) > Date.now()))
      throw new Error('Session 已过期，请重新登录并获取新的 Session');
    context.session = { ...session, accessToken: session.accessToken || session.access_token };
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
  try {
    result = await observeEgress(async (input) => {
      try {
        return await services.request(proxied ? '检查本单代理出口' : '检查执行节点本机出口', input);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        return { status: error.status, data: error.data, body: '' };
      }
    });
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
  if (required) await services.checkpoint('proxy_check');
  await sampleExecutionEgress(services, required);
  const readLatestSession =
    services.assignment.paymentEnabled &&
    !services.assignment.demo &&
    !services.context.checkout &&
    hasChatgptSessionCookie(services.context.environment.cookies);
  if (readLatestSession) await readCheckoutSession(services);
  else if (
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
  if (readLatestSession || !services.context.originalSubscription) {
    await services.checkpoint('subscription_check');
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
    if (readLatestSession)
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
