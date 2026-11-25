import {
  hostedPublishableKey,
  referenceHostedKey,
  prepareHostedCheckout,
  submitHostedCheckout,
} from './hosted-checkout.js';
import type { SentinelFlow, SentinelAuthorizer } from '../../../../packages/contracts/src/sentinel.js';
import type { ExecutionServices } from './services.js';
import { preflightExecution, sampleExecutionEgress } from './preflight.js';
import { egressProbeUrls } from '../../../../packages/runtime/src/egress.js';
import { reconcilePayment } from './reconcile.js';
import { acknowledgeVerification } from './verification-receipt.js';
import { handlePaymentIntent } from './payment-intent.js';
import { paymentIntentFromResponse } from './intent-binding.js';
import {
  adoptCheckoutMode,
  checkoutModeFromId,
  isCheckoutModeRejection,
  modeFallbackBlocked,
  zeroAmountRequiresCustom,
  type CheckoutMode,
} from './checkout-mode.js';
import { cleanupExecution } from './cleanup.js';
import { UpstreamError, form } from './http-utils.js';
import { stripeIntegrationError } from './stripe-response.js';
import { trace, auditError, auditRequest, type AuditEntry } from '../../../../packages/runtime/src/audit.js';
import { retryAfterMs } from '../../../../packages/rules/src/http.js';
import { bindStripeCheckoutConfiguration } from './stripe-configuration.js';
import { randomInt, randomUUID } from 'node:crypto';
import type { Assignment, Control } from '../runtime/controller.js';
import { NativeTransportError, type Transport, type HttpInput } from '../transport/native.js';
import { loadCredential } from './credentials.js';
import { isExpiredAccessToken, refreshExpiredAccessToken } from './session-refresh.js';
import { paymentPlan } from '../../../../packages/rules/src/plans.js';
import { billingPostalCodeOptional } from '../../../../packages/rules/src/billing.js';
import { issueStripeDevice } from './stripe-device.js';
import { authorizeSentinel, consumeSentinel, type SentinelGrant } from './sentinel.js';
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
const STRIPE_VERSION =
  '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
// Compatibility metadata from oa-pay-protocol-go; tokenization remains HTTP.
const STRIPE_JS_VERSIONS = ['628eb3cacd', 'a44b454c', 'd21f1cd6', '9c1e8d52', 'f7a3b211', '692f102a8f'];
// Exit probes are diagnostics; a dead endpoint must not burn the order's time.
const EGRESS_PROBE_BUDGET_MS = 6000;
const EGRESS_PROBE_RETRY_DELAYS = [500, 1000] as const;
const sentinelWrites: Record<string, SentinelFlow> = {
  '/backend-api/payments/checkout': 'chatgpt_checkout',
  '/backend-api/payments/checkout/taxes': 'chatgpt_checkout',
  '/backend-api/payments/checkout/confirm': 'checkout_session_approval',
  '/backend-api/payments/checkout/approve': 'checkout_session_approval',
};
/** An authorization blip is retried; an explicit refusal or abort is not. */
function retryableAuthorize(error: unknown) {
  const e = error as {
    code?: string;
    status?: number;
    statusCode?: number;
    httpResponse?: { status?: number };
  };
  if (e?.code === 'EXECUTION_ABORTED') return false;
  const status = e?.status || e?.statusCode || e?.httpResponse?.status || 0;
  return status === 0 || status === 429 || status >= 500;
}
// A guard that no retry can satisfy: report it once with retryable=false so the
// console stops the order instead of replaying the same checkout.
function terminal(message: string) {
  const error = new Error(message);
  (error as any).retryable = false;
  return error;
}

