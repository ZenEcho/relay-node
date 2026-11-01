import { trace, auditError, auditRequest, type AuditEntry } from '../../../packages/core/src/audit.js';
import { retryAfterMs } from '../../../packages/core/src/http-policy.js';
import { inspectEgress } from '../../../packages/core/src/egress.js';
import { randomUUID } from 'node:crypto';
import type { Assignment, Control } from './control.js';
import type { Transport, HttpInput } from './transport.js';
import { loadCredential, verifySessionIdentity } from './session.js';
import { paymentPlan } from '../../../packages/core/src/policy.js';
import { redact } from '../../../packages/core/src/security.js';
import { sentinelToken } from './sentinel.js';
import type { RuntimeContext } from '../../../packages/core/src/domain.js';
const CHAT = 'https://chatgpt.com',
  STRIPE = 'https://api.stripe.com';
const STRIPE_VERSION = '2025-03-31.basil';
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: any,
  ) {
    super(message);
  }
}
const form = (values: Record<string, any>) =>
  new URLSearchParams(
    Object.fromEntries(
      Object.entries(values)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
export class ProtocolEngine {
  private context: RuntimeContext;
  private stage = 'preflight';
  private paid = false;
  private verificationReceipt: any = null;
  constructor(
    private assignment: Assignment,
    private control: Control,
    private transport: Transport,
  ) {
    this.context = assignment.context;
  }
  private async checkpoint(stage: string) {
    this.stage = stage;
    this.context.phase = stage;
    await this.command('checkpoint', { context: this.context, stage });
  }
  private log = async (step: AuditEntry) => {
    await this.control.request('step', { step: { ...step, source: 'worker' } });
  };
  private async command(action: string, body: any = {}): Promise<any> {
    if (action === 'step') return this.control.request(action, body);
    const names: Record<string, string> = {
      checkpoint: '保存执行进度',
      card: '请求付款卡片',
      authorize: '请求付款派发授权',
      verification: '客户验证协调',
      finish: '提交执行结果',
    };
    return trace(
      this.log,
      names[action] || action,
      { method: 'POST', path: `/api/worker/runs/${this.assignment.run.id}/${action}`, action, ...body },
      async (capture) => {
        const result = await this.control.request(action, body);
        capture(result);
        return result;
      },
    );
  }
  private async request(name: string, input: HttpInput) {
    const environment = this.context.environment;
    return trace(
      this.log,
      name,
      auditRequest({
        ...input,
        headers: { ...environment.headers, ...input.headers },
        environmentId: environment.id,
        profile: environment.profile,
        country: environment.country,
        networkMode: environment.networkMode || (environment.proxyUrl ? 'proxy' : 'direct'),
        proxyUrl: environment.proxyUrl,
        cookieNames: environment.cookies.map((cookie) => cookie.name),
      }),
      async (capture) => {
        const origin = new URL(input.url).origin;
        const backoff = this.context.retryAfterByOrigin?.[origin];
        if (backoff && backoff > Date.now())
          throw new UpstreamError('上游仍在退避期限内，只保留原付款', 429, null);
        const output = await this.transport.request(input);
        capture(
          { status: output.status, headers: output.headers, body: output.data ?? output.body },
          output.status,
        );
        const retryHeader = Object.entries(output.headers).find(
          ([key]) => key.toLowerCase() === 'retry-after',
        )?.[1]?.[0];
        const delay = retryAfterMs(retryHeader);
        if (output.status >= 400 && delay) {
          this.context.retryAfterByOrigin ||= {};
          this.context.retryAfterByOrigin[origin] = Date.now() + delay;
          this.context.retryAfterAt = Math.max(
            ...(Object.values(this.context.retryAfterByOrigin) as number[]),
          );
        }
        if (output.status < 200 || output.status >= 300)
          throw new UpstreamError(
            `HTTP ${output.status}：${output.data?.error?.message || output.data?.detail || output.data?.message || name}`,
            output.status,
            output.data,
          );
        return output;
      },
      'http',
    );
  }
  private headers(path: string): Record<string, string> {
    const c = this.context;
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: CHAT,
      referer: c.checkout
        ? CHAT + '/checkout/' + (c.checkout.processor_entity || 'openai_llc') + '/' + c.checkout.id
        : CHAT + '/',
      'oai-device-id': c.environment.deviceId,
      'oai-session-id': c.environment.id,
      'oai-language': 'en-US',
      'x-openai-target-path': path.split('?')[0],
      'x-openai-target-route': path.split('?')[0],
      ...(c.session?.accessToken ? { authorization: 'Bearer ' + c.session.accessToken } : {}),
      ...(c.accountId ? { 'chatgpt-account-id': c.accountId } : {}),
      ...(c.sentinel ? { 'openai-sentinel-token': c.sentinel } : {}),
      ...(c.metadata?.attestation ? { 'oai-web-deployment-attestation': c.metadata.attestation } : {}),
      ...(c.metadata?.build ? { 'oai-client-build-number': c.metadata.build } : {}),
      ...(c.metadata?.version ? { 'oai-client-version': c.metadata.version } : {}),
    };
  }
  private async chat(name: string, path: string, body?: any, extra?: Record<string, string>) {
    return (
      await this.request(name, {
        method: body === undefined ? 'GET' : 'POST',
        url: CHAT + path,
        headers: { ...this.headers(path), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ).data;
  }
  private async stripe(name: string, path: string, body?: Record<string, any>) {
    return (
      await this.request(name, {
        method: body === undefined ? 'GET' : 'POST',
        url: STRIPE + path,
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://js.stripe.com',
          referer: 'https://js.stripe.com/',
        },
        body: body === undefined ? undefined : form(body),
      })
    ).data;
  }
  async execute() {
    try {
      await trace(
        this.log,
        '初始化订单环境与凭证',
        {
          mode: this.assignment.mode,
          country: this.context.environment.country,
          environmentId: this.context.environment.id,
        },
        async (capture) => {
          loadCredential(this.context);
          await this.transport.initialize(this.context.environment);
          capture({ initialized: true, profile: this.context.environment.profile });
        },
      );
      if (this.assignment.mode === 'cleanup') {
        this.paid = true;
        await this.cleanup();
        return;
      }
      if (this.assignment.mode === 'reconcile' || this.assignment.run.paymentSubmitted) {
        await this.reconcile();
        return;
      }
      await this.preflight();
      if (!this.assignment.paymentEnabled && !this.assignment.demo)
        throw new Error('真实付款未启用：请同时开启控制台付款开关与 COMMIT_PAYMENTS');
      const billing = this.assignment.billing;
      if (
        !billing ||
        !billing.name ||
        !billing.line1 ||
        !billing.city ||
        !billing.postalCode ||
        (this.context.billingAddress
          ? billing.country !== 'US' || !billing.state
          : billing.country !== this.context.environment.country)
      )
        throw new Error('请配置完整的默认账单地址，或等待预备地址就绪');
      if (!this.context.checkout) {
        await this.checkpoint('checkout');
        const currencyConfig = await this.chat(
          '读取地区币种',
          '/backend-api/checkout_pricing_config/configs/' + this.context.environment.country,
        );
        const explicitCurrency = this.assignment.run.order.cdkPaymentCurrency;
        const currency =
          explicitCurrency && explicitCurrency !== '-'
            ? explicitCurrency.toUpperCase()
            : currencyConfig?.currency_config?.symbol_code;
        if (!currency) throw new Error('报价接口未返回地区币种');
        this.context.currency = currency;
        const result = await this.chat('创建支付链接', '/backend-api/payments/checkout', {
          plan_name: paymentPlan(this.assignment.run.workflow.plan).planName,
          billing_details: { country: this.context.environment.country, currency },
          entry_point: 'all_plans_pricing_modal',
          checkout_ui_mode: 'custom',
          processor_entity: 'openai_llc',
        });
        const id =
          result.internal_checkout_session_id ||
          result.internalCheckoutSessionId ||
          result.checkout_session?.id ||
          result.checkout_session_id;
        if (!/^(oaics_|cs_)[a-zA-Z0-9_]+$/.test(id || ''))
          throw new Error('支付链接响应缺少可识别的原 checkout ID');
        this.context.checkout = { id, processor_entity: result.processor_entity || 'openai_llc' };
        await this.checkpoint('checkout_created');
      }
      if (!this.context.snapshot) {
        const taxes = await this.chat('更新原结账税费', '/backend-api/payments/checkout/taxes', {
          checkout_session_id: this.context.checkout!.id,
          checkout_email: billing.email || this.context.email,
          billing_country: billing.country,
          billing_name: billing.name,
          currency: this.context.currency.toLowerCase(),
          processor_entity: this.context.checkout!.processor_entity,
          billing_address: {
            line1: billing.line1,
            line2: billing.line2 || '',
            city: billing.city,
            state: billing.state,
            postal_code: billing.postalCode,
            country: billing.country,
          },
        });
        this.context.snapshot = taxes.checkout_session || taxes.checkoutSession;
        if (!this.context.snapshot) throw new Error('计税响应缺少原结账快照');
        if (this.context.snapshot.id && this.context.snapshot.id !== this.context.checkout!.id)
          throw new Error('计税响应属于其他结账');
        if (
          this.context.snapshot.processor_entity &&
          this.context.snapshot.processor_entity !== this.context.checkout!.processor_entity
        )
          throw new Error('计税响应处理方不匹配');
        this.context.key =
          this.context.snapshot.publishable_key ||
          this.context.snapshot.stripe_publishable_key ||
          this.context.snapshot.stripe?.publishable_key;
        if (!this.context.key)
          this.context.key = (
            await this.chat('读取付款组件配置', '/backend-api/payments/stripe_client_bootstrap', {})
          ).publishable_key;
        if (!this.context.key) throw new Error('原结账缺少 Stripe publishable key');
        await this.checkpoint('taxes_ready');
      }
      if (!this.context.elements) {
        this.context.clientSessionId ||= randomUUID();
        this.context.elements = await this.stripe(
          '初始化 Elements',
          '/v1/elements/sessions?' +
            form({
              key: this.context.key,
              type: 'deferred_intent',
              'deferred_intent[mode]': 'subscription',
              'deferred_intent[amount]': this.context.snapshot.amount_total,
              'deferred_intent[currency]':
                this.context.snapshot.currency || this.context.currency.toLowerCase(),
              'deferred_intent[payment_method_types][0]': 'card',
            }),
        );
        if (!this.context.elements?.id) throw new Error('Elements 响应缺少会话标识');
        await this.checkpoint('elements_ready');
      }
      if (!this.context.confirmationToken) {
        await this.checkpoint('card_preparation');
        const card = await this.command('card');
        try {
          const [month, yearText] = String(card.expiry).split(/[\/-]/);
          const year = yearText?.length === 2 ? '20' + yearText : yearText;
          if (!month || !year) throw new Error('卡片有效期格式不支持');
          const fields: Record<string, any> = {
            key: this.context.key,
            _stripe_version: STRIPE_VERSION,
            'payment_method_data[type]': 'card',
            'payment_method_data[guid]': this.context.environment.stripeIds.guid,
            'payment_method_data[muid]': this.context.environment.stripeIds.muid,
            'payment_method_data[sid]': this.context.environment.stripeIds.sid,
            'payment_method_data[card][number]': card.number,
            'payment_method_data[card][cvc]': card.cvc,
            'payment_method_data[card][exp_month]': month,
            'payment_method_data[card][exp_year]': year,
            'payment_method_data[allow_redisplay]': 'limited',
            'payment_method_data[billing_details][name]': billing.name,
            'payment_method_data[billing_details][email]': billing.email || this.context.email,
            'payment_method_data[billing_details][address][line1]': billing.line1,
            'payment_method_data[billing_details][address][line2]': billing.line2,
            'payment_method_data[billing_details][address][city]': billing.city,
            'payment_method_data[billing_details][address][state]': billing.state,
            'payment_method_data[billing_details][address][postal_code]': billing.postalCode,
            'payment_method_data[billing_details][address][country]': billing.country,
            setup_future_usage: 'off_session',
            set_as_default_payment_method: 'false',
          };
          const attribution = {
            client_session_id: this.context.clientSessionId,
            elements_session_id: this.context.elements.id,
            elements_session_config_id: this.context.elements.config_id,
            merchant_integration_source: 'elements',
            merchant_integration_subtype: 'payment-element',
            merchant_integration_version: '2021',
            payment_intent_creation_flow: 'deferred',
            payment_method_selection_flow: 'merchant_specified',
          };
          for (const [k, v] of Object.entries(attribution)) {
            fields[`client_attribution_metadata[${k}]`] = v;
            fields[`payment_method_data[client_attribution_metadata][${k}]`] = v;
          }
          const token = await this.stripe('创建原卡确认令牌', '/v1/confirmation_tokens', fields);
          if (!/^ctoken_/.test(token.id || '')) throw new Error('未取得 confirmation token');
          this.context.confirmationToken = token.id;
        } finally {
          card.number = '';
          card.cvc = '';
        }
        await this.checkpoint('confirmation_token_ready');
      }
      await this.command('authorize', { action: 'merchant_confirm' });
      this.assignment.run.paymentSubmitted = true;
      const confirm = await this.chat('商户付款确认', '/backend-api/payments/checkout/confirm', {
        checkout_session_id: this.context.checkout!.id,
        confirm_token: this.context.confirmationToken,
        selected_payment_method_type: 'card',
      });
      this.context.merchantConfirmation = confirm;
      if (confirm.error || confirm.success === false || confirm.status !== 'success')
        throw new Error(
          '商户确认未成功：' + String(confirm.status || confirm.error?.message || '响应缺少状态'),
        );
      let clientSecret = confirm.client_secret;
      if (!clientSecret && this.context.checkout!.id.startsWith('cs_')) {
        const page = await this.stripe(
          '核对原 Custom Checkout',
          '/v1/payment_pages/' +
            this.context.checkout!.id +
            '?' +
            form({ key: this.context.key, _stripe_version: STRIPE_VERSION }),
        );
        this.context.paymentPage = page;
        if (page.status === 'requires_approval' || page.approval_status === 'requires_approval') {
          await this.checkpoint('approval_ready');
          await this.command('authorize', { action: 'merchant_approve' });
          await this.chat('原结账审批', '/backend-api/payments/checkout/approve', {
            checkout_session_id: this.context.checkout!.id,
            processor_entity: this.context.checkout!.processor_entity,
          });
        }
        const current = await this.stripe(
          '读取原 Intent',
          '/v1/payment_pages/' +
            this.context.checkout!.id +
            '?' +
            form({ key: this.context.key, _stripe_version: STRIPE_VERSION }),
        );
        clientSecret = current.payment_intent?.client_secret;
      }
      if (!/^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(clientSecret || '')) {
        await this.checkpoint('merchant_result_pending');
        await this.park('pending_confirmation', '商户请求已派发，尚未取得可核对的原 Intent');
        return;
      }
      this.context.intent = { id: clientSecret.split('_secret_')[0], client_secret: clientSecret };
      await this.checkpoint('intent_ready');
      const returnUrl = confirm.confirm_return_url || this.context.snapshot.return_url || CHAT + '/';
      const parsed = new URL(returnUrl);
      if (parsed.origin !== CHAT) throw new Error('付款返回地址不属于原商户');
      await this.command('authorize', { action: 'stripe_confirm' });
      const originalIntent = this.context.intent!;
      const confirmedIntent = await this.stripe(
        'Stripe 原 Intent 确认',
        '/v1/payment_intents/' + this.context.intent!.id + '/confirm',
        {
          key: this.context.key,
          client_secret: clientSecret,
          confirmation_token: this.context.confirmationToken,
          return_url: returnUrl,
          _stripe_version: STRIPE_VERSION,
          'client_attribution_metadata[client_session_id]': this.context.clientSessionId,
          'client_attribution_metadata[merchant_integration_source]': 'l1',
        },
      );
      if (
        confirmedIntent.id !== originalIntent.id ||
        (confirmedIntent.client_secret && confirmedIntent.client_secret !== clientSecret)
      )
        throw new Error('付款确认响应不属于原 Intent');
      this.context.intent = { ...confirmedIntent, client_secret: clientSecret };
      await this.checkpoint('stripe_result');
      await this.handleIntent();
    } catch (error) {
      const e = error as Error;
      await this.log({
        name: '执行失败 · ' + this.stage,
        status: 'failed',
        category: 'event',
        error: e.message,
        errorDetail: auditError(error),
        response: {
          stage: this.stage,
          paymentSubmitted: this.assignment.run.paymentSubmitted,
          paid: this.paid,
        },
      });
      if (this.paid) {
        await this.command('finish', {
          status: 'completed',
          context: this.context,
          cleanup: this.context.cleanup || {},
          error: e.message,
        }).catch(() => {});
      } else if ((error as any).code === 'CARD_PENDING') {
        this.context.resourceWait = true;
        await this.command('finish', { status: 'paused', context: this.context, error: e.message });
      } else {
        const intent = error instanceof UpstreamError ? error.data?.error?.payment_intent : null;
        const declined =
          intent?.status === 'requires_payment_method' &&
          Boolean(intent.last_payment_error || (error instanceof UpstreamError && error.status === 402));
        if (declined) this.context.intent = intent;
        await this.command('finish', {
          status: this.assignment.run.paymentSubmitted && !declined ? 'pending_confirmation' : 'failed',
          paymentOutcome: declined ? 'failed' : undefined,
          context: this.context,
          error: e.message,
        });
      }
    } finally {
      this.transport.close();
      await this.log({
        name: '关闭订单传输会话',
        status: 'succeeded',
        category: 'event',
        response: { environmentId: this.context.environment.id, closed: true },
      });
    }
  }
  private async preflight() {
    if (!this.context.proxyVerified) {
      await this.checkpoint('proxy_check');
      const proxied = this.context.environment.networkMode === 'proxy' || !!this.context.environment.proxyUrl;
      const result = await inspectEgress(async (input) => {
        try {
          return await this.request(proxied ? '检查本单代理出口' : '检查执行节点本机出口', input);
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          return { status: error.status, data: error.data, body: '' };
        }
      });
      if (proxied && result.country !== this.context.environment.country)
        throw new Error('代理出口国家与订单地区不匹配');
      this.context.exitIp = result.ip;
      this.context.exitCountry = result.country;
      this.context.proxyVerified = true;
    }
    if (!this.context.session?.accessToken) {
      const refreshed = await this.chat('读取登录 Session', '/api/auth/session');
      verifySessionIdentity(this.context, refreshed);
      this.context.session = refreshed;
    }
    if (!this.context.originalSubscription) {
      await this.checkpoint('subscription_check');
      const info = await this.chat(
        '查询原账号订阅',
        '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
      );
      const accounts = Object.values(info.accounts || {}) as any[];
      const selected = this.context.accountId
        ? accounts.find((a) => (a.account?.account_id || a.account?.id) === this.context.accountId)
        : info.accounts?.default || accounts[0];
      const accountId = selected?.account?.account_id || selected?.account?.id;
      if (!accountId) throw new Error('订阅查询未返回原账号');
      if (this.context.accountId && this.context.accountId !== accountId)
        throw new Error('订阅账号与原凭证不一致');
      this.context.accountId = accountId;
      this.context.email = info.user?.email || this.context.session?.user?.email;
      this.context.userId ||= info.user?.id;
      this.context.originalSubscription = selected.entitlement || {};
      if (selected.entitlement?.has_active_subscription)
        throw new Error('账号已有有效订阅，请先核对套餐，执行器未发起新付款');
      const homepage = await this.request('读取当前页面上下文', {
        method: 'GET',
        url: CHAT + '/',
        headers: { accept: 'text/html' },
      });
      const html = homepage.body;
      this.context.metadata = {
        build: /data-seq="([^"]+)"/.exec(html)?.[1] || /"clientBuildNumber"\s*:\s*"([^"]+)"/.exec(html)?.[1],
        version: /data-build="([^"]+)"/.exec(html)?.[1],
        attestation: /"webDeploymentAttestation"\s*:\s*"([^"]+)"/.exec(html)?.[1],
      };
      this.context.sentinel = await sentinelToken(this.context, (path, body, headers) =>
        this.chat('获取本单 Sentinel 上下文', path, body, headers),
      );
      await this.checkpoint('subscription_ready');
    }
  }
  private async reconcile() {
    if (this.context.challenge && this.assignment.run.challengeId) {
      const result = await this.command('verification', {
        action: 'result',
        body: { challengeId: this.assignment.run.challengeId },
      }).catch((error: Error) => {
        this.context.challenge!.expired = true;
        this.context.challenge!.error = error.message;
        return null;
      });
      if (
        result?.token &&
        this.context.intent?.client_secret &&
        !this.assignment.run.dispatches['challenge:' + this.assignment.run.challengeId]
      ) {
        const intent = this.context.intent;
        await this.command('authorize', { action: 'challenge:' + this.assignment.run.challengeId });
        await this.stripe('原挑战结果回交', '/v1/payment_intents/' + intent.id + '/verify_challenge', {
          key: this.context.key,
          client_secret: intent.client_secret,
          challenge_response_token: result.token,
          challenge_response_ekey: result.responseKey,
          captcha_vendor_name: 'hcaptcha',
        });
        this.verificationReceipt = {
          challengeId: this.assignment.run.challengeId,
          tokenHash: result.tokenHash,
          status: 'applied',
        };
      } else if (result?.verificationResult || result?.token) {
        this.verificationReceipt = {
          challengeId: this.assignment.run.challengeId,
          tokenHash: result.tokenHash,
          status: 'applied',
        };
      }
    }
    if (this.context.intent?.id && this.context.intent.client_secret && this.context.key) {
      const old = this.context.intent;
      const result = await this.stripe(
        '只读核对原付款',
        '/v1/payment_intents/' +
          old.id +
          '?' +
          form({ key: this.context.key, client_secret: old.client_secret }),
      );
      if (result.id !== old.id) throw new Error('付款查询返回了其他 Intent');
      this.context.intent = { ...result, client_secret: old.client_secret };
      if (this.verificationReceipt) {
        await this.command('verification', { action: 'receipt', body: this.verificationReceipt });
        delete this.context.challenge;
      }
      await this.handleIntent();
      return;
    }
    if (this.context.checkout?.id) {
      const checkout = this.context.checkout;
      const data = await this.chat(
        '只读核对原商户结账',
        '/backend-api/payments/checkout/' +
          encodeURIComponent(checkout.processor_entity) +
          '/' +
          encodeURIComponent(checkout.id),
      );
      const snapshot = data.checkout_session || data;
      const returnedId = snapshot.checkout_session_id || snapshot.id;
      if (returnedId && returnedId !== checkout.id) throw new Error('商户查询返回了其他结账');
      if (snapshot.processor_entity && snapshot.processor_entity !== checkout.processor_entity)
        throw new Error('商户查询处理方不匹配');
      if (
        snapshot.status === 'complete' &&
        snapshot.payment_status === 'paid' &&
        returnedId === checkout.id
      ) {
        await this.success();
        return;
      }
      if (snapshot.payment_intent?.client_secret) this.context.intent = snapshot.payment_intent;
    }
    await this.park('pending_confirmation', '原付款尚无明确结果，继续只读核对');
  }
  private async handleIntent() {
    const intent = this.context.intent!;
    if (intent.status === 'succeeded') {
      await this.success();
      return;
    }
    if (['requires_payment_method', 'canceled'].includes(intent.status)) {
      await this.command('finish', {
        status: 'failed',
        paymentOutcome: 'failed',
        context: this.context,
        error: intent.last_payment_error?.message || '原付款已明确失败',
      });
      return;
    }
    if (intent.status === 'requires_action') {
      if (this.assignment.run.executionExhausted) {
        await this.park('pending_confirmation', '执行重试次数已用完，后台继续核对原付款');
        return;
      }
      if (this.context.challenge?.expired) {
        await this.park(
          'pending_confirmation',
          '原客户验证已失效，保留原付款并继续核对；' + this.context.challenge.error,
        );
        return;
      }
      if (!this.context.challenge) {
        const next = intent.next_action || {};
        const source = {
          documentNonce: this.context.environment.id,
          widgetId: intent.id,
          revision: 1,
          url:
            CHAT + '/checkout/' + this.context.checkout!.processor_entity + '/' + this.context.checkout!.id,
          canApply: true,
          mode: 'stripe',
        };
        const response = await this.command('verification', {
          action: 'start',
          body: {
            kind: 'stripe',
            source,
            params: {
              paymentIntentId: intent.id,
              clientSecret: intent.client_secret,
              publishableKey: this.context.key,
              ...(this.context.snapshot?.stripe_account
                ? { stripeAccount: this.context.snapshot.stripe_account }
                : {}),
              status: 'requires_action',
            },
          },
        });
        this.context.challenge = { id: response.challenge?.challengeId, nextActionType: next.type };
        this.assignment.run.challengeId = response.challenge?.challengeId;
      }
      await this.park('awaiting_captcha', '等待客户完成原付款验证');
      return;
    }
    await this.park('pending_confirmation', '原付款状态：' + String(intent.status || 'unknown'));
  }
  private async park(status: string, error?: string) {
    await this.command('finish', { status, context: this.context, error });
  }
  private async success() {
    this.paid = true;
    await this.command('finish', { status: 'paid', context: this.context });
    if (!this.assignment.run.dispatches.registration) {
      try {
        await this.command('authorize', { action: 'registration' });
        await this.chat('原订阅完成登记', '/backend-api/payments/checkout_session', {
          stripe_checkout_session_id: this.context.checkout!.id,
          processor_entity: this.context.checkout!.processor_entity,
        });
      } catch (error) {
        await this.command('step', {
          step: { name: '原订阅完成登记', status: 'failed', error: (error as Error).message },
        });
      }
    }
    await this.cleanup();
  }
  private async cleanup() {
    const cleanup = (this.context.cleanup ||= {});
    const config = this.assignment.run.workflow.cleanup;
    const perform = async (name: string, enabled: boolean, action: () => Promise<void>) => {
      if (cleanup[name]?.status === 'succeeded') return;
      if (!enabled) {
        cleanup[name] = { status: 'skipped' };
        await this.log({
          name: '收尾 · ' + name,
          status: 'skipped',
          category: 'event',
          request: { enabled },
          response: { reason: '工作流未启用此收尾步骤' },
        });
        return;
      }
      try {
        await this.checkpoint('cleanup_' + name);
        await trace(this.log, '收尾 · ' + name, { enabled }, async (capture) => {
          await action();
          capture({ status: 'succeeded' });
        });
        cleanup[name] = { status: 'succeeded' };
      } catch (error) {
        cleanup[name] = { status: 'failed', error: String(redact((error as Error).message)) };
      }
    };
    await perform('refresh', config.refresh, async () => {
      if (!this.context.environment.cookies.some((c) => /session-token/.test(c.name)))
        throw new Error('本单缺少 Cookie／sessionToken，无法刷新最新 Session');
      const initial = await this.chat('读取当前 Session', '/api/auth/session', undefined, {
        'cache-control': 'no-cache',
      });
      let iat: string | undefined;
      try {
        iat = JSON.parse(
          Buffer.from(String(initial.accessToken).split('.')[1], 'base64url').toString(),
        ).iat?.toString();
      } catch {}
      const refreshed = await this.chat(
        '强制刷新最新 Session',
        '/api/auth/session?refresh=true&reason=token_expired&method=POST&path=%2Fbackend-api%2Fsubscriptions%2Fcancel',
        undefined,
        { 'cache-control': 'no-cache', ...(iat ? { 'x-openai-failed-access-token-iat': iat } : {}) },
      );
      verifySessionIdentity(this.context, refreshed);
      refreshed.accessToken ||= refreshed.access_token;
      const oldSession = this.context.session;
      this.context.session = refreshed;
      try {
        const accountInfo = await this.chat(
          '核验刷新后的原账号',
          '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
        );
        const accounts = Object.values(accountInfo.accounts || {}) as any[];
        if (
          this.context.accountId &&
          !accounts.some((a) => (a.account?.account_id || a.account?.id) === this.context.accountId)
        )
          throw new Error('刷新后的认证无法读取原账号');
        if (this.context.userId && accountInfo.user?.id && this.context.userId !== accountInfo.user.id)
          throw new Error('刷新后的认证属于其他用户');
        this.context.latestSession = JSON.stringify({
          ...refreshed,
          account: refreshed.account || { id: this.context.accountId },
          cookies: this.context.environment.cookies.filter((c) => /(?:^|\.)chatgpt\.com$/.test(c.domain)),
        });
      } catch (error) {
        this.context.session = oldSession;
        throw error;
      }
    });
    await perform('cancel', config.cancel, async () => {
      if (!this.context.accountId) throw new Error('缺少原 account_id');
      const current = await this.chat(
        '查询原订阅续费状态',
        '/backend-api/subscriptions?account_id=' + encodeURIComponent(this.context.accountId),
      );
      const subscription = current.subscription || current;
      if (subscription.will_renew !== false)
        await this.chat('取消原账号自动续费', '/backend-api/subscriptions/cancel', {
          account_id: this.context.accountId,
        });
      const check = await this.chat(
        '核验自动续费已取消',
        '/backend-api/subscriptions?account_id=' + encodeURIComponent(this.context.accountId),
      );
      if ((check.subscription || check).will_renew !== false)
        throw new Error('取消请求未取得已关闭续费的确认');
      this.context.renewalStatus = 'cancelled';
    });
    await perform('invoices', config.invoices, async () => {
      const result = await this.chat(
        '获取原账号账单',
        '/backend-api/invoices?limit=4&account_id=' + encodeURIComponent(this.context.accountId || ''),
      );
      const list: any[] = result.invoices || result.data || result.items || [];
      this.context.billingExternalUrls = list
        .map((x) => x.hosted_invoice_url || x.invoice_url || x.url)
        .filter((u: any) => {
          try {
            return ['https:', 'http:'].includes(new URL(u).protocol);
          } catch {
            return false;
          }
        })
        .slice(0, 20);
      if (!this.context.billingExternalUrls.length) throw new Error('账单尚未就绪');
    });
    await this.command('finish', { status: 'completed', context: this.context, cleanup });
  }
}
