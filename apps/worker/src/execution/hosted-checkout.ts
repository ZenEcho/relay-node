import { randomUUID } from 'node:crypto';
import { UpstreamError, form } from './http-utils.js';
import type { ExecutionServices } from './services.js';
import { paymentIntentFromResponse } from './intent-binding.js';

const VERSION = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
// Public merchant key from oa-pay-protocol-go; the original payment page must accept it before card access.
export const referenceHostedKey =
  'pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n';
const CHAT = 'https://chatgpt.com';
// Stripe 在 OAI approve 之后才真正提交付款，并异步创建 PaymentIntent。页面上的
// expected_amount、submission_attempt 与 /poll 终态才是这段链路的真相。
const PAGE_ROUNDS = 4;
const PAGE_INTERVAL_MS = 1500;
const COMPLETION_ROUNDS = 8;
const COMPLETION_INTERVAL_MS = 2000;
// 0 元单（官方优惠全额抵扣）在 Stripe 里是 complete + no_payment_required，同样算完成。
const PAID_STATES = [
  'paid',
  'no_payment_required',
  'success',
  'succeeded',
  'complete',
  'completed',
  'processing',
  'requires_capture',
];
const FAILED_STATES = ['failed', 'expired', 'canceled', 'cancelled'];

// Hosted URLs carry Stripe's public client configuration (base64, XOR 5).
export function hostedPublishableKey(value: unknown, checkoutId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 20000) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !['checkout.stripe.com', 'pay.openai.com'].includes(url.hostname) ||
      !['/c/pay/' + checkoutId, '/pay/' + checkoutId].includes(url.pathname)
    )
      return;
    const bytes = Buffer.from(decodeURIComponent(url.hash.slice(1)), 'base64');
    for (let index = 0; index < bytes.length; index++) bytes[index] ^= 5;
    const key = JSON.parse(bytes.toString('utf8')).apiKey;
    return typeof key === 'string' && /^pk_(?:live|test)_[a-zA-Z0-9]+$/.test(key) ? key : undefined;
  } catch {
    return;
  }
}

/**
 * expected_amount 只认官方返回：hosted 页面的 total_summary.due 就是 Stripe 按
 * 本单账单地区算出来的应付金额，地区换了数字自己就变，这里不做任何地区或税率
 * 判断。/taxes 快照上的 amount_total 是建单时的值，页面更新后会过期。
 */
export function hostedAmountTotal(page: any): number | undefined {
  const summary = page?.total_summary || page?.checkout_session?.total_summary;
  const candidates = [
    summary?.due,
    summary?.total,
    page?.amount_due,
    page?.amount_total,
    page?.invoice?.amount_due,
  ];
  return candidates.find((value) => Number.isSafeInteger(value) && value >= 0);
}

