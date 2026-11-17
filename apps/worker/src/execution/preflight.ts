import { inspectEgress } from '../../../../packages/runtime/src/egress.js';
import { digest } from '../../../../packages/runtime/src/security.js';
import { isIP } from 'node:net';
import { bindBillingEmail, selectBillingEmail } from '../../../../packages/rules/src/billing-email.js';
import { verifySessionIdentity } from './credentials.js';
import { UpstreamError } from './http-utils.js';
import type { ExecutionServices } from './services.js';
export async function preflightExecution(services: ExecutionServices) {
  if (!services.context.proxyVerified) {
    await services.checkpoint('proxy_check');
    const proxied =
      services.context.environment.networkMode === 'proxy' || !!services.context.environment.proxyUrl;
    const result = await inspectEgress(async (input) => {
      try {
        return await services.request(proxied ? '检查本单代理出口' : '检查执行节点本机出口', input);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        return { status: error.status, data: error.data, body: '' };
      }
    });
    services.context.exitIp = result.ip;
    services.context.exitCountry = result.country;
    services.context.proxyVerified = !proxied || result.country === services.context.environment.country;
  }
  const exitIp = services.context.exitIp;
  if (
    typeof exitIp === 'string' &&
    isIP(exitIp) &&
    services.context.exitFingerprint !== digest(exitIp).slice(0, 12)
  ) {
    // A shared proxy gateway can assign different real exits. Correlate the
    // measured exit without adding its address or location to diagnostic logs.
    services.context.exitFingerprint = digest(exitIp).slice(0, 12);
    await services.log({
      name: '记录本单网络出口',
      status: 'succeeded',
      category: 'event',
      response: {
        exitFingerprint: services.context.exitFingerprint,
        country: /^[A-Z]{2}$/.test(services.context.exitCountry || '')
          ? services.context.exitCountry
          : undefined,
        requestedCountry: services.context.environment.country,
        verified: services.context.proxyVerified === true,
        networkMode: services.context.environment.proxyUrl ? 'proxy' : 'direct',
      },
    });
  }
  if (!services.context.proxyVerified)
    throw Object.assign(
      new Error(
        `代理出口国家与订单地区不匹配：期望 ${services.context.environment.country}，实际 ${services.context.exitCountry}`,
      ),
      { code: 'PROXY_COUNTRY_MISMATCH' },
    );
  if (
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
  if (!services.context.originalSubscription) {
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
    services.context.accountId = accountId;
    services.context.userId ||= info.user?.id;
    services.context.originalSubscription = selected.entitlement || {};
  }
  if (services.context.originalSubscription?.has_active_subscription)
    throw new Error('账号已有有效订阅，请先核对套餐，执行器未发起新付款');
  await services.requireSentinel('chatgpt_checkout');
  await services.checkpoint('subscription_ready');
}
