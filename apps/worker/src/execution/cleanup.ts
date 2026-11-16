import { trace } from '../../../../packages/runtime/src/audit.js';
import { redact } from '../../../../packages/rules/src/privacy.js';
import { verifySessionIdentity } from './credentials.js';
import type { ExecutionServices } from './services.js';
export async function cleanupExecution(services: ExecutionServices) {
  const cleanup = (services.context.cleanup ||= {});
  const config = services.assignment.run.workflow.cleanup;
  const perform = async (name: string, enabled: boolean, action: () => Promise<void>) => {
    if (cleanup[name]?.status === 'succeeded') return;
    if (!enabled) {
      cleanup[name] = { status: 'skipped' };
      await services.log({
        name: '收尾 · ' + name,
        status: 'skipped',
        category: 'event',
        request: { enabled },
        response: { reason: '工作流未启用此收尾步骤' },
      });
      return;
    }
    try {
      await services.checkpoint('cleanup_' + name);
      await trace(services.log, '收尾 · ' + name, { enabled }, async (capture) => {
        await action();
        capture({ status: 'succeeded' });
      });
      cleanup[name] = { status: 'succeeded' };
    } catch (error) {
      cleanup[name] = {
        status: 'failed',
        error: String(redact((error as Error).message)),
      };
    }
  };
  if (services.context.verificationReceipt)
    await perform('verification', true, () => services.acknowledgeVerification());
  await perform('registration', true, async () => {
    if (services.assignment.run.dispatches.registration)
      throw new Error('原完成登记已派发但回执未确认，保留付款成功，不重复登记');
    await services.command('authorize', { action: 'registration' });
    services.assignment.run.dispatches.registration = new Date().toISOString();
    const result = await services.chat('原订阅完成登记', '/backend-api/payments/checkout_session', {
      stripe_checkout_session_id: services.context.checkout!.id,
      processor_entity: services.context.checkout!.processor_entity,
    });
    if (result.success !== true) throw new Error('商户尚未确认原订阅完成登记');
  });
  await perform('refresh', config.refresh, async () => {
    if (!services.context.environment.cookies.some((c) => /session-token/.test(c.name)))
      throw new Error('本单缺少 Cookie／sessionToken，无法刷新最新 Session');
    const initial = await services.chat('读取当前 Session', '/api/auth/session', undefined, {
      'cache-control': 'no-cache',
    });
    let iat: string | undefined;
    try {
      iat = JSON.parse(
        Buffer.from(String(initial.accessToken).split('.')[1], 'base64url').toString(),
      ).iat?.toString();
    } catch {}
    const refreshed = await services.chat(
      '强制刷新最新 Session',
      '/api/auth/session?refresh=true&reason=token_expired&method=POST&path=%2Fbackend-api%2Fsubscriptions%2Fcancel',
      undefined,
      {
        'cache-control': 'no-cache',
        ...(iat ? { 'x-openai-failed-access-token-iat': iat } : {}),
      },
    );
    verifySessionIdentity(services.context, refreshed);
    refreshed.accessToken ||= refreshed.access_token;
    const oldSession = services.context.session;
    services.context.session = refreshed;
    try {
      const accountInfo = await services.chat(
        '核验刷新后的原账号',
        '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
      );
      const accounts = Object.values(accountInfo.accounts || {}) as any[];
      if (
        services.context.accountId &&
        !accounts.some(
          (a) => (a.account?.account_id || a.account?.id) === services.context.accountId,
        )
      )
        throw new Error('刷新后的认证无法读取原账号');
      if (
        services.context.userId &&
        accountInfo.user?.id &&
        services.context.userId !== accountInfo.user.id
      )
        throw new Error('刷新后的认证属于其他用户');
      services.context.latestSession = JSON.stringify({
        ...refreshed,
        account: refreshed.account || { id: services.context.accountId },
        cookies: services.context.environment.cookies.filter((c) =>
          /(?:^|\.)chatgpt\.com$/.test(c.domain),
        ),
      });
    } catch (error) {
      services.context.session = oldSession;
      throw error;
    }
  });
  await perform('cancel', config.cancel, async () => {
    if (!services.context.accountId) throw new Error('缺少原 account_id');
    const current = await services.chat(
      '查询原订阅续费状态',
      '/backend-api/subscriptions?account_id=' + encodeURIComponent(services.context.accountId),
    );
    const subscription = current.subscription || current;
    if (subscription.will_renew !== false)
      await services.chat('取消原账号自动续费', '/backend-api/subscriptions/cancel', {
        account_id: services.context.accountId,
      });
    const check = await services.chat(
      '核验自动续费已取消',
      '/backend-api/subscriptions?account_id=' + encodeURIComponent(services.context.accountId),
    );
    if ((check.subscription || check).will_renew !== false)
      throw new Error('取消请求未取得已关闭续费的确认');
    services.context.renewalStatus = 'cancelled';
  });
  await perform('invoices', config.invoices, async () => {
    const result = await services.chat(
      '获取原账号账单',
      '/backend-api/invoices?limit=4&account_id=' +
        encodeURIComponent(services.context.accountId || ''),
    );
    const list: any[] = result.invoices || result.data || result.items || [];
    services.context.billingExternalUrls = list
      .map((x) => x.hosted_invoice_url || x.invoice_url || x.url)
      .filter((u: any) => {
        try {
          return ['https:', 'http:'].includes(new URL(u).protocol);
        } catch {
          return false;
        }
      })
      .slice(0, 20);
    if (!services.context.billingExternalUrls.length) throw new Error('账单尚未就绪');
  });
  await services.command('finish', {
    status: 'completed',
    context: services.context,
    cleanup,
  });
}