export class ProtocolEngine {
  private context: RuntimeContext;
  private stage = 'preflight';
  private paid = false;
  private accessTokenRefreshAttempted = false;
  constructor(
    private assignment: Assignment,
    private control: Control,
    private transport: Transport,
    private sentinelAuthorizer?: SentinelAuthorizer,
    private stripeTokenProvider?: StripeTokenProvider,
    private browserCleanupChat?: ExecutionServices['cleanupChat'],
    private probeTransport?: () => Transport,
  ) {
    this.context = assignment.context;
    this.stage = assignment.mode === 'reconcile'
      ? 'stripe_result'
      : assignment.mode === 'cleanup'
        ? 'post_payment'
        : this.context.phase || 'preflight';
  }
  private get services(): ExecutionServices {
    return {
      assignment: this.assignment,
      signal: this.control.signal,
      context: this.context,
      log: this.log,
      ...(this.probeTransport ? { probeRequest: this.probeRequest.bind(this) } : {}),
      command: this.command.bind(this),
      setStage: this.setStage.bind(this),
      checkpoint: this.checkpoint.bind(this),
      request: this.request.bind(this),
      chat: this.chat.bind(this),
      cleanupChat: this.browserCleanupChat
        ? (name, path, body, headers) => {
            const request = auditRequest({
              method: body ? 'POST' : 'GET', url: CHAT + path,
              body: body ? JSON.stringify(body) : undefined,
              transport: 'browser',
            });
            return trace(this.log, name, request, async (capture) => {
              await this.assertActive();
              let observed = false;
              const data = await executionOperation(this.control.signal, () =>
                this.browserCleanupChat!(name, path, body, headers, (exchange) => {
                  observed = true;
                  Object.assign(request, auditRequest(exchange.request));
                  capture(exchange.networkFailure
                    ? { received: false, reason: '未收到响应' }
                    : { status: exchange.status, headers: exchange.headers, body: exchange.data ?? exchange.body, ...(exchange.partial ? { partial: true } : {}) }, exchange.status);
                }),
              );
              if (!observed) capture(data);
              return data;
            }, 'http');
          }
        : undefined,
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
    this.setStage(stage);
    // The console audits committed checkpoints. Keep the order path free of a second copy.
    await executionOperation(this.control.signal, () =>
      this.control.request('checkpoint', { context: this.context, stage }),
    );
  }
  private setStage(stage: string) {
    this.stage = stage;
    this.context.phase = stage;
  }
  private log = async (step: AuditEntry) => {
    if (this.control.signal?.aborted) return;
    // Receipts stay buffered until the run leaves this machine, so stamp the
    // real event time here: the console orders the timeline by it, not by upload.
    const at = step.startedAt || new Date().toISOString();
    await executionOperation(this.control.signal, () =>
      this.control.request('step', {
        step: {
          ...step,
          startedAt: at,
          ...(step.completedAt || step.status === 'running' ? {} : { completedAt: at }),
          request: { stage: this.stage, ...(step.request as object) },
          source: 'worker',
        },
      }),
    );
  };
  private async command(action: string, body: any = {}): Promise<any> {
    throwIfExecutionAborted(this.control.signal);
    if (action === 'step') return this.control.request(action, body);
    const names: Record<string, string> = {
      card: '请求付款卡片',
      authorize: '请求付款派发授权',
      verification: '客户验证协调',
      finish: '提交执行结果',
    };
    const send = () =>
      trace(
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
          if (action === 'authorize' && ['merchant_confirm', 'merchant_approve', 'stripe_confirm', 'registration'].includes(body.action)) {
            this.assignment.run.dispatches[body.action] ||= new Date().toISOString();
            if (body.action !== 'registration') this.assignment.run.paymentSubmitted = true;
          }
          capture(result);
          return result;
        },
      );
    // The console records a dispatch before answering, so replaying authorize is
    // safe. A single CDK/console blip must not abandon an already-created intent.
    if (action !== 'authorize') return send();
    for (let attempt = 1; ; attempt++) {
      try {
        return await send();
      } catch (error) {
        if (attempt >= 3 || !retryableAuthorize(error) || this.control.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 1000 : 3000));
        throwIfExecutionAborted(this.control.signal);
      }
    }
  }
  private request(name: string, input: HttpInput, grant?: SentinelGrant) {
    return this.requestOn(this.transport, name, input, grant);
  }
  /** Secondary exit probe: its own short-lived transport keeps the task's queue free. */
  private async probeRequest(input: HttpInput) {
    const factory = this.probeTransport;
    if (!factory) throw new Error('缺少并发出口探测传输');
    const transport = factory();
    try {
      await transport.initialize(this.context.environment, this.control.signal);
      return await this.requestOn(transport, '检查备用出口', input);
    } finally {
      transport.close();
    }
  }
  private async requestOn(
    transport: Transport,
    name: string,
    input: HttpInput,
    grant?: SentinelGrant,
  ) {
    throwIfExecutionAborted(this.control.signal);
    const environment = this.context.environment;
    const egressProbe = input.url === egressProbeUrls.primary || input.url === egressProbeUrls.fallback;
    return trace(
      this.log,
      name,
      auditRequest({
        ...input,
        ...(grant ? { grantId: grant.id, flow: grant.flow } : {}),
        headers: { ...environment.headers, ...input.headers },
        environmentId: environment.id,
        checkoutMode: this.context.checkoutMode || this.assignment.run.workflow?.checkoutMode || 'custom',
        profile: environment.profile,
        country: environment.country,
        ...(this.context.exitProbe
          ? {
              exitProbe: this.context.exitProbe,
              exitFingerprint: this.context.exitFingerprint,
              exitCountry: this.context.exitCountry,
            }
          : {}),
        networkMode: environment.networkMode || (environment.proxyUrl ? 'proxy' : 'direct'),
        proxyUrl: environment.proxyUrl,
        cookieNames: environment.cookies.map((cookie) => cookie.name),
      }),
      async (capture) => {
        await this.assertActive();
        const { origin, pathname } = new URL(input.url);
        const backoff = this.context.retryAfterByOrigin?.[origin];
        if (backoff && backoff > Date.now())
          throw new UpstreamError('上游仍在退避期限内，只保留原付款', 429, null);
        // The controller/audit round trip may outlive or invalidate a grant.
        grant?.assertValid();
        const output = await executionOperation(this.control.signal, () =>
          transport.request(input, {
            ...(egressProbe
              ? {
                  retryBudgetMs: EGRESS_PROBE_BUDGET_MS,
                  retryDelaysMs: EGRESS_PROBE_RETRY_DELAYS,
                }
              : {}),
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
              if (event.outcome === 'running') {
                // The first attempt was checked immediately before transport dispatch.
                // A retry needs a fresh check after its backoff.
                if (event.attempt > 1) await this.assertActive();
                grant?.assertValid();
              }
            },
          }),
        );
        throwIfExecutionAborted(this.control.signal);
        const integrationFailure = origin === STRIPE ? stripeIntegrationError(pathname, input.method, output) : undefined;
        capture(
          {
            status: output.status,
            ...(egressProbe
              ? {}
              : integrationFailure
                ? { stripe: integrationFailure.response }
                : { headers: output.headers, body: output.data ?? output.body }),
            diagnostic: transportDiagnostic(output.diagnostic),
            transportAttempts: transportAttempts(output.transportAttempts),
          },
          output.status,
        );
        const retryHeader = Object.entries(output.headers).find(
          ([key]) => key.toLowerCase() === 'retry-after',
        )?.[1]?.[0];
        const delay = retryAfterMs(retryHeader);
        if (!egressProbe && output.status >= 400 && delay) {
          this.context.retryAfterByOrigin ||= {};
          this.context.retryAfterByOrigin[origin] = Date.now() + delay;
          this.context.retryAfterAt = Math.max(
            ...(Object.values(this.context.retryAfterByOrigin) as number[]),
          );
        }
        if (integrationFailure) throw integrationFailure;
        if (output.status < 200 || output.status >= 300) {
          const message = egressProbe
            ? name
            : output.data?.error?.message || output.data?.detail || output.data?.message || name;
          throw new UpstreamError(`HTTP ${output.status}：${message}`, output.status, output.data);
        }
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
      ...(c.session?.accessToken && path.split('?')[0] !== '/api/auth/session'
        ? { authorization: 'Bearer ' + c.session.accessToken }
        : {}),
      ...(c.accountId ? { 'chatgpt-account-id': c.accountId } : {}),
      ...(c.metadata?.attestation ? { 'oai-web-deployment-attestation': c.metadata.attestation } : {}),
      ...(c.metadata?.build ? { 'oai-client-build-number': c.metadata.build } : {}),
      ...(c.metadata?.version ? { 'oai-client-version': c.metadata.version } : {}),
    };
  }
  private async chat(name: string, path: string, body?: any, extra?: Record<string, string>) {
    try {
      return await this.rawChat(name, path, body, extra);
    } catch (error) {
      // Recover a read before payment once. Never replay checkout or payment writes.
      if (
        body !== undefined ||
        !path.startsWith('/backend-api/') ||
        this.assignment.mode !== 'execute' ||
        this.paid ||
        this.assignment.run.paymentSubmitted ||
        this.accessTokenRefreshAttempted ||
        !isExpiredAccessToken(error)
      )
        throw error;
      this.accessTokenRefreshAttempted = true;
      await refreshExpiredAccessToken(
        this.context,
        this.services.cleanupChat || this.rawChat.bind(this),
        path,
        this.control.signal,
      );
      await executionOperation(this.control.signal, () =>
        this.transport.initialize(this.context.environment, this.control.signal),
      );
      await this.checkpoint(this.stage);
      return this.rawChat(name, path, body, extra);
    }
  }
  private async rawChat(name: string, path: string, body?: any, extra?: Record<string, string>) {
    const flow = body === undefined ? undefined : sentinelWrites[path.split('?')[0]];
    const grant = flow ? consumeSentinel(this.context, flow) : undefined;
    return (
      await this.request(name, {
        method: body === undefined ? 'GET' : 'POST',
        url: CHAT + path,
        headers: { ...this.headers(path), ...extra, ...grant?.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, grant)
    ).data;
  }
  private async createCheckout(requested: CheckoutMode, currency: string) {
    const body = (mode: CheckoutMode) => ({
      plan_name: paymentPlan(this.assignment.run.workflow.plan).planName,
      billing_details: { country: this.context.environment.country, currency },
      ...(mode === 'hosted'
        ? { checkout_ui_mode: 'hosted', cancel_url: CHAT + '/#pricing' }
        : {
            entry_point: 'all_plans_pricing_modal',
            checkout_ui_mode: 'custom',
            processor_entity: 'openai_llc',
          }),
    });
    let result: any;
    let attempted: CheckoutMode = requested;
    try {
      result = await this.chat('创建支付链接', '/backend-api/payments/checkout', body(requested));
    } catch (error) {
      // 官方只允许另一种模式时，换一次再试；其它失败保持原样抛出。
      if (!isCheckoutModeRejection(error)) throw error;
      attempted = requested === 'custom' ? 'hosted' : 'custom';
      await this.log({
        name: '支付链接模式互备 · ' + attempted,
        category: 'event',
        status: 'succeeded',
        response: { attempted: requested, fallback: attempted },
      });
      result = await this.chat('创建支付链接', '/backend-api/payments/checkout', body(attempted));
    }
    const candidates = [
      result.internal_checkout_session_id,
      result.internalCheckoutSessionId,
      result.checkout_session?.id,
      result.checkout_session_id,
      result.checkoutSessionId,
    ].filter((value): value is string => typeof value === 'string');
    // 只把带前缀的会话交给采纳逻辑：hosted 回包的 checkout_ui_mode 可能是旧标签，
    // 前缀才是 Stripe 确认接口认的真相。
    const adopted = adoptCheckoutMode(
      attempted,
      result.checkout_ui_mode,
      candidates.find((value) => checkoutModeFromId(value)),
    );
    const prefix = adopted.mode === 'hosted' ? 'cs_' : 'oaics_';
    const id = candidates.find((value) => value.startsWith(prefix));
    if (!id || !/^(oaics_|cs_(?:live_|test_))[a-zA-Z0-9_]+$/.test(id))
      throw new Error('返回的支付链接与官方结账模式 ' + adopted.mode + ' 不匹配');
    return { id, result, mode: adopted.mode, official: adopted.official || attempted !== requested };
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
          ...(this.context.snapshot?.stripe_account
            ? { 'Stripe-Account': this.context.snapshot.stripe_account }
            : {}),
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
      // A checkpoint may have been produced by another execution or node.
      delete this.context.exitProbe;
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
        await sampleExecutionEgress(this.services);
        await this.cleanup();
        return;
      }
      bindStripeCheckoutConfiguration(this.context);
      if (this.assignment.mode === 'reconcile' || this.assignment.run.paymentSubmitted) {
        await sampleExecutionEgress(this.services);
        await this.reconcile();
        return;
      }
      if (this.context.checkoutResume) {
        this.setStage('card_replacement');
        await sampleExecutionEgress(this.services);
        if (!(await this.verifyResumedCheckout())) return;
      } else await this.preflight();
      if (!this.assignment.paymentEnabled && !this.assignment.demo)
        throw new Error('真实付款未启用：请检查服务端 COMMIT_PAYMENTS 配置');
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
        this.setStage('checkout');
        const explicitCurrency = this.assignment.run.order.cdkPaymentCurrency;
        const currency =
          explicitCurrency && explicitCurrency !== '-'
            ? explicitCurrency.toUpperCase()
            : (await this.chat(
                '读取地区币种',
                '/backend-api/checkout_pricing_config/configs/' + this.context.environment.country,
              ))?.currency_config?.symbol_code;
        if (!currency) throw new Error('报价接口未返回地区币种');
        if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
          throw new Error('结账币种必须为三位大写货币代码');
        this.context.currency = currency;
        // Pricing is an unprotected read. Obtain a separate grant only after
        // all reads, then scope it to this single checkout write.
        await this.requireSentinel('chatgpt_checkout');
        this.setStage('checkout');
        // 官方建单接口决定这个账号能用哪种结账模式：我们只提交偏好，响应里的
        // checkout_ui_mode（或会话前缀）才是本单真实模式。
        const requested: CheckoutMode =
          this.assignment.run.workflow.checkoutMode === 'hosted' ? 'hosted' : 'custom';
        const created = await this.createCheckout(requested, currency);
        if (
          modeFallbackBlocked(created.mode, this.assignment.run.workflow.checkoutModeFallbackFrom)
        )
          // 重开还是被钉回拒付过的模式，再试只会重复同一个失败：直接终结。
          throw terminal(
            '官方固定使用 ' +
              created.mode +
              ' 结账，本单已在该模式下拒付，模式互备没有可用分支',
          );
        this.context.checkoutMode = created.mode;
        if (created.official) this.context.officialCheckoutMode = created.mode;
        this.context.checkout = {
          id: created.id,
          processor_entity: created.result.processor_entity || 'openai_llc',
          ...(created.mode === 'hosted'
            ? {
                url:
                  created.result.url ||
                  created.result.checkout_url ||
                  created.result.checkout_session?.url,
              }
            : {}),
        };
        // Preserve the original response's configuration across checkpoints;
        // subsequent tax snapshots may omit these optional fields.
        this.context.confirmReturnUrl = created.result.confirm_return_url;
        this.context.customerSessionClientSecret ||= created.result.customer_session_client_secret;
        bindStripeCheckoutConfiguration(this.context, created.result);
      }
      this.context.checkoutMode ||= this.context.checkout!.id.startsWith('cs_') ? 'hosted' : 'custom';
      if (!this.context.checkoutTypeLogged) {
        await this.log({
          name:
            '支付链接类型 · ' +
            this.context.checkoutMode +
            (this.context.officialCheckoutMode ? '（官方指定）' : ''),
          category: 'event',
          status: 'succeeded',
          response: {
            checkoutMode: this.context.checkoutMode,
            checkoutId: this.context.checkout!.id,
            official: Boolean(this.context.officialCheckoutMode),
          },
        });
        this.context.checkoutTypeLogged = true;
        await this.checkpoint('checkout_created');
      }
      const taxesNeeded = !this.context.snapshot;
      if (taxesNeeded) {
        await this.requireSentinel('chatgpt_checkout');
        const taxes = await this.chat('更新原结账税费', '/backend-api/payments/checkout/taxes', {
          checkout_session_id: this.context.checkout!.id,
          checkout_email: this.context.billingEmailBinding?.email || undefined,
          // 计税地区跟建单地区（order.cdkPaymentCountry）走，不受账单地址所在国影响：
          // php 单就按 PH 查税，billing_address 仍是卡片的真实账单地址。
          billing_country: this.context.environment.country,
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
        this.context.confirmReturnUrl =
          this.context.snapshot.confirm_return_url || taxes.confirm_return_url || this.context.confirmReturnUrl;
        this.context.customerSessionClientSecret ||= this.context.snapshot.customer_session_client_secret;
        this.context.snapshot.amount_total ??= taxes.snapshot?.amount_total;
        this.context.snapshot.currency ??= taxes.snapshot?.currency;
        if (this.context.snapshot.id && this.context.snapshot.id !== this.context.checkout!.id)
          throw new Error('计税响应属于其他结账');
        if (
          this.context.snapshot.processor_entity &&
          this.context.snapshot.processor_entity !== this.context.checkout!.processor_entity
        )
          throw new Error('计税响应处理方不匹配');
      }
      const hosted = this.context.checkoutMode === 'hosted';
      bindStripeCheckoutConfiguration(
        this.context,
        this.context.snapshot,
        hosted
          ? hostedPublishableKey(
              this.context.snapshot.url || this.context.checkout!.url,
              this.context.checkout!.id,
            ) || referenceHostedKey
          : undefined,
      );
      if (!this.context.key && taxesNeeded) {
        const configuration = await this.chat('读取付款组件配置', '/backend-api/payments/stripe_client_bootstrap', {});
        bindStripeCheckoutConfiguration(this.context, this.context.snapshot, configuration.publishable_key);
      }
      if (!this.context.key) throw new Error('原结账缺少 Stripe publishable key');
      if (taxesNeeded) await this.checkpoint('taxes_ready');
      // Older checkpoints may carry these only on the checkout snapshot.
      this.context.confirmReturnUrl ||= this.context.snapshot.confirm_return_url;
      this.context.customerSessionClientSecret ||= this.context.snapshot.customer_session_client_secret;
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
      // 零元结账必须落在 custom（oaics_）支付页上：官方 hosted 页面按正常价
      // 收单，0 元优惠不会生效。这里以官方金额为准判断，0 元却在 hosted 就停。
      const effectiveMode: CheckoutMode =
        this.context.checkoutMode === 'hosted' ? 'hosted' : 'custom';
      if (zeroAmountRequiresCustom(effectiveMode, amount))
        // 0 元单在 hosted 上会按正常价收单，重试同一个模式不会变好：终结等人工核对。
        throw terminal(
          '零元结账必须使用 custom（oaics_）支付页，当前是 ' +
            effectiveMode +
            '，已停止准备卡片',
        );
      if (hosted) await prepareHostedCheckout(this.services);
      if (!this.context.elements && !this.stripeTokenProvider) {
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
        this.setStage('card_preparation');
        // Register the device on the exit that carries the payment, immediately
        // before the first Stripe write that names it.
        await issueStripeDevice(this.services);
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
                  stripeAccount: this.context.snapshot.stripe_account,
                  customerSessionClientSecret:
                    this.context.customerSessionClientSecret ||
                    this.context.snapshot.customer_session_client_secret,
                  amountMinor: this.context.snapshot.amount_total,
                  currency: this.context.currency,
                  billing: {
                    ...billing,
                    email: this.context.billingEmailBinding?.email,
                  },
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
            const jsVersion = STRIPE_JS_VERSIONS[randomInt(STRIPE_JS_VERSIONS.length)];
            const device = this.context.stripeDevice || this.context.environment.stripeIds;
            const fields: Record<string, any> = {
              key: this.context.key,
              _stripe_version: STRIPE_VERSION,
              'payment_method_data[type]': 'card',
              'payment_method_data[guid]': device.guid,
              'payment_method_data[muid]': device.muid,
              'payment_method_data[sid]': device.sid,
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
              'payment_method_data[pasted_fields]': 'number',
              'payment_method_data[payment_user_agent]': `stripe.js/${jsVersion}; stripe-js-v3/${jsVersion}; payment-element; deferred-intent`,
              'payment_method_data[time_on_page]': randomInt(8000, 30001),
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
      if (this.context.checkoutMode === 'hosted') {
        await submitHostedCheckout(this.services);
        return;
      }
      if (this.context.checkoutResume?.intentId) {
        await this.confirmOriginalIntent();
        return;
      }
      await this.requireSentinel('checkout_session_approval');
      this.setStage('merchant_confirm');
      await this.command('authorize', { action: 'merchant_confirm' });
      this.assignment.run.paymentSubmitted = true;
      let confirm;
      try {
        confirm = await this.chat('商户付款确认', '/backend-api/payments/checkout/confirm', {
          checkout_session_id: this.context.checkout!.id,
          confirm_token: this.context.confirmationToken,
          selected_payment_method_type: 'card',
        });
      } catch (error) {
        // Only this explicit merchant refusal is terminal. Generic 403s, lost
        // responses and any evidence of an Intent still require reconciliation.
        if (
          error instanceof UpstreamError &&
          error.status === 403 &&
          error.data?.detail === 'Checkout is not available in your region.' &&
          !this.context.intent &&
          !error.data.payment_intent &&
          !error.data.client_secret &&
          !error.data.error?.payment_intent &&
          Object.keys(this.assignment.run.dispatches).every((action) => action === 'merchant_confirm')
        ) {
          this.context.merchantConfirmation = {
            status: 'checkout_region_unavailable',
          };
          await this.command('finish', {
            status: 'failed',
            paymentOutcome: 'failed',
            context: this.context,
            error: error.message,
          });
          return;
        }
        throw error;
      }
      this.context.merchantConfirmation = confirm;
      const observedIntent = paymentIntentFromResponse(confirm, this.context.intent);
      if (observedIntent) {
        this.context.intent = observedIntent;
        if (observedIntent.status && observedIntent.status !== 'requires_confirmation' && observedIntent.client_secret) {
          await this.checkpoint('merchant_intent_ready');
          await this.reconcile();
          return;
        }
      }
      // A known refusal can be resolved through read-only original-payment checks.
      if (confirm.status === 'subscription_limit' && !confirm.client_secret && !confirm.payment_intent) {
        // Match the observed PH chain: verify the original checkout and
        // account before releasing the card or allowing another attempt.
        await this.reconcile();
        return;
      }
      if (confirm.error || confirm.success === false || confirm.status !== 'success')
        throw new Error(
          '商户确认未成功：' + String(confirm.status || confirm.error?.message || '响应缺少状态'),
        );
      let clientSecret = observedIntent?.client_secret;
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
        this.setStage('merchant_result_pending');
        await this.park('pending_confirmation', '商户请求已派发，尚未取得可核对的原 Intent');
        return;
      }
      this.context.intent = {
        id: clientSecret.split('_secret_')[0],
        client_secret: clientSecret,
      };
      await this.checkpoint('intent_ready');
      await this.confirmOriginalIntent();
    } catch (error) {
      if (this.control.signal?.aborted || (error as any)?.code === 'EXECUTION_ABORTED') return;
      const e = error as Error;
      const retryHints = [(error as any)?.retryable, (error as any)?.runtimeDiagnostic?.retryable];
      const failureRetryable = retryHints.includes(false)
        ? false
        : retryHints.includes(true)
          ? true
          : undefined;
      if (
        this.context.environment.proxyUrl &&
        error instanceof NativeTransportError &&
        /^(?:PROXY_|UPSTREAM_(?:TIMEOUT|DNS_FAILED|CONNECTION_FAILED|TLS_FAILED|CONNECTION_CLOSED|TRANSPORT_FAILED)$|NATIVE_TRANSPORT_TIMEOUT$)/.test(
          error.code,
        )
      )
        this.context.proxyConnectionFailed = true;
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
        let intent;
        try {
          if (this.assignment.run.paymentSubmitted && error instanceof UpstreamError)
            intent = paymentIntentFromResponse(error.data, this.context.intent);
          if (intent) this.context.intent = intent;
          if (intent?.status === 'requires_action' && intent.client_secret && this.context.key) {
            await this.checkpoint('verification_intent_recovered');
            await this.reconcile();
            return;
          }
        } catch (recoveryError) {
          intent = undefined;
          await this.log({ name: '原付款验证恢复待核对', status: 'pending', error: (recoveryError as Error).message });
        }
        const declined =
          intent?.status === 'requires_payment_method' &&
          Boolean(intent.last_payment_error || (error instanceof UpstreamError && error.status === 402));
        if (declined) this.context.intent = intent;
        await this.command('finish', {
          // 付款已提交但 Stripe 明确拒绝这次提交（未创建 PaymentIntent）时直接失败，
          // 不要挂在待确认上等一个不会出现的付款；其它提交后的错误仍按结果未知处理。
          status:
            this.assignment.run.paymentSubmitted &&
            !declined &&
            (error as any).paymentRejected !== true
              ? 'pending_confirmation'
              : 'failed',
          paymentOutcome: declined ? 'failed' : undefined,
          context: this.context,
          error: e.message,
          failureRetryable,
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
          response: {
            environmentId: this.context.environment.id,
            closed: true,
          },
        }).catch((error) => {
          if (!this.control.signal?.aborted) throw error;
        });
    }
  }
  private async preflight() {
    return preflightExecution(this.services);
  }
  private async requireSentinel(flow: SentinelFlow) {
    // Authorization is a step within its business phase, not a return to preflight.
    const prefix =
      flow === 'checkout_session_approval' ? 'payment_' : this.context.checkout ? 'checkout_' : '';
    this.setStage(prefix + 'sentinel_authorization');
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
    const environment = this.context.environment;
    await trace(
      this.log,
      '取得本单 Sentinel 授权',
      {
        flow,
        observerFlow: 'chatgpt_checkout',
        pageUrl,
        deviceId: environment.deviceId,
        accountId: this.context.accountId,
        environmentId: environment.id,
        profile: environment.profile,
        networkMode: environment.proxyUrl ? 'proxy' : 'direct',
        proxyUrl: environment.proxyUrl,
      },
      async (capture) => {
        await this.assertActive();
        const diagnostic = await executionOperation(this.control.signal, () =>
          authorizeSentinel(this.context, flow, pageUrl, authorize, this.control.signal),
        );
        capture({
          flow,
          ...diagnostic,
          expiresAt: this.context.sentinelExpiresAt,
          token: this.context.sentinel,
          soToken: this.context.sentinelSo,
        });
      },
    );
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
  private async verifyResumedCheckout() {
    const resume = this.context.checkoutResume!;
    if (
      !this.context.checkout || resume.checkoutId !== this.context.checkout.id ||
      !this.context.proxyVerified || !this.context.accountId || !this.context.session?.accessToken ||
      !this.context.billingEmailBinding || !this.context.originalSubscription ||
      this.context.originalSubscription.has_active_subscription || !this.context.snapshot
    ) throw new Error('原结账继续执行所需的账号、环境或报价不完整');
    if (resume.intentId) {
      const original = this.context.intent;
      if (original?.id !== resume.intentId || !original.client_secret || !this.context.key)
        throw new Error('换卡不能更换原 Intent');
      const result = await this.stripe(
        '换卡前只读核对原付款',
        '/v1/payment_intents/' + original.id + '?' +
          form({ key: this.context.key, client_secret: original.client_secret }),
      );
      const current = paymentIntentFromResponse(result, original);
      if (!current || result.id !== original.id) throw new Error('换卡查询返回了其他 Intent');
      if (
        current.status !== 'requires_payment_method' ||
        current.amount !== this.context.snapshot.amount_total ||
        current.currency !== this.context.snapshot.currency
      ) {
        // No card has been allocated for this execution. Preserve the observed
        // payment and stop rather than assigning its result to a different card.
        this.context.intent = current;
        await this.park('paused', '原付款状态或金额已变化，停止换卡，请核对原付款');
        return false;
      }
      this.context.intent = current;
    } else {
      const checkout = this.context.checkout;
      const data = await this.chat(
        '继续选卡前只读核对原结账',
        '/backend-api/payments/checkout/' + encodeURIComponent(checkout.processor_entity) +
          '/' + encodeURIComponent(checkout.id),
      );
      const current = data.checkout_session || data;
      const intent = paymentIntentFromResponse(current);
      if (
        (current.checkout_session_id || current.id) !== checkout.id ||
        current.status !== 'open' || current.payment_status !== 'unpaid' || intent ||
        (current.account_id && current.account_id !== this.context.accountId)
      ) {
        if (intent) this.context.intent = intent;
        await this.park('paused', '原结账状态已变化，停止继续付款，请核对原结账');
        return false;
      }
    }
    return true;
  }
  private async confirmOriginalIntent() {
    const originalIntent = this.context.intent!;
    const clientSecret = originalIntent.client_secret;
    if (!/^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(clientSecret || ''))
      throw new Error('原 Intent 缺少有效的确认参数');
    const returnUrl =
      this.context.merchantConfirmation?.confirm_return_url || this.context.snapshot.confirm_return_url ||
      this.context.confirmReturnUrl || this.context.snapshot.return_url || CHAT + '/';
    if (new URL(returnUrl).origin !== CHAT) throw new Error('付款返回地址不属于原商户');
    this.setStage('intent_ready');
    await this.command('authorize', { action: 'stripe_confirm' });
    this.assignment.run.paymentSubmitted = true;
    const confirmedIntent = await this.stripe(
      'Stripe 原 Intent 确认',
      '/v1/payment_intents/' + originalIntent.id + '/confirm',
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
    ) throw new Error('付款确认响应不属于原 Intent');
    this.context.intent = { ...confirmedIntent, client_secret: clientSecret };
    this.setStage('stripe_result');
    await this.handleIntent();
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
