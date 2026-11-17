import { randomUUID } from 'node:crypto';
import { form } from './http-utils.js';
import type { ExecutionServices } from './services.js';
import { paymentIntentFromResponse } from './intent-binding.js';

const VERSION = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
// Public merchant key from oa-pay-protocol-go; the original payment page must accept it before card access.
export const referenceHostedKey =
  'pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n';
const CHAT = 'https://chatgpt.com';

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
  const updated = await services.stripe(
    '更新 Hosted 账单地区',
    '/v1/payment_pages/' + c.checkout!.id,
    fields,
  );
  c.paymentPage = bindPage(services, updated);
  c.hostedAddressReady = true;
  await services.checkpoint('hosted_address_ready');
}
export async function submitHostedCheckout(services: ExecutionServices) {
  const c = services.context,
    checkout = c.checkout!;
  const amount = c.snapshot?.amount_total;
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
  await services.checkpoint('hosted_approved');
  await reconcileHostedCheckout(services);
}
export async function reconcileHostedCheckout(services: ExecutionServices) {
  const c = services.context,
    page = await readHostedPage(services);
  if (
    (page.checkout_session_id || page.id) === c.checkout!.id &&
    page.status === 'complete' &&
    page.payment_status === 'paid'
  ) {
    await services.success();
    return;
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
    return;
  }
  await services.park('pending_confirmation', 'Hosted 原付款尚未返回明确结果，仅核对原结账');
}
