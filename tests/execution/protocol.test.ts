import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import type { HttpInput } from '../../apps/worker/src/transport/native.js';
import type { Assignment, Control } from '../../apps/worker/src/runtime/controller.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { SentinelAuthorizer } from '../../packages/contracts/src/sentinel.js';

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

test('token-only credentials read the authenticated Session email before binding and official SDK use', async () => {
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
  assert.equal(result.sdkRequest.billing.email, 'fresh-session@example.invalid');
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
    apiStatus?: number;
    active?: boolean;
    resumed?: boolean;
    demo?: boolean;
    authorizer?: SentinelAuthorizer;
    elementsShape?: 'current' | 'conflicting';
    customerSession?: string;
    sdkUnavailable?: boolean;
    sdkWrongCard?: boolean;
    nestedTaxQuote?: boolean;
    credentialUserEmail?: string;
    refreshedUserEmail?: string;
    defaultBillingEmail?: string;
    boundBillingEmail?: string;
  } = {},
) {
  const environment = createEnvironment('PH', '');
  const assignment = {
    run: {
      id: 'custom-order',
      order: { cdkRedeemType: 'gpt_plus', cdkPaymentCurrency: 'PHP' },
      workflow: { plan: 'gpt_plus', cleanup: {} },
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
    },
  } as Assignment;
  const requests: HttpInput[] = [],
    commands: { action: string; body: any }[] = [];
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
      assert.notEqual(
        url.pathname,
        '/',
        'Sentinel authorization must not depend on a homepage navigation',
      );
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
      if (url.pathname.endsWith('/elements/sessions') && options.elementsShape) {
        const response = await super.request(input);
        response.data.session_id = response.data.id;
        if (options.elementsShape === 'current') delete response.data.id;
        else response.data.id = 'another-elements-session';
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
      return super.request(input);
    }
  }
  const control: Control = {
    async request(action, body = {}) {
      commands.push({ action, body: structuredClone(body) });
      if (action === 'card') return { number: '4242424242424242', expiry: '12/30', cvc: '123' };
      return {};
    },
  };
  await new ProtocolEngine(
    assignment,
    control,
    new Transport(),
    options.authorizer,
    !assignment.demo && !options.sdkUnavailable
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
    finish: commands.filter((c) => c.action === 'finish').at(-1)!.body,
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
  assert.equal(
    JSON.parse(confirm.headers!['openai-sentinel-token']).flow,
    'checkout_session_approval',
  );
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-so-token']).flow, 'chatgpt_checkout');
  const authIndex = result.requests.findIndex((r) => r.url.includes('/sentinel/req'));
  assert.ok(authIndex >= 0 && authIndex < result.requests.indexOf(checkout));
  assert.equal(
    result.commands.filter((c) => c.action === 'authorize' && c.body.action === 'merchant_confirm')
      .length,
    1,
  );
});

test('the current Stripe session_id response and original customer session are forwarded to card attribution', async () => {
  const result = await execute({
    elementsShape: 'current',
    customerSession: 'cuss_original_fixture',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const initialized = new URL(
    result.requests.find((r) => r.url.includes('/elements/sessions'))!.url,
  );
  assert.equal(
    initialized.searchParams.get('customer_session_client_secret'),
    'cuss_original_fixture',
  );
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
    !result.requests.some(
      (r) => r.url.includes('/sentinel/req') || r.url.includes('/payments/checkout'),
    ),
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
  assert.ok(
    !result.requests.some((r) => r.url.includes('/confirmation_tokens')),
    'production tokenization must use the SDK provider',
  );
  const checkout = result.requests.find((r) => r.url.endsWith('/payments/checkout'))!;
  const confirm = result.requests.find((r) => r.url.endsWith('/payments/checkout/confirm'))!;
  assert.equal(JSON.parse(checkout.headers!['openai-sentinel-token']).c, 'test-auth-1');
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-token']).c, 'test-auth-4');
  const logs = JSON.stringify(result.commands.filter((c) => c.action === 'step'));
  assert.ok(!logs.includes('test-authentication') && !logs.includes('test-session-observer'));
});

test('production without an official Stripe SDK provider stops before card retrieval', async () => {
  const result = await execute({
    demo: false,
    sdkUnavailable: true,
    authorizer: async (request) => ({
      ...request,
      token: 'opaque-from-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.match(result.finish.error, /官方 Stripe SDK/);
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
  assert.ok(!result.requests.some((r) => r.url.includes('/confirmation_tokens')));
});

test('the nested real checkout total is passed to both Elements and the official SDK provider', async () => {
  const result = await execute({
    demo: false,
    nestedTaxQuote: true,
    authorizer: async (request) => ({
      ...request,
      token: 'opaque-from-official-sdk',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.equal(result.sdkRequest.amountMinor, 32100);
  assert.equal(result.sdkRequest.currency, 'PHP');
  const url = new URL(result.requests.find((r) => r.url.includes('/elements/sessions'))!.url);
  assert.equal(url.searchParams.get('deferred_intent[amount]'), '32100');
  assert.equal(url.searchParams.get('deferred_intent[currency]'), 'php');
});

test('an SDK token for another card cannot be used for merchant confirmation', async () => {
  const result = await execute({
    demo: false,
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