// 更新页面的响应一定带 total_summary；只有它才反映重算后的税额，不能拿旧快照补。
function summaryAmount(page: any): number | undefined {
  const summary = page?.total_summary || page?.checkout_session?.total_summary;
  const value = summary?.due ?? summary?.total;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 审批后的提交失败只出现在 submission_attempt 上，页面本身仍是 open/unpaid。 */
export function hostedSubmissionFailure(page: any): string | undefined {
  const attempt = page?.submission_attempt || page?.submissionAttempt;
  if (!attempt || attempt.state !== 'failed') return undefined;
  return String(attempt.error?.code || attempt.error?.decline_code || 'checkout_submission_failed');
}

function terminalError(message: string) {
  const error = new Error(message);
  (error as any).retryable = false;
  return error;
}

// Stripe 已明确拒绝这次提交（未创建 PaymentIntent），后台无需再挂着等结果。
function rejectedError(message: string) {
  const error = terminalError(message);
  (error as any).paymentRejected = true;
  return error;
}

function abortError() {
  return Object.assign(new Error('执行已取消'), { code: 'EXECUTION_ABORTED' });
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

function pageBody(data: any) {
  const nested = data.payment_page || data.checkout_session;
  return nested ? { ...data, ...nested } : data;
}
function bindPage(services: ExecutionServices, data: any) {
  const page = pageBody(data),
    checkout = services.context.checkout!;
  const returned =
    page.checkout_session_id ||
    data.checkout_session_id ||
    (String(page.id).startsWith('cs_') ? page.id : undefined);
  if (returned && returned !== checkout.id) throw new Error('Stripe Hosted 响应属于其他结账');
  return page;
}
function pageFields(services: ExecutionServices) {
  const c = services.context;
  c.clientSessionId ||= randomUUID();
  c.hostedStripeJsId ||= randomUUID();
  c.hostedElementsId ||= 'elements_session_' + randomUUID().replaceAll('-', '').slice(0, 11);
  return {
    key: c.key,
    _stripe_version: VERSION,
    'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
    'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
    'elements_session_client[elements_init_source]': 'custom_checkout',
    'elements_session_client[referrer_host]': 'chatgpt.com',
    'elements_session_client[session_id]': c.hostedElementsId,
    'elements_session_client[stripe_js_id]': c.hostedStripeJsId,
    'elements_session_client[locale]': 'en',
    'elements_session_client[is_aggregation_expected]': 'false',
    'elements_options_client[saved_payment_method][enable_save]': 'auto',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'auto',
  };
}
export async function readHostedPage(services: ExecutionServices) {
  const data = await services.stripe(
    '读取 Hosted 原结账',
    '/v1/payment_pages/' + services.context.checkout!.id + '?' + form(pageFields(services)),
  );
  const page = bindPage(services, data);
  services.context.paymentPage = page;
  return page;
}
export async function prepareHostedCheckout(services: ExecutionServices) {
  const c = services.context;
  if (!c.key)
    c.key = (
      await services.chat('读取 Hosted 付款配置', '/backend-api/payments/stripe_client_bootstrap', {})
    ).publishable_key;
  if (!c.key) throw new Error('Hosted 原结账缺少 Stripe publishable key');
  if (c.hostedAddressReady) return;
  const page = await readHostedPage(services);
  if (page.elements_session?.id) c.hostedElementsId = page.elements_session.id;
  c.hostedAmount = hostedAmountTotal(page) ?? c.hostedAmount;
  const billing = c.billing!;
  const fields: Record<string, any> = pageFields(services);
  for (const [stripe, local] of [
    ['country', 'country'],
    ['line1', 'line1'],
    ['city', 'city'],
    ['state', 'state'],
    ['postal_code', 'postalCode'],
  ])
    fields[`tax_region[${stripe}]`] = (billing as any)[local];
  // 页面税额必须和 Stripe 提交时按支付方式账单地址重算的发票一致；金额随后仍以
  // 官方页面返回的 total_summary 为准。
  let updated: any;
  try {
    updated = await services.stripe(
      '更新 Hosted 账单地区',
      '/v1/payment_pages/' + c.checkout!.id,
      fields,
    );
  } catch (error) {
    // 官方不接受跨地区的地址组合时，保留建单地区原来的页面（金额已经是按建单
    // 地区算好的），不要因此中断本单。
    if (!(error instanceof UpstreamError) || error.status < 400 || error.status >= 500) throw error;
    await services.log({
      name: 'Hosted 账单地址未写入 · 沿用官方页面金额',
      status: 'pending',
      error: (error as Error).message,
    });
    c.hostedAddressReady = true;
    await services.checkpoint('hosted_address_skipped');
    return;
  }
  c.paymentPage = bindPage(services, updated);
  // 页面更新后返回的应付金额就是官方的最终数字，直接采纳，不自己推算。
  c.hostedAmount = summaryAmount(c.paymentPage) ?? c.hostedAmount;
  c.hostedAddressReady = true;
  await services.checkpoint('hosted_address_ready');
}
export async function submitHostedCheckout(services: ExecutionServices) {
  const c = services.context,
    checkout = c.checkout!;
  const amount = c.hostedAmount ?? c.snapshot?.amount_total;
  if (!Number.isSafeInteger(amount) || amount < 0 || !c.confirmationToken)
    throw new Error('Hosted 原结账金额或令牌无效');
  const returnUrl =
    c.snapshot.return_url || CHAT + '/checkout/' + checkout.processor_entity + '/' + checkout.id;
  if (new URL(returnUrl).origin !== CHAT) throw new Error('Hosted 付款返回地址不属于原商户');
  await services.command('authorize', { action: 'stripe_confirm' });
  services.assignment.run.paymentSubmitted = true;
  const data = await services.stripe(
    'Stripe Hosted 原结账确认',
    '/v1/payment_pages/' + checkout.id + '/confirm',
    {
      ...pageFields(services),
      expected_amount: amount,
      expected_payment_method_type: 'card',
      confirmation_token: c.confirmationToken,
      return_url: returnUrl,
      'client_attribution_metadata[client_session_id]': c.clientSessionId,
      'client_attribution_metadata[checkout_session_id]': checkout.id,
      'client_attribution_metadata[merchant_integration_source]': 'checkout',
      'client_attribution_metadata[merchant_integration_version]': 'custom',
    },
  );
  c.paymentPage = bindPage(services, data);
  c.hostedAmount = summaryAmount(c.paymentPage) ?? c.hostedAmount;
  const rejected = hostedSubmissionFailure(c.paymentPage);
  if (rejected) throw rejectedError('Hosted 原结账提交被 Stripe 拒绝：' + rejected);
  const intent = paymentIntentFromResponse(c.paymentPage, c.intent);
  if (intent) c.intent = intent;
  await services.checkpoint('hosted_submitted');
  await services.requireSentinel('checkout_session_approval');
  await services.command('authorize', { action: 'merchant_approve' });
  const plan = services.assignment.run.workflow.plan;
  const approval = await services.chat('商户 Hosted 原结账审批', '/backend-api/payments/checkout/approve', {
    checkout_session_id: checkout.id,
    processor_entity: checkout.processor_entity,
    plan_type:
      plan === 'gpt_pro_5x'
        ? 'prolite'
        : plan.startsWith('gpt_pro')
          ? 'pro'
          : plan === 'gpt_go'
            ? 'go'
            : 'plus',
    locale: 'en-US',
  });
  if (!['approved', 'success', 'succeeded'].includes(approval.result || approval.status))
    throw new Error('Hosted 商户审批未通过：' + String(approval.result || approval.status || '响应缺少状态'));
  services.setStage('hosted_approved');
  await reconcileHostedCheckout(services);
}
export async function reconcileHostedCheckout(services: ExecutionServices) {
  // Stripe 在 OAI approve 之后才异步创建 PaymentIntent，单次读取经常还是
  // open/unpaid；先按页面轮询，再向 /poll 要终态。
  for (let round = 0; round < PAGE_ROUNDS; round++) {
    if (round > 0) await sleep(PAGE_INTERVAL_MS, services.signal);
    if (await acceptHostedPage(services, await readHostedPage(services))) return;
  }
  const completion = await pollHostedCompletion(services);
  if (completion === 'paid') {
    await services.success();
    return;
  }
  if (completion) throw rejectedError('Hosted 原结账在 Stripe 侧停在 ' + completion + '，未完成扣款');
  await services.park('pending_confirmation', 'Hosted 原付款尚未返回明确结果，仅核对原结账');
}

/** 页面能确认付款结果时返回 true；无证据时返回 false，由轮询继续等待。 */
async function acceptHostedPage(services: ExecutionServices, page: any) {
  const c = services.context;
  const rejected = hostedSubmissionFailure(page);
  if (rejected) throw rejectedError('Hosted 原结账提交被 Stripe 拒绝：' + rejected);
  if (
    (page.checkout_session_id || page.session_id || page.id) === c.checkout!.id &&
    page.status === 'complete' &&
    (page.payment_status === 'paid' || page.payment_status === 'no_payment_required')
  ) {
    await services.success();
    return true;
  }
  const intent = paymentIntentFromResponse(page, c.intent);
  if (
    intent &&
    /^pi_[a-zA-Z0-9]+$/.test(intent.id || '') &&
    String(intent.client_secret || '').startsWith(intent.id + '_secret_')
  ) {
    c.intent = intent;
    await services.checkpoint('hosted_intent_ready');
    // Page status and customer reports only wake an authoritative Intent read.
    const result = await services.stripe('只读核对 Hosted 原付款', '/v1/payment_intents/' + intent.id +
      '?' + form({ key: c.key, client_secret: intent.client_secret }));
    const current = paymentIntentFromResponse(result, intent);
    if (!current || result.id !== intent.id) throw new Error('付款查询返回了其他 Intent');
    c.intent = current;
    await services.handleIntent();
    return true;
  }
  return false;
}

/** Stripe 的完成轮询：paid 或明确的失败终态，其余返回 undefined 留给后台。 */
async function pollHostedCompletion(services: ExecutionServices) {
  const c = services.context;
  for (let round = 0; round < COMPLETION_ROUNDS; round++) {
    if (round > 0) await sleep(COMPLETION_INTERVAL_MS, services.signal);
    const data = await services.stripe(
      '读取 Hosted 结账终态',
      '/v1/payment_pages/' + c.checkout!.id + '/poll?' + form({ key: c.key }),
    );
    const states = [data.payment_object_status, data.state, data.status, data.payment_status]
      .map((value) => String(value || '').toLowerCase())
      .filter(Boolean);
    if (states.some((value) => PAID_STATES.includes(value))) return 'paid';
    const failed = states.find((value) => [...FAILED_STATES, 'requires_payment_method'].includes(value));
    if (failed) return failed;
  }
  return;
}
