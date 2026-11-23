import type {
  SentinelAuthorization,
  SentinelAuthorizer,
  SentinelRequest,
} from '../../../../packages/contracts/src/sentinel.js';

// This function is self-contained so an existing trusted extension can run it
// in the authenticated ChatGPT document. It uses that document's official SDK;
// it does not load copied SDKs, change device signals, or solve challenges.
export type SentinelPageFailure = { failureReason: string; sessionCheckPhase?: 'before' | 'after' };
export function authorizeSentinelInPage(request: SentinelRequest): Promise<SentinelAuthorization>;
export function authorizeSentinelInPage(
  request: SentinelRequest,
  reportFailure: true,
): Promise<SentinelAuthorization | SentinelPageFailure>;
export async function authorizeSentinelInPage(
  request: SentinelRequest,
  reportFailure = false,
): Promise<SentinelAuthorization | SentinelPageFailure> {
  let sessionCheckPhase: 'before' | 'after' = 'before';
  try {
    const page = (globalThis as any).window;
    const fail = (reason: string, message: string): never => {
      throw Object.assign(new Error(`[RELAY_SENTINEL_${reason}] ${message}`), {
        code: 'SENTINEL_AUTH_REQUIRED',
      });
    };
    const expected = new URL(request.pageUrl);
    if (
      !page ||
      expected.origin !== 'https://chatgpt.com' ||
      page.location?.origin !== expected.origin ||
      page.location?.pathname !== expected.pathname ||
      !request.accountId ||
      !request.deviceId ||
      !request.environmentId ||
      request.observerFlow !== 'chatgpt_checkout' ||
      !['chatgpt_checkout', 'checkout_session_approval'].includes(request.flow)
    )
      fail('PAGE_BINDING', 'Sentinel 授权需要本单账号在对应的官方页面中运行');
    const bounded = async <T>(
      operation: () => T | Promise<T>,
      reason: string,
      timeoutMs = 15000,
    ): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(
                    new Error(`[RELAY_SENTINEL_${reason}_TIMEOUT] 官方 Sentinel 授权超时`),
                    {
                      code: 'SENTINEL_AUTH_REQUIRED',
                    },
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        if ((error as Error)?.message?.startsWith('[RELAY_SENTINEL_')) throw error;
        return fail(reason, '官方页面授权调用未完成');
      } finally {
        clearTimeout(timer);
      }
    };
    const device = () => {
      const entry = String(page.document.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('oai-did='));
      try {
        return entry ? decodeURIComponent(entry.slice('oai-did='.length)) : '';
      } catch {
        return '';
      }
    };
    const session = async () =>
      bounded(async () => {
        const response = await page.fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
          ...(page.AbortSignal?.timeout ? { signal: page.AbortSignal.timeout(15000) } : {}),
        });
        if (!response.ok)
          fail('SESSION_HTTP', '无法核验本单浏览器登录状态（HTTP ' + response.status + '）');
        const value = await response.json();
        if (!(value.accessToken || value.access_token) || value.account?.id !== request.accountId)
          fail('SESSION_IDENTITY', '浏览器登录账号与本单 Session 不一致');
        return value;
      }, 'SESSION_READ');
    const before = await session();
    if (device() !== request.deviceId) fail('DEVICE_BINDING', '浏览器设备与本单环境不一致');
    // Load only the vendor's current first-party SDK in this real authenticated
    // document, as the existing checkout-autofill flow does. No copied bundle,
    // synthetic runtime, fingerprint changes or challenge solver is involved.
    if (typeof page.SentinelSDK?.token !== 'function') {
      let script: any;
      try {
        await bounded(
          () =>
            new Promise<void>((resolve, reject) => {
              script = page.document.createElement('script');
              script.src = expected.origin + '/backend-api/sentinel/sdk.js?no_universal_links=1';
              script.async = true;
              script.onload = () => resolve();
              script.onerror = () => reject(new Error('official SDK load failed'));
              page.document.head.appendChild(script);
            }),
          'SDK_LOAD',
        );
      } finally {
        if (script) {
          script.onload = script.onerror = null;
          script.remove();
        }
      }
    }
    const ready = () =>
      typeof page.SentinelSDK?.token === 'function' &&
      typeof page.SentinelSDK?.sessionObserverToken === 'function';
    // The first-party loader's load event precedes its versioned implementation.
    const readyUntil = Date.now() + 15000;
    while (!ready() && Date.now() < readyUntil)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!ready()) fail('SDK_UNAVAILABLE', '原页面的官方 Sentinel SDK 尚未就绪');
    const sdk = page.SentinelSDK;
    // token() performs its own requirements fetch. init() is a separate
    // prefetch API and must not become an additional authorization gate.
    const token = await bounded(() => sdk.token(request.flow), 'SDK_TOKEN', 45000);
    const soToken = await bounded(
      () => sdk.sessionObserverToken(request.observerFlow),
      'SDK_OBSERVER',
    );
    const validHeader = (value: unknown): value is string =>
      typeof value === 'string' &&
      !!value.trim() &&
      value.length <= 100000 &&
      !/[\r\n]/.test(value);
    if (!validHeader(token) || (soToken != null && soToken !== '' && !validHeader(soToken)))
      fail('SDK_HEADER', '官方 Sentinel SDK 未返回有效授权请求头');
    sessionCheckPhase = 'after';
    const after = await session();
    if (before.user?.id !== after.user?.id || device() !== request.deviceId)
      fail('IDENTITY_CHANGED', 'Sentinel 签发期间浏览器账号或设备发生变化');
    const issuedAt = Date.now();
    return {
      ...request,
      token: token as string,
      ...(validHeader(soToken) ? { soToken } : {}),
      issuedAt: new Date(issuedAt).toISOString(),
      // Conservative local freshness bound, not a claimed server expiration.
      expiresAt: new Date(issuedAt + 60000).toISOString(),
    };
  } catch (error) {
    if (!reportFailure) throw error;
    // Chrome's executeScript does not reliably return thrown page errors.
    // Return only a bounded local stage code, never SDK messages or credentials.
    const failureReason =
      String((error as Error)?.message || '').match(/\[RELAY_SENTINEL_([A-Z_]{3,32})\]/)?.[1] ||
      'PAGE_EXECUTION';
    return {
      failureReason,
      ...(failureReason.startsWith('SESSION_') ? { sessionCheckPhase } : {}),
    };
  }
}

