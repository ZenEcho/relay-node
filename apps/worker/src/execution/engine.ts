import type { SentinelFlow, SentinelAuthorizer } from '../../../../packages/contracts/src/sentinel.js';
import type { ExecutionServices } from './services.js';
import { preflightExecution } from './preflight.js';
import { reconcilePayment } from './reconcile.js';
import { acknowledgeVerification } from './verification-receipt.js';
import { handlePaymentIntent } from './payment-intent.js';
import { cleanupExecution } from './cleanup.js';
import { UpstreamError, form } from './http-utils.js';
import { trace, auditError, auditRequest, type AuditEntry } from '../../../../packages/runtime/src/audit.js';
import { retryAfterMs } from '../../../../packages/rules/src/http.js';
import { randomUUID } from 'node:crypto';
import type { Assignment, Control } from '../runtime/controller.js';
import type { Transport, HttpInput } from '../transport/native.js';
import { loadCredential } from './credentials.js';
import { paymentPlan } from '../../../../packages/rules/src/plans.js';
import { billingPostalCodeOptional } from '../../../../packages/rules/src/billing.js';
import { authorizeSentinel } from './sentinel.js';
import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import type { StripeTokenProvider } from '../../../../packages/contracts/src/stripe.js';
import {
  executionOperation,
  throwIfExecutionAborted,
} from '../../../../packages/runtime/src/cancellation.js';
import {
  transportAttempt,
  transportAttempts,
  transportDiagnostic,
} from '../../../../packages/runtime/src/transport-diagnostics.js';
const CHAT = 'https://chatgpt.com',
  STRIPE = 'https://api.stripe.com';
