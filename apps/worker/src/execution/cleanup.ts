import { trace } from '../../../../packages/runtime/src/audit.js';
import { redact } from '../../../../packages/rules/src/privacy.js';
import { verifySessionIdentity } from './credentials.js';
import type { ExecutionServices } from './services.js';
import { throwIfExecutionAborted } from '../../../../packages/runtime/src/cancellation.js';
export async function cleanupExecution(services: ExecutionServices) {
  throwIfExecutionAborted(services.signal);
  const cleanup = (services.context.cleanup ||= {});
  const config = services.assignment.run.workflow.cleanup;
  const chat = services.cleanupChat || services.chat;
  let unsavedEffect = false;
  const perform = async (name: string, enabled: boolean, action: () => Promise<void>) => {
    throwIfExecutionAborted(services.signal);
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
    const stage = 'cleanup_' + name;
    services.setStage(stage);
    try {
      // Save completed mutations before more cleanup work. The final receipt
      // also saves them when there are no steps left to run.
      if (unsavedEffect) {
        await services.checkpoint(stage);
        unsavedEffect = false;
      }
      await trace(services.log, '收尾 · ' + name, { enabled }, async (capture) => {
        await action();
        throwIfExecutionAborted(services.signal);
        capture({ status: 'succeeded' });
      });
      cleanup[name] = { status: 'succeeded' };
      unsavedEffect = name === 'registration' || name === 'cancel';
    } catch (error) {
      throwIfExecutionAborted(services.signal);
      cleanup[name] = {
        status: 'failed',
        error: String(redact((error as Error).message)),
      };
    }
  };
  if (services.context.verificationReceipt)
    await perform('verification', true, () => services.acknowledgeVerification());
  let sessionReady = false;
  let refreshError: unknown;
  const refreshSession = async () => {
    if (sessionReady) return;
    if (refreshError) throw refreshError;
    delete services.context.latestSession;
    try {
      if (!services.context.environment.cookies.some((c) => /session-token/.test(c.name)))
        throw new Error('本单缺少 Cookie／sessionToken，无法刷新最新 Session');
      // The plain read can fail or return an activation-expired token. It only
      // supplies iat; it must not prevent the official forced refresh request.
      const initial = await chat('读取当前 Session', '/api/auth/session', undefined, {
        'cache-control': 'no-cache',
      }).catch((error) => {
        throwIfExecutionAborted(services.signal);
        if (error?.code === 'OFFICIAL_SDK_UNAVAILABLE') throw error;
        return services.context.session;
      });
      let iat: string | undefined;
      try {
        iat = JSON.parse(
          Buffer.from(
            String(initial?.accessToken || initial?.access_token).split('.')[1],
            'base64url',
          ).toString(),
        ).iat?.toString();
      } catch {}
      const refreshed = await chat(
        '强制刷新最新 Session',
        '/api/auth/session?refresh=true&reason=token_expired&method=POST&path=%2Fbackend-api%2Fsubscriptions%2Fcancel',
        undefined,
        {
          'cache-control': 'no-cache',
          ...(iat ? { 'x-openai-failed-access-token-iat': iat } : {}),
        },
      );
      verifySessionIdentity(services.context, refreshed);
      if (
        services.context.accountId &&
        refreshed.account?.account_id &&
        refreshed.account.account_id !== services.context.accountId
      )
        throw new Error('刷新后的账号与原订单不一致');
      refreshed.accessToken ||= refreshed.access_token;
      let tokenExpiry: number | undefined;
      try {
        tokenExpiry = JSON.parse(
          Buffer.from(refreshed.accessToken.split('.')[1], 'base64url').toString(),
        ).exp;
      } catch {}
      if (
        (refreshed.expires && !(Date.parse(refreshed.expires) > Date.now())) ||
        (typeof tokenExpiry === 'number' && tokenExpiry <= Date.now() / 1000)
      )
        throw new Error('刷新后的 Session 或 accessToken 已过期，未使用旧凭证');
      const oldSession = services.context.session;
      services.context.session = refreshed;
      try {
        const accountInfo = await chat(
          '核验刷新后的原账号',
          '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
        );
        const accounts = Object.values(accountInfo.accounts || {}) as any[];
        if (
          services.context.accountId &&
          !accounts.some((a) => (a.account?.account_id || a.account?.id) === services.context.accountId)
        )
          throw new Error('刷新后的认证无法读取原账号');
        if (
          services.context.userId &&
          accountInfo.user?.id &&
          services.context.userId !== accountInfo.user.id
        )
          throw new Error('刷新后的认证属于其他用户');
        if (services.context.userId && !refreshed.user?.id && !accountInfo.user?.id)
          throw new Error('刷新后的认证无法核验原用户');
        if (config.refresh)
          services.context.latestSession = JSON.stringify({
            ...refreshed,
            account: refreshed.account || { id: services.context.accountId },
            cookies: services.context.environment.cookies.filter((c) =>
              /(?:^|\.)chatgpt\.com$/.test(c.domain),
            ),
          });
        sessionReady = true;
        if (config.refresh) cleanup.refresh = { status: 'succeeded' };
        // Persist rotated credentials before a later cancellation/invoice can fail.
        await services.checkpoint(services.context.phase || 'cleanup_refresh');
      } catch (error) {
        services.context.session = oldSession;
        throw error;
      }
    } catch (error) {
      sessionReady = false;
      delete services.context.latestSession;
      refreshError = error;
      if (config.refresh)
        cleanup.refresh = {
          status: 'failed',
          error: String(redact((error as Error).message)),
        };
      throw error;
    }
  };
  const authenticated: ExecutionServices['chat'] = async (name, path, body, headers) => {
    await refreshSession();
    try {
      return await chat(name, path, body, headers);
    } catch (error) {
      // Activation can invalidate even a just-read access token. Retry only
      // after an explicit 401, with a newly validated Session, never the old one.
      if ((error as any).status !== 401) throw error;
      sessionReady = false;
      refreshError = undefined;
      await refreshSession();
      try {
        return await chat(name, path, body, headers);
      } catch (retryError) {
        if ((retryError as any).status === 401) {
          sessionReady = false;
          refreshError = retryError;
          delete services.context.latestSession;
          if (config.refresh)
            cleanup.refresh = {
              status: 'failed',
              error: String(redact((retryError as Error).message)),
            };
        }
        throw retryError;
      }
    }
  };
  await perform('refresh', config.refresh, refreshSession);
  await perform('registration', true, async () => {
    if (services.assignment.run.dispatches.registration)
      throw new Error('原完成登记已派发但回执未确认，保留付款成功，不重复登记');
    // Open the browser and validate its Session before consuming the one-time registration grant.
    if (services.cleanupChat || config.refresh || config.cancel || config.invoices) await refreshSession();
    await services.command('authorize', { action: 'registration' });
    services.assignment.run.dispatches.registration = new Date().toISOString();
    const result = await chat('原订阅完成登记', '/backend-api/payments/checkout_session', {
      stripe_checkout_session_id: services.context.checkout!.id,
      processor_entity: services.context.checkout!.processor_entity,
    });
    if (result.success !== true) throw new Error('商户尚未确认原订阅完成登记');
  });
  await perform('cancel', config.cancel, async () => {
    if (!services.context.accountId) throw new Error('缺少原 account_id');
    const current = await authenticated(
      '查询原订阅续费状态',
      '/backend-api/subscriptions?account_id=' + encodeURIComponent(services.context.accountId),
    );
    const subscription = current.subscription || current;
    if (subscription.will_renew !== false)
      await authenticated('取消原账号自动续费', '/backend-api/subscriptions/cancel', {
        account_id: services.context.accountId,
      });
    const check = await authenticated(
      '核验自动续费已取消',
      '/backend-api/subscriptions?account_id=' + encodeURIComponent(services.context.accountId),
    );
    if ((check.subscription || check).will_renew !== false) throw new Error('取消请求未取得已关闭续费的确认');
    services.context.renewalStatus = 'cancelled';
  });
  await perform('invoices', config.invoices, async () => {
    const result = await authenticated(
      '获取原账号账单',
      '/backend-api/invoices?limit=4&account_id=' + encodeURIComponent(services.context.accountId || ''),
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