export type AuthenticatedPageExecutor = (
  action: typeof authorizeSentinelInPage,
  request: SentinelRequest,
) => Promise<SentinelAuthorization>;

export function createBrowserSentinelAuthorizer(
  execute: AuthenticatedPageExecutor,
): SentinelAuthorizer {
  return (request) => execute(authorizeSentinelInPage, request);
}

import type { StripeTokenRequest } from '../../../../packages/contracts/src/stripe.js';

export type StripePageResult =
  | { ok: true; id: string; lastFour: string }
  | { ok: false; reason: string; cardDataSubmitted: boolean; detail?: string };

// Self-contained Chrome MAIN-world action. Card data stays in Stripe's HTTPS
// Payment Element iframe. This page action only returns the SDK's opaque token.
export async function prepareStripeTokenInPage(
  request: StripeTokenRequest,
): Promise<StripePageResult> {
  const page = (globalThis as any).window;
  let overlay: any, payment: any;
  let cardDataSubmitted = false;
  const fail = (reason: string): never => {
    throw new Error('[RELAY_STRIPE_' + reason + ']');
  };
  const bounded = async <T>(action: () => Promise<T>, reason: string, ms = 20000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('[RELAY_STRIPE_' + reason + '_TIMEOUT]')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (
      page?.location?.origin !== 'https://chatgpt.com' ||
      !request.accountId ||
      !request.environmentId ||
      !request.deviceId ||
      !/^(oaics_|cs_)[a-zA-Z0-9_]+$/.test(request.checkoutId) ||
      !/^pk_(live|test)_/.test(request.publishableKey) ||
      !/^\d{4}$/.test(request.cardLastFour) ||
      !Number.isSafeInteger(request.amountMinor) ||
      request.amountMinor < 0 ||
      !/^[a-z]{3}$/i.test(request.currency) ||
      new URL(request.returnUrl).origin !== 'https://chatgpt.com'
    )
      fail('CONFIG_INVALID');
    const identity = async () =>
      bounded(async () => {
        const r = await page.fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'error',
        });
        if (!r.ok) fail('SESSION_UNAVAILABLE');
        const value = await r.json();
        const device = String(page.document.cookie || '')
          .split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('oai-did='));
        if (
          value.account?.id !== request.accountId ||
          !device ||
          decodeURIComponent(device.slice(8)) !== request.deviceId
        )
          fail('IDENTITY_MISMATCH');
        return value.user?.id;
      }, 'SESSION');
    const before = await identity();
    if (page.document.getElementById('relay-stripe-preparation')) fail('ALREADY_OPEN');
    if (typeof page.Stripe !== 'function') {
      await bounded(
        () =>
          new Promise<void>((resolve, reject) => {
            const script = page.document.createElement('script');
            script.src = 'https://js.stripe.com/v3/';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('[RELAY_STRIPE_SDK_LOAD_FAILED]'));
            page.document.head.appendChild(script);
          }),
        'SDK_LOAD',
      );
    }
    if (typeof page.Stripe !== 'function') fail('SDK_UNAVAILABLE');
    overlay = page.document.createElement('section');
    overlay.id = 'relay-stripe-preparation';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Relay 官方 Stripe 卡片准备');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;background:#10243a99;display:grid;place-items:center;padding:24px;color:#18304a;font:14px system-ui';
    const panel = page.document.createElement('form');
    panel.style.cssText =
      'width:min(520px,90vw);max-height:88vh;overflow:auto;background:white;border-radius:16px;padding:24px;box-sizing:border-box';
    const heading = page.document.createElement('h2');
    heading.textContent = 'Relay · 官方 Stripe 卡片准备';
    const quote = page.document.createElement('p');
    const digits =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: request.currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
    quote.textContent =
      request.currency.toUpperCase() +
      ' ' +
      (request.amountMinor / 10 ** digits).toFixed(digits) +
      ' · ' +
      request.billing.country +
      ' ' +
      request.billing.state +
      ' · 卡片尾号 ' +
      request.cardLastFour;
    const mount = page.document.createElement('div');
    mount.id = 'relay-stripe-payment-element';
    const status = page.document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = '正在加载官方银行卡组件…';
    const submit = page.document.createElement('button');
    submit.type = 'submit';
    submit.disabled = true;
    submit.textContent = '生成一次性卡片令牌';
    submit.style.cssText =
      'background:#175cd3;color:white;border:0;border-radius:8px;padding:12px;margin-right:12px';
    const cancel = page.document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消本次准备';
    cancel.style.cssText = 'padding:12px';
    panel.append(heading, quote, mount, status, submit, cancel);
    overlay.append(panel);
    page.document.body.append(overlay);
    const stripe = page.Stripe(
      request.publishableKey,
      request.stripeAccount ? { stripeAccount: request.stripeAccount } : undefined,
    );
    const elements = stripe.elements({
      mode: 'subscription',
      amount: request.amountMinor,
      currency: request.currency.toLowerCase(),
      paymentMethodTypes: ['card'],
      setupFutureUsage: 'off_session',
      ...(request.customerSessionClientSecret
        ? { customerSessionClientSecret: request.customerSessionClientSecret }
        : {}),
      appearance: { theme: 'stripe' },
    });
    payment = elements.create('payment', {
      layout: 'tabs',
      // Suppressed fields are supplied in createConfirmationToken below.
      fields: {
        billingDetails: {
          name: 'never',
          email: 'never',
          phone: request.billing.phone?.trim() ? 'never' : 'auto',
          address: 'never',
        },
      },
      wallets: { applePay: 'never', googlePay: 'never' },
    });
    let busy = false;
    payment.on('ready', () => {
      status.textContent = '请输入已确认的银行卡资料。';
    });
    payment.on('change', (event: any) => {
      if (!busy) submit.disabled = !event.complete;
    });
    payment.mount(mount);
    const result = await bounded(
      () =>
        new Promise<any>((resolve, reject) => {
          cancel.onclick = () => reject(new Error('[RELAY_STRIPE_USER_CANCELLED]'));
          panel.onsubmit = async (event: any) => {
            event.preventDefault();
            if (busy) return;
            busy = true;
            submit.disabled = true;
            status.textContent = '正在通过官方 Stripe SDK 准备卡片资料…';
            try {
              const validation = await elements.submit();
              if (validation.error) {
                status.textContent = validation.error.message || '请检查银行卡资料。';
                busy = false;
                submit.disabled = false;
                return;
              }
              const b = request.billing;
              cardDataSubmitted = true;
              const value = await stripe.createConfirmationToken({
                elements,
                params: {
                  return_url: request.returnUrl,
                  payment_method_data: {
                    allow_redisplay: 'limited',
                    billing_details: {
                      name: b.name,
                      email: b.email,
                      ...(b.phone?.trim() ? { phone: b.phone.trim() } : {}),
                      address: {
                        line1: b.line1,
                        line2: b.line2 || '',
                        city: b.city,
                        state: b.state,
                        postal_code: b.postalCode,
                        country: b.country,
                      },
                    },
                  },
                },
              });
              if (value.error)
                throw new Error(
                  '[RELAY_STRIPE_TOKENIZATION_FAILED] ' +
                    String(value.error.code || value.error.type || 'unclassified'),
                );
              const token = value.confirmationToken;
              if (
                !/^ctoken_[a-zA-Z0-9]+$/.test(token?.id || '') ||
                token.payment_method_preview?.type !== 'card' ||
                token.payment_method_preview?.card?.last4 !== request.cardLastFour
              )
                fail('TOKEN_MISMATCH');
              if ((await identity()) !== before) fail('IDENTITY_MISMATCH');
              resolve({
                ok: true,
                id: token.id,
                lastFour: token.payment_method_preview.card.last4,
              });
            } catch (error) {
              reject(error);
            }
          };
        }),
      'CARD_ENTRY',
      300000,
    );
    return result;
  } catch (error) {
    let detail = String((error as Error)?.message || '');
    for (const value of [request.publishableKey, request.customerSessionClientSecret])
      if (value) detail = detail.replaceAll(value, '[REDACTED]');
    detail = detail
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED]')
      .replace(/(?:cuss_|ctoken_)[A-Za-z0-9_]+/g, '[REDACTED]')
      .replace(/((?:cvc|cvv|security.?code)\s*[:=]?\s*)\d{3,4}/gi, '$1[REDACTED]')
      .slice(0, 400);
    return {
      ok: false,
      cardDataSubmitted,
      detail,
      reason:
        String((error as Error)?.message || '').match(/\[RELAY_STRIPE_([A-Z_]{3,40})\]/)?.[1] ||
        'SDK_EXECUTION_FAILED',
    };
  } finally {
    payment?.destroy();
    overlay?.remove();
  }
}