const STRIPE_VERSION = '2025-03-31.basil';
export class ProtocolEngine {
  private context: RuntimeContext;
  private stage = 'preflight';
  private paid = false;
  constructor(
    private assignment: Assignment,
    private control: Control,
    private transport: Transport,
    private sentinelAuthorizer?: SentinelAuthorizer,
    private stripeTokenProvider?: StripeTokenProvider,
  ) {
    this.context = assignment.context;
  }
  private get services(): ExecutionServices {
    return {
      assignment: this.assignment,
      signal: this.control.signal,
      context: this.context,
      log: this.log,
      command: this.command.bind(this),
      checkpoint: this.checkpoint.bind(this),
      request: this.request.bind(this),
      chat: this.chat.bind(this),
      stripe: this.stripe.bind(this),
      requireSentinel: this.requireSentinel.bind(this),
      acknowledgeVerification: this.acknowledgeVerification.bind(this),
      handleIntent: this.handleIntent.bind(this),
      park: this.park.bind(this),
      success: this.success.bind(this),
    };
  }
  private async checkpoint(stage: string) {
    throwIfExecutionAborted(this.control.signal);
    this.stage = stage;
    this.context.phase = stage;
    await this.command('checkpoint', { context: this.context, stage });
  }
  private log = async (step: AuditEntry) => {
    if (this.control.signal?.aborted) return;
    await executionOperation(this.control.signal, () =>
      this.control.request('step', { step: { ...step, source: 'worker' } }),
    );
  };
  private async command(action: string, body: any = {}): Promise<any> {
    throwIfExecutionAborted(this.control.signal);
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
      {
        method: 'POST',
        path: `/api/worker/runs/${this.assignment.run.id}/${action}`,
        action,
        ...body,
      },
      async (capture) => {
        const result = await executionOperation(this.control.signal, () =>
          this.control.request(action, body),
        );
        capture(result);
        return result;
      },
    );
  }
  private async request(name: string, input: HttpInput) {
    throwIfExecutionAborted(this.control.signal);
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
        exitFingerprint: /^[a-f0-9]{12}$/.test(this.context.exitFingerprint || '')
          ? this.context.exitFingerprint
          : undefined,
        exitCountry: /^[A-Z]{2}$/.test(this.context.exitCountry || '') ? this.context.exitCountry : undefined,
        networkMode: environment.networkMode || (environment.proxyUrl ? 'proxy' : 'direct'),
        proxyUrl: environment.proxyUrl,
        cookieNames: environment.cookies.map((cookie) => cookie.name),
      }),
      async (capture) => {
        await this.assertActive();
        const origin = new URL(input.url).origin;
        const backoff = this.context.retryAfterByOrigin?.[origin];
        if (backoff && backoff > Date.now())
          throw new UpstreamError('上游仍在退避期限内，只保留原付款', 429, null);
        const output = await executionOperation(this.control.signal, () =>
          this.transport.request(input, {
            onAttempt: async (attempt) => {
              const event = transportAttempt(attempt);
              if (!event) return;
              await this.log({
                traceId: event.attemptId,
                name: '原生 HTTP 传输尝试',
                category: 'http',
                status:
                  event.outcome === 'running'
                    ? 'running'
                    : event.outcome === 'succeeded' && (!event.httpStatus || event.httpStatus < 400)
                      ? 'succeeded'
                      : 'failed',
                startedAt: event.startedAt,
                ...(event.completedAt
                  ? {
                      completedAt: event.completedAt,
                      durationMs: event.elapsedMs,
                    }
                  : {}),
                request: {
                  requestId: event.requestId,
                  attempt: event.attempt,
                  method: event.method,
                  targetHost: event.targetHost,
                },
                response: event,
                httpStatus: event.httpStatus,
                ...(event.errorCode
                  ? {
                      error: event.errorCode,
                      errorDetail: {
                        code: event.errorCode,
                        transportDiagnostic: event.diagnostic,
                        retryStopReason: event.retryStopReason,
                      },
                    }
                  : {}),
              });
              if (event.outcome === 'running') await this.assertActive();
            },
          }),
        );
        throwIfExecutionAborted(this.control.signal);
        capture(
          {
            status: output.status,
            headers: output.headers,
            body: output.data ?? output.body,
            diagnostic: transportDiagnostic(output.diagnostic),
            transportAttempts: transportAttempts(output.transportAttempts),
          },
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
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'x-openai-target-path': path.split('?')[0],
      'x-openai-target-route': path.startsWith('/backend-api/accounts/check/')
        ? '/backend-api/accounts/check/{version}'
        : path.startsWith('/backend-api/checkout_pricing_config/configs/')
          ? '/backend-api/checkout_pricing_config/configs/{country_code}'
          : path.split('?')[0],
      ...(c.session?.accessToken ? { authorization: 'Bearer ' + c.session.accessToken } : {}),
      ...(c.accountId ? { 'chatgpt-account-id': c.accountId } : {}),
      ...(c.sentinel ? { 'openai-sentinel-token': c.sentinel } : {}),
      ...(c.sentinelSo ? { 'openai-sentinel-so-token': c.sentinelSo } : {}),
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
          ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          origin: 'https://js.stripe.com',
          referer: 'https://js.stripe.com/',
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          dnt: '1',
        },
        body: body === undefined ? undefined : form(body),
      })
    ).data;
  }
  async execute() {
    const abort = () => this.transport.close();
    this.control.signal?.addEventListener('abort', abort, { once: true });
    try {
      throwIfExecutionAborted(this.control.signal);
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
          await executionOperation(this.control.signal, () =>
            this.transport.initialize(this.context.environment, this.control.signal),
          );
          capture({
            initialized: true,
            profile: this.context.environment.profile,
          });
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
        (!billing.postalCode && !billingPostalCodeOptional(billing.country)) ||
        (this.context.billingAddress
          ? billing.country !== (this.assignment.run.workflow.billingCountry || 'US') ||
            (billing.country === 'US' && !billing.state)
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
          billing_details: {
            country: this.context.environment.country,
            currency,
          },
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
        this.context.checkout = {
          id,
          processor_entity: result.processor_entity || 'openai_llc',
        };
        await this.checkpoint('checkout_created');
      }
      if (!this.context.snapshot) {
        await this.requireSentinel('chatgpt_checkout');
        const taxes = await this.chat('更新原结账税费', '/backend-api/payments/checkout/taxes', {
          checkout_session_id: this.context.checkout!.id,
          checkout_email: this.context.billingEmailBinding?.email || undefined,
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
        this.context.snapshot.amount_total ??= taxes.snapshot?.amount_total;
        this.context.snapshot.currency ??= taxes.snapshot?.currency;
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
      const amount =
        this.context.snapshot.amount_total ??
        this.context.snapshot.checkout_state?.total?.total?.minorUnitsAmount;
      const currency =
        this.context.snapshot.currency ||
        this.context.snapshot.checkout_state?.currency ||
        this.context.snapshot.billing_details?.currency ||
        this.context.currency;
      const returnedCheckoutId = this.context.snapshot.checkout_session_id || this.context.snapshot.id;
      if (
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        typeof currency !== 'string' ||
        currency.toUpperCase() !== this.context.currency ||
        (returnedCheckoutId && returnedCheckoutId !== this.context.checkout!.id)
      )
        throw new Error('原结账金额、币种或标识无法核验，停止准备卡片');
      this.context.snapshot.amount_total = amount;
      this.context.snapshot.currency = currency.toLowerCase();
      if (!this.context.elements) {
        this.context.clientSessionId ||= randomUUID();
        this.context.elements = await this.stripe(
          '初始化 Elements',
          '/v1/elements/sessions?' +
            form({
              key: this.context.key,
              customer_session_client_secret:
                this.context.customerSessionClientSecret ||
                this.context.snapshot.customer_session_client_secret,
              type: 'deferred_intent',
              'deferred_intent[mode]': 'subscription',
              'deferred_intent[amount]': this.context.snapshot.amount_total,
              'deferred_intent[currency]':
                this.context.snapshot.currency || this.context.currency.toLowerCase(),
              'deferred_intent[payment_method_types][0]': 'card',
            }),
        );
        const sessionId = this.context.elements?.session_id ?? this.context.elements?.id;
        if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Elements 响应缺少会话标识');
        if (
          this.context.elements.session_id &&
          this.context.elements.id &&
          this.context.elements.session_id !== this.context.elements.id
        )
          throw new Error('Elements 响应存在冲突的会话标识');
        this.context.elements.id = sessionId;
        await this.checkpoint('elements_ready');
      }
      if (!this.context.confirmationToken) {
        await this.checkpoint('card_preparation');
        await this.requireSentinel('chatgpt_checkout');
        const card = await this.command('card');
        try {
          if (this.stripeTokenProvider) {
            await this.assertActive();
            const lastFour = card.lastFour || String(card.number || '').slice(-4);
            if (!/^\d{4}$/.test(lastFour)) throw new Error('本次卡片尾号无效');
            const token = await executionOperation(this.control.signal, () =>
              this.stripeTokenProvider!(
                {
                  checkoutId: this.context.checkout!.id,
                  accountId: this.context.accountId!,
                  environmentId: this.context.environment.id,
                  deviceId: this.context.environment.deviceId,
                  publishableKey: this.context.key!,
                  customerSessionClientSecret: this.context.customerSessionClientSecret,
                  amountMinor: this.context.snapshot.amount_total,
                  currency: this.context.currency,
                  billing,
                  returnUrl: this.context.confirmReturnUrl || this.context.snapshot.return_url || CHAT + '/',
                  cardLastFour: lastFour,
                },
                card,
              ),
            );
            if (!/^ctoken_[a-zA-Z0-9]+$/.test(token?.id || '') || token.lastFour !== lastFour)
              throw new Error('官方 Stripe SDK 返回的令牌或卡片尾号不匹配');
            this.context.confirmationToken = token.id;
          } else {
            const number = String(card.number || '').replace(/[ -]/g, ''),
              cvc = String(card.cvc || ''),
              lastFour = card.lastFour || number.slice(-4);
            const expiry = String(card.expiry || '').match(/^(\d{1,2})\s*[\/-]\s*(\d{2}|\d{4})$/);
            if (
              !/^\d{13,19}$/.test(number) ||
              !/^\d{4}$/.test(lastFour) ||
              !number.endsWith(lastFour) ||
              !/^\d{3,4}$/.test(cvc) ||
              !expiry ||
              Number(expiry[1]) < 1 ||
              Number(expiry[1]) > 12
            )
              throw new Error('本单卡片资料不完整或卡片尾号不匹配');
            const month = expiry[1].padStart(2, '0'),
              year = expiry[2].length === 2 ? '20' + expiry[2] : expiry[2];
            const fields: Record<string, any> = {
              key: this.context.key,
              _stripe_version: STRIPE_VERSION,
              'payment_method_data[type]': 'card',
              'payment_method_data[guid]': this.context.environment.stripeIds.guid,
              'payment_method_data[muid]': this.context.environment.stripeIds.muid,
              'payment_method_data[sid]': this.context.environment.stripeIds.sid,
              'payment_method_data[card][number]': number,
              'payment_method_data[card][cvc]': cvc,
              'payment_method_data[card][exp_month]': month,
              'payment_method_data[card][exp_year]': year,
              'payment_method_data[allow_redisplay]': 'limited',
              'payment_method_data[billing_details][name]': billing.name,
              'payment_method_data[billing_details][email]':
                this.context.billingEmailBinding?.email || undefined,
              'payment_method_data[billing_details][phone]':
                typeof billing.phone === 'string' ? billing.phone.trim() || undefined : undefined,
              'payment_method_data[billing_details][address][line1]': billing.line1,
              'payment_method_data[billing_details][address][line2]': billing.line2,
              'payment_method_data[billing_details][address][city]': billing.city,
              'payment_method_data[billing_details][address][state]': billing.state,
              'payment_method_data[billing_details][address][postal_code]': billing.postalCode,
              'payment_method_data[billing_details][address][country]': billing.country,
              // Identify this HTTP client without claiming a Stripe.js session.
              'payment_method_data[payment_user_agent]': 'Relay/relay-node protocol API',
              'payment_method_data[referrer]': CHAT,
              'client_context[currency]': this.context.snapshot.currency,
              'client_context[mode]': this.context.snapshot.mode || 'subscription',
              'client_context[payment_method_types][0]': 'card',
              'client_context[customer]': this.context.snapshot.customer,
              setup_future_usage: 'off_session',
              set_as_default_payment_method: 'false',
            };
            // Link is advertised only when the original Elements response enables it.
            const orderedMethodTypes =
              this.context.elements.payment_method_preference?.ordered_payment_method_types;
            const availableMethodTypes = Array.isArray(orderedMethodTypes)
              ? orderedMethodTypes
              : this.context.elements.payment_method_types;
            if (Array.isArray(availableMethodTypes) && availableMethodTypes.includes('link'))
              fields['client_context[payment_method_types][1]'] = 'link';
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
            if (!/^ctoken_[a-zA-Z0-9]+$/.test(token?.id || '')) throw new Error('未取得 confirmation token');
            const preview = token.payment_method_preview;
            if (preview && (preview.type !== 'card' || preview.card?.last4 !== lastFour))
              throw new Error('Stripe API 返回的令牌或卡片尾号不匹配');
            this.context.confirmationToken = token.id;
          }
        } finally {
          card.number = '';
          card.cvc = '';
          card.expiry = '';
        }
        await this.checkpoint('confirmation_token_ready');
      }
      await this.requireSentinel('checkout_session_approval');
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
          await this.requireSentinel('checkout_session_approval');
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
      this.context.intent = {
        id: clientSecret.split('_secret_')[0],
        client_secret: clientSecret,
      };
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
      if (this.control.signal?.aborted || (error as any)?.code === 'EXECUTION_ABORTED') return;
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
      } else if (
        !this.assignment.run.paymentSubmitted &&
        (error as any).code === 'OFFICIAL_SDK_AUTH_REQUIRED'
      ) {
        this.context.officialAuthorizationRequired = true;
        await this.command('finish', {
          status: 'paused',
          context: this.context,
          error: e.message,
        });
      } else if ((error as any).code === 'CARD_PENDING') {
        this.context.resourceWait = true;
        await this.command('finish', {
          status: 'paused',
          context: this.context,
          error: e.message,
        });
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
      this.control.signal?.removeEventListener('abort', abort);
      this.transport.close();
      if (!this.control.signal?.aborted)
        await this.log({
          name: '关闭订单传输会话',
          status: 'succeeded',
          category: 'event',
          response: { environmentId: this.context.environment.id, closed: true },
        }).catch((error) => {
          if (!this.control.signal?.aborted) throw error;
        });
    }
  }
  private async preflight() {
    return preflightExecution(this.services);
  }
  private async requireSentinel(flow: SentinelFlow) {
    await this.checkpoint('sentinel_authorization');
    // The configured adapter uses this order's identity and environment.
    // Merchant requests keep their own checkout referer in headers().
    const pageUrl = CHAT + '/';
    // Demo credentials exist only in the isolated mock transport. Production
    // must supply the configured Sentinel runtime adapter.
    const authorize: SentinelAuthorizer | undefined =
      this.sentinelAuthorizer ||
      (this.assignment.demo
        ? (input) => this.chat('模拟 Sentinel 授权', '/backend-api/sentinel/req', input)
        : undefined);
    await trace(this.log, '取得本单 Sentinel 授权', { flow, pageUrl }, async (capture) => {
      await this.assertActive();
      await executionOperation(this.control.signal, () =>
        authorizeSentinel(this.context, flow, pageUrl, authorize, this.control.signal),
      );
      capture({
        flow,
        expiresAt: this.context.sentinelExpiresAt,
        token: this.context.sentinel,
        soToken: this.context.sentinelSo,
      });
    });
    await this.checkpoint('sentinel_ready');
  }
  private async reconcile() {
    return executionOperation(this.control.signal, () => reconcilePayment(this.services));
  }
  private async assertActive() {
    throwIfExecutionAborted(this.control.signal);
    if (this.control.assertActive)
      await executionOperation(this.control.signal, () => this.control.assertActive!());
    throwIfExecutionAborted(this.control.signal);
  }
  private async acknowledgeVerification() {
    return executionOperation(this.control.signal, () => acknowledgeVerification(this.services));
  }
  private async handleIntent() {
    return executionOperation(this.control.signal, () => handlePaymentIntent(this.services));
  }
  private async park(status: string, error?: string) {
    throwIfExecutionAborted(this.control.signal);
    await this.command('finish', { status, context: this.context, error });
  }
  private async success() {
    throwIfExecutionAborted(this.control.signal);
    this.paid = true;
    await this.command('finish', { status: 'paid', context: this.context });
    await this.cleanup();
  }
  private async cleanup() {
    return executionOperation(this.control.signal, () => cleanupExecution(this.services));
  }
}
