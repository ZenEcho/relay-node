import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import type { HttpInput, HttpOutput } from '../../apps/worker/src/transport/native.js';
import type { Assignment, Control } from '../../apps/worker/src/runtime/controller.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { SentinelAuthorizer } from '../../packages/contracts/src/sentinel.js';

const boundAuthorizer: SentinelAuthorizer = async (request) => ({
  ...request,
  token: 'fixture-bound-authorization',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

test('Session email overrides the default in merchant taxes and Stripe form fields', async () => {
  const result = await execute({
    credentialUserEmail: 'session@example.invalid',
    defaultBillingEmail: 'default@example.invalid',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const tax = result.requests.find((request) => request.url.endsWith('/checkout/taxes'))!;
  assert.equal(JSON.parse(tax.body!).checkout_email, 'session@example.invalid');
  const stripe = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
  assert.equal(
    new URLSearchParams(stripe.body).get('payment_method_data[billing_details][email]'),
    'session@example.invalid',
  );
});

test('token-only credentials read the authenticated Session email before binding and direct API tokenization', async () => {
  const result = await execute({
    refreshedUserEmail: 'fresh-session@example.invalid',
    defaultBillingEmail: 'default@example.invalid',
    demo: false,
    authorizer: async (request) => ({
      ...request,
      token: 'test-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.ok(result.requests.some((request) => request.url.endsWith('/api/auth/session')));
  assert.ok(
    result.commands.some(
      (command) => command.action === 'checkpoint' && command.body.stage === 'billing_email_ready',
    ),
  );
  const token = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
  assert.equal(
    new URLSearchParams(token.body).get('payment_method_data[billing_details][email]'),
    'fresh-session@example.invalid',
  );
  assert.equal(result.sdkRequest, undefined);
  assert.equal(result.finish.context.billingEmailBinding.source, 'session');
});

test('a resumed accepted binding survives a different newly imported Session email', async () => {
  const result = await execute({
    credentialUserEmail: 'new-session@example.invalid',
    defaultBillingEmail: 'new-default@example.invalid',
    boundBillingEmail: 'accepted@example.invalid',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const tax = result.requests.find((request) => request.url.endsWith('/checkout/taxes'))!;
  assert.equal(JSON.parse(tax.body!).checkout_email, 'accepted@example.invalid');
  assert.equal(result.finish.context.billingEmailBinding.email, 'accepted@example.invalid');
});

test('an invalid authenticated Session email falls back after the Session read and never uses subscription-info email', async () => {
  const result = await execute({
    refreshedUserEmail: 'invalid-session-email',
    defaultBillingEmail: 'default@example.invalid',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.ok(result.requests.some((request) => request.url.endsWith('/api/auth/session')));
  assert.equal(result.finish.context.billingEmailBinding.source, 'default');
  const tax = result.requests.find((request) => request.url.endsWith('/checkout/taxes'))!;
  assert.equal(JSON.parse(tax.body!).checkout_email, 'default@example.invalid');
});

async function execute(
  options: {
    checkoutMode?: 'custom' | 'hosted';
    returnedCheckoutId?: string;
    apiStatus?: number;
    active?: boolean;
    resumed?: boolean;
    demo?: boolean;
    authorizer?: SentinelAuthorizer;
    elementsShape?: 'current' | 'conflicting';
    elements?: Record<string, unknown>;
    customerSession?: string;
    snapshotCustomerSession?: string;
    stripeAccount?: string;
    stripeProvider?: boolean;
    sdkWrongCard?: boolean;
    tokenResponse?: (input: HttpInput, cancellation: AbortController) => Promise<HttpOutput>;
    tokenData?: any;
    tokenStatus?: number;
    intentResponse?: (input: HttpInput) => HttpOutput;
    merchantDisconnect?: boolean;
    merchantData?: any;
    checkoutCustomer?: string;
    card?: { number: string; expiry: string; cvc: string; lastFour?: string };
    nestedTaxQuote?: boolean;
    hostedUrlConfig?: boolean;
    credentialUserEmail?: string;
    refreshedUserEmail?: string;
    defaultBillingEmail?: string;
    billingPhone?: string;
    boundBillingEmail?: string;
  } = {},
) {
  const environment = createEnvironment('PH', '');
  const cancellation = new AbortController();
  const assignment = {
    run: {
      id: 'custom-order',
      order: { cdkRedeemType: 'gpt_plus', cdkPaymentCurrency: 'PHP' },
      workflow: { plan: 'gpt_plus', cleanup: {}, checkoutMode: options.checkoutMode },
      paymentSubmitted: false,
      dispatches: {},
    },
    context: {
      environment,
      credential: JSON.stringify({
        accessToken: 'test-access',
        account: { id: 'demo-account' },
        ...(options.credentialUserEmail ? { user: { email: options.credentialUserEmail } } : {}),
      }),
      customerSessionClientSecret: options.customerSession,
      ...(options.boundBillingEmail
        ? {
            billingEmailBinding: {
              provider: 'chatgpt',
              source: 'session',
              email: options.boundBillingEmail,
            },
            email: options.boundBillingEmail,
          }
        : {}),
      ...(options.resumed
        ? {
            originalSubscription: { has_active_subscription: !!options.active },
          }
        : {}),
    },
    mode: 'execute',
    paymentEnabled: true,
    demo: options.demo ?? true,
    billing: {
      name: 'Test',
      line1: '123 Test St',
      city: 'Manila',
      postalCode: '1000',
      country: 'PH',
      email: options.defaultBillingEmail,
      phone: options.billingPhone,
    },
  } as Assignment;
  const requests: HttpInput[] = [],
    commands: { action: string; body: any }[] = [];
  const card = options.card || {
    number: '4242424242424242',
    expiry: '12/30',
    cvc: '123',
  };
  let sdkRequest: any;
  class Transport extends DemoTransport {
    constructor() {
      super(0);
    }
    override async request(input: HttpInput) {
      requests.push(input);
      const url = new URL(input.url);
      if (url.pathname === '/api/auth/session' && options.refreshedUserEmail) {
        const response = await super.request(input);
        response.data.user = { email: options.refreshedUserEmail };
        return response;
      }
      assert.notEqual(url.pathname, '/', 'Sentinel authorization must not depend on a homepage navigation');
      if (url.pathname.includes('/accounts/check/')) {
        if (options.apiStatus)
          return {
            status: options.apiStatus,
            headers: {},
            body: '',
            data: { message: 'account denied' },
          };
        const response = await super.request(input);
        response.data.accounts.default.entitlement.has_active_subscription = !!options.active;
        return response;
      }
      if (url.pathname.endsWith('/elements/sessions') && (options.elementsShape || options.elements)) {
        const response = await super.request(input);
        if (options.elementsShape) {
          response.data.session_id = response.data.id;
          if (options.elementsShape === 'current') delete response.data.id;
          else response.data.id = 'another-elements-session';
        }
        Object.assign(response.data, options.elements);
        return response;
      }
      if (
        url.pathname.endsWith('/checkout/taxes') &&
        (options.snapshotCustomerSession || options.stripeAccount)
      ) {
        const response = await super.request(input);
        response.data.checkout_session.customer_session_client_secret = options.snapshotCustomerSession;
        response.data.checkout_session.stripe_account = options.stripeAccount;
        return response;
      }
      if (url.pathname.endsWith('/checkout/taxes') && options.hostedUrlConfig) {
        const response = await super.request(input);
        const c = response.data.checkout_session;
        const bytes = Buffer.from(JSON.stringify({ apiKey: c.publishable_key }));
        for (let i = 0; i < bytes.length; i++) bytes[i] ^= 5;
        c.url = 'https://checkout.stripe.com/c/pay/' + c.id + '#' + bytes.toString('base64');
        delete c.publishable_key;
        return response;
      }
      if (url.pathname.endsWith('/checkout/taxes') && options.nestedTaxQuote) {
        const response = await super.request(input);
        const snapshot = response.data.checkout_session;
        snapshot.checkout_state = {
          currency: 'php',
          total: { total: { minorUnitsAmount: 32100 } },
        };
        delete snapshot.amount_total;
        delete snapshot.currency;
        return response;
      }
      if (url.pathname.endsWith('/checkout/taxes') && options.checkoutCustomer) {
        const response = await super.request(input);
        response.data.checkout_session.customer = options.checkoutCustomer;
        return response;
      }
      if (url.pathname.endsWith('/confirmation_tokens')) {
        if (options.tokenResponse) return options.tokenResponse(input, cancellation);
        if (options.tokenData || options.tokenStatus)
          return {
            status: options.tokenStatus || 200,
            headers: {},
            body: JSON.stringify(options.tokenData || {}),
            data: options.tokenData || {},
          };
      }
      if (url.pathname.endsWith('/checkout') && options.returnedCheckoutId)
        return {
          status: 200,
          headers: {},
          body: '',
          data: { internal_checkout_session_id: options.returnedCheckoutId },
        };
      if (url.pathname.endsWith('/checkout/confirm') && options.merchantData)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(options.merchantData),
          data: options.merchantData,
        };
      if (url.pathname.endsWith('/checkout/confirm') && options.merchantDisconnect)
        throw new Error('merchant response connection lost');
      if (url.pathname.startsWith('/v1/payment_intents/') && options.intentResponse)
        return options.intentResponse(input);
      return super.request(input);
    }
  }
  const control: Control = {
    signal: cancellation.signal,
    async request(action, body = {}) {
      commands.push({ action, body: structuredClone(body) });
      if (action === 'card') return card;
      return {};
    },
  };
  const transport = new Transport();
  await new ProtocolEngine(
    assignment,
    control,
    transport,
    options.authorizer,
    options.stripeProvider
      ? async (request) => {
          sdkRequest = request;
          return {
            id: 'ctoken_sdkfixture',
            lastFour: options.sdkWrongCard ? '9999' : request.cardLastFour,
          };
        }
      : undefined,
  ).execute();
  return {
    assignment,
    requests,
    commands,
    sdkRequest,
    card,
    control,
    transport,
    finish: commands.filter((c) => c.action === 'finish').at(-1)?.body,
  };
}

test('custom oaics flow requires Sentinel and forwards both token headers without depending on the homepage', async () => {
  const result = await execute();
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const account = result.requests.find((r) => r.url.includes('/accounts/check/'))!;
  assert.equal(account.headers?.['x-openai-target-route'], '/backend-api/accounts/check/{version}');
  const pricing = result.requests.find((r) => r.url.includes('/checkout_pricing_config/'))!;
  assert.equal(
    pricing.headers?.['x-openai-target-route'],
    '/backend-api/checkout_pricing_config/configs/{country_code}',
  );
  assert.equal(pricing.headers?.['sec-fetch-mode'], 'cors');
  const checkout = result.requests.find((r) => r.url.endsWith('/payments/checkout'))!;
  assert.equal(JSON.parse(checkout.body!).checkout_ui_mode, 'custom');
  assert.ok(!checkout.headers?.['oai-web-deployment-attestation']);
  const main = JSON.parse(checkout.headers!['openai-sentinel-token']);
  const so = JSON.parse(checkout.headers!['openai-sentinel-so-token']);
  assert.equal(main.flow, 'chatgpt_checkout');
  assert.equal(main.id, result.assignment.context.environment.deviceId);
  assert.notEqual(so.c, main.c);
  assert.equal(so.flow, main.flow);
  const confirm = result.requests.find((r) => r.url.endsWith('/payments/checkout/confirm'))!;
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-token']).flow, 'checkout_session_approval');
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-so-token']).flow, 'chatgpt_checkout');
  const authIndex = result.requests.findIndex((r) => r.url.includes('/sentinel/req'));
  assert.ok(authIndex >= 0 && authIndex < result.requests.indexOf(checkout));
  assert.equal(
    result.commands.filter((c) => c.action === 'authorize' && c.body.action === 'merchant_confirm').length,
    1,
  );
});

test('the current Stripe session_id response and original customer session are forwarded to card attribution', async () => {
  const result = await execute({
    elementsShape: 'current',
    customerSession: 'cuss_original_fixture',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const initialized = new URL(result.requests.find((r) => r.url.includes('/elements/sessions'))!.url);
  assert.equal(initialized.searchParams.get('customer_session_client_secret'), 'cuss_original_fixture');
  const token = result.requests.find((r) => r.url.endsWith('/confirmation_tokens'))!;
  const fields = new URLSearchParams(token.body);
  assert.equal(
    fields.get('client_attribution_metadata[elements_session_id]'),
    result.assignment.context.elements.session_id,
  );
});

test('conflicting Elements identifiers stop before card access or payment dispatch', async () => {
  const result = await execute({ elementsShape: 'conflicting' });
  assert.match(result.finish.error, /冲突的会话标识/);
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

for (const apiStatus of [401, 403, 429]) {
  test(`authenticated account HTTP ${apiStatus} stops before checkout or card requests`, async () => {
    const result = await execute({ apiStatus });
    assert.equal(result.finish.status, 'failed');
    assert.match(result.finish.error, new RegExp(`HTTP ${apiStatus}`));
    assert.ok(!result.requests.some((r) => r.url.includes('/payments/checkout')));
    assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
  });
}

test('resuming a free-account checkpoint still obtains a fresh Sentinel authorization', async () => {
  const result = await execute({ resumed: true });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.ok(!result.requests.some((r) => r.url.includes('/accounts/check/')));
  assert.ok(result.requests.some((r) => r.url.includes('/sentinel/req')));
});

for (const resumed of [false, true]) {
  test(`active subscription blocks a new payment on ${resumed ? 'resumed' : 'fresh'} execution`, async () => {
    const result = await execute({ active: true, resumed });
    assert.match(result.finish.error, /已有有效订阅/);
    assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
    assert.ok(!result.requests.some((r) => r.url.includes('/payments/checkout')));
  });
}

test('production execution without a real Sentinel adapter stops before checkout or card access', async () => {
  const result = await execute({ demo: false });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /缺少本单真实 Sentinel 授权/);
  assert.ok(
    !result.requests.some((r) => r.url.includes('/sentinel/req') || r.url.includes('/payments/checkout')),
  );
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

test('an authenticated-runtime adapter supplies fresh bound credentials before the payment stages', async () => {
  let authorizations = 0;
  const authorizer: SentinelAuthorizer = async (request) => {
    authorizations++;
    const common = {
      c: 'test-auth-' + authorizations,
      id: request.deviceId,
      flow: request.flow,
    };
    return {
      ...request,
      token: JSON.stringify({
        p: 'test-proof',
        t: 'test-authentication',
        ...common,
      }),
      soToken: JSON.stringify({
        so: 'test-session-observer',
        ...common,
        flow: request.observerFlow,
      }),
      soRequired: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  };
  const result = await execute({ demo: false, authorizer });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(authorizations, 4);
  assert.ok(!result.requests.some((r) => r.url.includes('/sentinel/req')));
  assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
  const checkout = result.requests.find((r) => r.url.endsWith('/payments/checkout'))!;
  const confirm = result.requests.find((r) => r.url.endsWith('/payments/checkout/confirm'))!;
  assert.equal(JSON.parse(checkout.headers!['openai-sentinel-token']).c, 'test-auth-1');
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-token']).c, 'test-auth-4');
  const logs = JSON.stringify(result.commands.filter((c) => c.action === 'step'));
  assert.ok(!logs.includes('test-authentication') && !logs.includes('test-session-observer'));
});

test('production without a Stripe provider creates one API token before the authorized merchant and Intent confirms', async () => {
  const result = await execute({
    demo: false,
    checkoutCustomer: 'cus_originalfixture',
    credentialUserEmail: 'session@example.invalid',
    authorizer: async (request) => ({
      ...request,
      token: 'opaque-from-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.sdkRequest, undefined);
  const tokens = result.requests.filter((r) => r.url.endsWith('/confirmation_tokens'));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].method, 'POST');
  assert.equal(tokens[0].headers!['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tokens[0].headers!.origin, 'https://js.stripe.com');
  assert.equal(tokens[0].headers!.referer, 'https://js.stripe.com/');
  const stripeHeaders = {
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    dnt: '1',
  };
  const elementsRequest = result.requests.find((request) => request.url.includes('/elements/sessions'))!;
  assert.equal(elementsRequest.method, 'GET');
  assert.equal(elementsRequest.headers!['content-type'], undefined);
  for (const [name, value] of Object.entries(stripeHeaders)) {
    assert.equal(tokens[0].headers![name], value);
    assert.equal(elementsRequest.headers![name], value);
  }
  const checkoutRequest = result.requests.find((request) => request.url.endsWith('/payments/checkout'))!;
  assert.equal(checkoutRequest.method, 'POST');
  assert.equal(checkoutRequest.headers!['content-type'], 'application/json');
  assert.equal(checkoutRequest.headers!.origin, 'https://chatgpt.com');
  assert.equal(checkoutRequest.headers!['sec-fetch-site'], 'same-origin');
  assert.equal(checkoutRequest.headers!['cache-control'], undefined);
  assert.equal(checkoutRequest.headers!.pragma, undefined);
  assert.equal(checkoutRequest.headers!.dnt, undefined);
  const fields = new URLSearchParams(tokens[0].body);
  assert.equal(fields.get('payment_method_data[card][number]'), '4242424242424242');
  assert.equal(fields.get('payment_method_data[card][cvc]'), '123');
  assert.equal(fields.get('payment_method_data[card][exp_month]'), '12');
  assert.equal(fields.get('payment_method_data[card][exp_year]'), '2030');
  assert.equal(fields.get('client_context[currency]'), 'php');
  assert.equal(fields.get('client_context[mode]'), 'subscription');
  assert.equal(fields.get('client_context[customer]'), 'cus_originalfixture');
  assert.equal(fields.get('client_context[payment_method_types][0]'), 'card');
  assert.equal(fields.get('client_context[payment_method_types][1]'), null);
  assert.equal(fields.get('payment_method_data[billing_details][phone]'), null);
  assert.match(
    fields.get('payment_method_data[payment_user_agent]')!,
    /^stripe\.js\/(628eb3cacd|a44b454c|d21f1cd6|9c1e8d52|f7a3b211|692f102a8f); stripe-js-v3\/\1; payment-element; deferred-intent$/,
  );
  assert.equal(
    fields.get('_stripe_version'),
    '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1',
  );
  assert.equal(fields.get('payment_method_data[referrer]'), 'https://chatgpt.com');
  const timeOnPage = Number(fields.get('payment_method_data[time_on_page]'));
  assert.ok(Number.isInteger(timeOnPage) && timeOnPage >= 8000 && timeOnPage <= 30000);
  assert.equal(fields.get('payment_method_data[pasted_fields]'), 'number');
  const merchant = result.requests.filter((r) => r.url.endsWith('/checkout/confirm'));
  const intent = result.requests.filter((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url));
  assert.equal(merchant.length, 1);
  assert.equal(intent.length, 1);
  assert.ok(result.requests.indexOf(tokens[0]) < result.requests.indexOf(merchant[0]));
  assert.ok(result.requests.indexOf(merchant[0]) < result.requests.indexOf(intent[0]));
  assert.deepEqual(
    result.commands
      .filter(
        (c) => c.action === 'authorize' && ['merchant_confirm', 'stripe_confirm'].includes(c.body.action),
      )
      .map((c) => c.body.action),
    ['merchant_confirm', 'stripe_confirm'],
  );
  const logs = JSON.stringify(result.commands.filter((c) => c.action === 'step'));
  assert.ok(!logs.includes('4242424242424242'));
  assert.ok(!logs.includes('"payment_method_data[card][cvc]":"123"'));
  assert.ok(!logs.includes(result.assignment.context.confirmationToken));
  assert.ok(!JSON.stringify(result.assignment.context).includes('4242424242424242'));
});

test('direct tokenization forwards only the provided billing phone', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    billingPhone: '  +1 202 555 0148  ',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const token = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
  const fields = new URLSearchParams(token.body);
  assert.equal(fields.get('payment_method_data[billing_details][phone]'), '+1 202 555 0148');
});

test('direct tokenization omits a blank billing phone instead of manufacturing one', async () => {
  const result = await execute({ demo: false, authorizer: boundAuthorizer, billingPhone: '   ' });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const token = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
  assert.equal(new URLSearchParams(token.body).has('payment_method_data[billing_details][phone]'), false);
});

for (const methods of [
  {
    name: 'original Elements response enables Link',
    elements: { payment_method_types: ['card', 'link', 'link', 'ideal'] },
    expected: ['card', 'link'],
  },
  {
    name: 'original Elements response omits Link',
    elements: { payment_method_types: ['card', 'ideal'] },
    expected: ['card'],
  },
  {
    name: 'original Elements method list is malformed',
    elements: { payment_method_types: 'link' },
    expected: ['card'],
  },
  {
    name: 'original nested Elements preference enables Link',
    elements: { payment_method_preference: { ordered_payment_method_types: ['card', 'link', 'ideal'] } },
    expected: ['card', 'link'],
  },
  {
    name: 'nested Elements preference enables only card and wallets',
    elements: {
      payment_method_preference: {
        ordered_payment_method_types: ['card'],
        ordered_payment_method_types_and_wallets: ['card', 'apple_pay', 'google_pay'],
      },
      payment_method_specs: [{ type: 'card' }],
    },
    expected: ['card'],
  },
  {
    name: 'nested Elements preference takes precedence over a conflicting top-level list',
    elements: {
      payment_method_preference: { ordered_payment_method_types: ['card'] },
      payment_method_types: ['card', 'link'],
    },
    expected: ['card'],
  },
]) {
  test(`direct tokenization advertises only card and enabled Link when ${methods.name}`, async () => {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      elements: methods.elements,
    });
    assert.equal(result.finish.status, 'completed', result.finish.error);
    const token = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
    const fields = new URLSearchParams(token.body);
    const types = [...fields]
      .filter(([key]) => /^client_context\[payment_method_types\]\[\d+\]$/.test(key))
      .map(([, value]) => value);
    assert.deepEqual(types, methods.expected);
  });
}

test('direct tokenization preserves the returned Elements session without inventing a config ID', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    elements: { id: 'elements_session_original', config_id: undefined },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const token = result.requests.find((request) => request.url.endsWith('/confirmation_tokens'))!;
  const fields = new URLSearchParams(token.body);
  for (const prefix of ['client_attribution_metadata', 'payment_method_data[client_attribution_metadata]']) {
    assert.equal(fields.get(prefix + '[elements_session_id]'), 'elements_session_original');
    assert.equal(fields.has(prefix + '[elements_session_config_id]'), false);
  }
});

test('a missing original Elements session stops before obtaining or sending card data', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    elements: { id: undefined, session_id: undefined },
  });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /缺少会话标识/);
  assert.ok(!result.commands.some((command) => command.action === 'card'));
  assert.ok(!result.requests.some((request) => request.url.endsWith('/confirmation_tokens')));
});

test('the official SDK gets the real checkout quote and accepted email without creating another Elements session', async () => {
  const result = await execute({
    demo: false,
    stripeProvider: true,
    nestedTaxQuote: true,
    credentialUserEmail: 'accepted@example.invalid',
    defaultBillingEmail: 'default@example.invalid',
    authorizer: async (request) => ({
      ...request,
      token: 'opaque-from-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.equal(result.sdkRequest.amountMinor, 32100);
  assert.equal(result.sdkRequest.currency, 'PHP');
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.sdkRequest.billing.email, 'accepted@example.invalid');
  assert.ok(!result.requests.some((r) => r.url.includes('/elements/sessions')));
  assert.ok(!result.requests.some((r) => r.url.endsWith('/confirmation_tokens')));
});

for (const customerSession of [undefined, 'cuss_context']) {
  test(`Stripe.js receives the original connected account and customer session: ${customerSession || 'snapshot'}`, async () => {
    const result = await execute({
      demo: false,
      stripeProvider: true,
      authorizer: boundAuthorizer,
      customerSession,
      snapshotCustomerSession: 'cuss_snapshot',
      stripeAccount: 'acct_original',
    });
    assert.equal(result.finish.status, 'completed', result.finish.error);
    assert.equal(result.sdkRequest.stripeAccount, 'acct_original');
    assert.equal(result.sdkRequest.customerSessionClientSecret, customerSession || 'cuss_snapshot');
  });
}

test('production direct tokenization normalizes the assigned card and validates the matching API preview', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    card: {
      number: '4242 4242 4242 4242',
      expiry: '1 / 2030',
      cvc: '123',
      lastFour: '4242',
    },
    tokenData: {
      id: 'ctoken_originalcard',
      payment_method_preview: { type: 'card', card: { last4: '4242' } },
    },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const token = result.requests.find((r) => r.url.endsWith('/confirmation_tokens'))!;
  const fields = new URLSearchParams(token.body);
  assert.equal(fields.get('payment_method_data[card][number]'), '4242424242424242');
  assert.equal(fields.get('payment_method_data[card][exp_month]'), '01');
  assert.equal(fields.get('payment_method_data[card][exp_year]'), '2030');
  assert.equal(result.assignment.context.confirmationToken, 'ctoken_originalcard');
});

for (const invalid of [
  { name: 'card number', card: { number: '4242' } },
  { name: 'security code', card: { cvc: 'x23' } },
  { name: 'expiry month', card: { expiry: '13/30' } },
  { name: 'assigned last four', card: { lastFour: '9999' } },
]) {
  test(`production rejects an invalid ${invalid.name} before sending card data to Stripe`, async () => {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      card: {
        number: '4242424242424242',
        cvc: '123',
        expiry: '12/30',
        ...invalid.card,
      },
    });
    assert.equal(result.finish.status, 'failed');
    assert.match(result.finish.error, /卡片资料不完整或卡片尾号不匹配/);
    assert.equal(result.assignment.run.paymentSubmitted, false);
    assert.ok(!result.requests.some((r) => r.url.endsWith('/confirmation_tokens')));
    assert.ok(!result.commands.some((c) => c.action === 'authorize'));
    assert.equal(result.card.number, '');
    assert.equal(result.card.cvc, '');
    assert.equal(result.card.expiry, '');
  });
}

for (const failure of [
  {
    name: 'the Stripe SDK requirement',
    status: 400,
    data: {
      error: {
        type: 'invalid_request_error',
        message: 'This publishable key tokenization request is required to use the Stripe SDK.',
      },
    },
    message: /HTTP 400.*required to use the Stripe SDK/,
  },
  {
    name: 'an API rejection',
    status: 400,
    data: { error: { message: 'tokenization rejected by upstream' } },
    message: /HTTP 400.*tokenization rejected/,
  },
  {
    name: 'an invalid token ID',
    status: 200,
    data: { id: 'ctoken_invalid!' },
    message: /未取得 confirmation token/,
  },
  {
    name: 'a preview for another card',
    status: 200,
    data: {
      id: 'ctoken_anothercard',
      payment_method_preview: { type: 'card', card: { last4: '9999' } },
    },
    message: /卡片尾号不匹配/,
  },
]) {
  test(`production direct tokenization stops on ${failure.name} before authorizing a payment`, async () => {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      tokenStatus: failure.status,
      tokenData: failure.data,
    });
    assert.equal(result.finish.status, 'failed');
    assert.match(result.finish.error, failure.message);
    assert.equal(result.assignment.run.paymentSubmitted, false);
    assert.equal(result.assignment.context.confirmationToken, undefined);
    assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
    assert.ok(!result.commands.some((c) => c.action === 'authorize'));
    assert.ok(!result.requests.some((r) => /\/checkout\/confirm$|\/payment_intents\//.test(r.url)));
    assert.deepEqual(result.card, { number: '', cvc: '', expiry: '' });
  });
}

for (const status of [200, 402]) {
  test(`an insufficient-funds Intent response (${status}) fails and recovery never repeats payment writes`, async () => {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      intentResponse(input) {
        const url = new URL(input.url);
        const lastError = {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        };
        const intent = {
          id: url.pathname.split('/')[3],
          client_secret: new URLSearchParams(input.body ?? url.search).get('client_secret'),
          status: 'requires_payment_method',
          last_payment_error: lastError,
        };
        const responseStatus = input.method === 'POST' ? status : 200;
        const data = responseStatus === 402 ? { error: { ...lastError, payment_intent: intent } } : intent;
        return { status: responseStatus, headers: {}, data, body: JSON.stringify(data) };
      },
    });
    assert.equal(result.finish.status, 'failed');
    assert.equal(result.finish.paymentOutcome, 'failed');
    assert.match(result.finish.error, /insufficient funds/);
    assert.equal(result.assignment.run.paymentSubmitted, true);
    assert.equal(result.assignment.context.intent?.status, 'requires_payment_method');
    assert.equal(result.assignment.context.intent?.last_payment_error.decline_code, 'insufficient_funds');
    assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
    assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
    assert.equal(result.requests.filter((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url)).length, 1);
    assert.deepEqual(
      result.commands.filter((c) => c.action === 'authorize').map((c) => c.body.action),
      ['merchant_confirm', 'stripe_confirm'],
    );
    assert.ok(!result.commands.some((c) => c.action === 'verification'));
    assert.ok(!result.requests.some((r) => /\/subscriptions\/cancel$|\/invoices$/.test(r.url)));
    assert.deepEqual(result.card, { number: '', cvc: '', expiry: '' });

    const requestCount = result.requests.length;
    const commandCount = result.commands.length;
    const originalIntentId = result.assignment.context.intent!.id;
    await new ProtocolEngine(result.assignment, result.control, result.transport, boundAuthorizer).execute();
    const recoveryRequests = result.requests.slice(requestCount);
    assert.equal(recoveryRequests.length, 1);
    assert.equal(recoveryRequests[0].method, 'GET');
    assert.equal(new URL(recoveryRequests[0].url).pathname, '/v1/payment_intents/' + originalIntentId);
    assert.ok(!result.commands.slice(commandCount).some((c) => ['card', 'authorize'].includes(c.action)));
    const recovered = result.commands.filter((c) => c.action === 'finish').at(-1)!.body;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.paymentOutcome, 'failed');
    assert.match(recovered.error, /insufficient funds/);
  });
}

test('cancelling a production token API request discards its late result and never authorizes payment', async () => {
  let complete!: (value: HttpOutput) => void;
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    tokenResponse: async (_input, cancellation) => {
      const pending = new Promise<HttpOutput>((resolve) => {
        complete = resolve;
      });
      cancellation.abort();
      return pending;
    },
  });
  complete({
    status: 200,
    headers: {},
    body: '{}',
    data: { id: 'ctoken_late' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(result.finish, undefined);
  assert.equal(result.assignment.run.paymentSubmitted, false);
  assert.equal(result.assignment.context.confirmationToken, undefined);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
  assert.ok(!result.commands.some((c) => c.action === 'authorize'));
  assert.ok(!result.requests.some((r) => /\/checkout\/confirm$|\/payment_intents\//.test(r.url)));
  assert.deepEqual(result.card, { number: '', cvc: '', expiry: '' });
});

test('a lost merchant response preserves the submitted boundary and resuming does not tokenize or confirm again', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    merchantDisconnect: true,
  });
  assert.equal(result.finish.status, 'pending_confirmation');
  assert.equal(result.assignment.run.paymentSubmitted, true);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  assert.ok(!result.requests.some((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url)));
  await new ProtocolEngine(result.assignment, result.control, result.transport, boundAuthorizer).execute();
  assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  assert.ok(!result.requests.some((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url)));
});

test('an SDK token for another card cannot be used for merchant confirmation', async () => {
  const result = await execute({
    demo: false,
    stripeProvider: true,
    sdkWrongCard: true,
    authorizer: async (request) => ({
      ...request,
      token: 'opaque-from-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.match(result.finish.error, /卡片尾号不匹配/);
  assert.ok(!result.commands.some((c) => c.action === 'authorize'));
  assert.ok(!result.requests.some((r) => r.url.endsWith('/payments/checkout/confirm')));
});

test('Sentinel adapter rejection stops before checkout and does not continue with cached credentials', async () => {
  const result = await execute({
    demo: false,
    resumed: true,
    authorizer: async () => {
      throw new Error('Sentinel requires verification in the authenticated session');
    },
  });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /requires verification/);
  assert.ok(!result.requests.some((r) => r.url.includes('/payments/checkout')));
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

test('an official SDK login rejection pauses an unsubmitted order before checkout or card access', async () => {
  const result = await execute({
    demo: false,
    authorizer: async () => {
      throw Object.assign(new Error('official account authorization required'), {
        code: 'OFFICIAL_SDK_AUTH_REQUIRED',
      });
    },
  });
  assert.equal(result.finish.status, 'paused');
  assert.equal(result.assignment.context.officialAuthorizationRequired, true);
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
  assert.ok(!result.requests.some((r) => r.url.includes('/payments/checkout')));
});

test('an explicit subscription limit fails immediately without another payment or read-only round', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    merchantData: { status: 'subscription_limit' },
  });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.paymentOutcome, 'failed');
  assert.equal(result.finish.error, '商户确认未成功：subscription_limit');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  assert.ok(!result.requests.some((r) => /\/v1\/payment_intents\//.test(r.url)));
  assert.equal(result.assignment.run.paymentSubmitted, true);
});

test('a subscription limit carrying an Intent remains pending for original-payment reconciliation', async () => {
  for (const data of [
    { status: 'subscription_limit', client_secret: 'pi_original_secret_fixture' },
    { status: 'subscription_limit', payment_intent: { id: 'pi_original' } },
  ]) {
    const result = await execute({ demo: false, authorizer: boundAuthorizer, merchantData: data });
    assert.equal(result.finish.status, 'pending_confirmation');
    assert.notEqual(result.finish.paymentOutcome, 'failed');
  }
});

test('hosted uses Stripe payment pages and merchant approval, records its type, and never calls custom confirmation', async () => {
  const result = await execute({ demo: false, authorizer: boundAuthorizer, checkoutMode: 'hosted' });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const checkout = result.requests.find((r) => r.url.endsWith('/payments/checkout'))!;
  assert.equal(JSON.parse(checkout.body!).checkout_ui_mode, 'hosted');
  assert.equal(JSON.parse(checkout.body!).processor_entity, undefined);
  assert.ok(!result.requests.some((r) => r.url.endsWith('/checkout/confirm')));
  assert.ok(!result.requests.some((r) => r.url.endsWith('/stripe_client_bootstrap')));
  const confirmed = result.requests.filter((r) => /\/payment_pages\/cs_live_[^/]+\/confirm$/.test(r.url));
  assert.equal(confirmed.length, 1);
  assert.equal(new URLSearchParams(confirmed[0].body).get('expected_amount'), '2000');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/approve')).length, 1);
  assert.equal(result.assignment.context.checkoutMode, 'hosted');
  assert.ok(result.commands.some((c) => c.action === 'step' && c.body.step.name === '支付链接类型 · hosted'));
});

test('a checkout of another selected type stops before card access and never switches routes', async () => {
  for (const [checkoutMode, returnedCheckoutId] of [
    ['hosted', 'oaics_other'],
    ['custom', 'cs_live_other'],
  ] as const) {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      checkoutMode,
      returnedCheckoutId,
    });
    assert.equal(result.finish.status, 'failed');
    assert.equal(result.assignment.run.paymentSubmitted, false);
    assert.ok(!result.commands.some((c) => c.action === 'card' || c.action === 'authorize'));
    assert.equal(result.requests.filter((r) => r.url.endsWith('/payments/checkout')).length, 1);
  }
});

test('hosted recovery reads the original page and never replays confirmation or approval', async () => {
  const result = await execute({ demo: false, authorizer: boundAuthorizer, checkoutMode: 'hosted' });
  const before = result.requests.length;
  result.assignment.mode = 'reconcile';
  await new ProtocolEngine(result.assignment, result.control, result.transport, boundAuthorizer).execute();
  const replay = result.requests.slice(before);
  assert.ok(replay.length > 0);
  assert.ok(replay.every((r) => r.method === 'GET'));
  assert.ok(replay.some((r) => r.url.includes('/payment_pages/' + result.assignment.context.checkout!.id)));
});

test('hosted takes the public Stripe key from its own returned URL without a bootstrap request', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutMode: 'hosted',
    hostedUrlConfig: true,
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.assignment.context.key, 'pk_test_demo');
  assert.ok(!result.requests.some((r) => r.url.endsWith('/stripe_client_bootstrap')));
});
