import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import type { HttpInput, HttpOutput, TransportRequestOptions } from '../../apps/worker/src/transport/native.js';
import type { Assignment, Control } from '../../apps/worker/src/runtime/controller.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { SentinelAuthorizer } from '../../packages/contracts/src/sentinel.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';
import type { RuntimeContext } from '../../packages/contracts/src/execution.js';

const boundAuthorizer: SentinelAuthorizer = async (request) => ({
  ...request,
  token: 'fixture-bound-authorization',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

const latestLoginSession = {
  access_token: 'latest-session-access',
  account: { id: 'demo-account' },
  user: { id: 'demo-user', email: 'latest@example.invalid' },
};

for (const [name, hints, expected] of [
  ['explicit non-retryable failure', { retryable: false }, false],
  ['non-retryable runtime diagnostic', { runtimeDiagnostic: { retryable: false } }, false],
  ['retryable runtime diagnostic', { runtimeDiagnostic: { retryable: true } }, true],
  ['conflicting retry hints', { retryable: true, runtimeDiagnostic: { retryable: false } }, false],
  ['unclassified failure', {}, undefined],
  ['non-boolean retry hint', { retryable: 'false' }, undefined],
] as const) {
  test(`${name}: the execution receipt preserves retryability before any payment`, async () => {
    const result = await execute({
      demo: false,
      authorizer: async () => { throw Object.assign(new Error('fixture authorization unavailable'), hints); },
    });
    assert.equal(result.finish.status, 'failed');
    assert.equal(result.finish.failureRetryable, expected);
    assert.equal(result.commands.some((command) => command.action === 'authorize' || command.action === 'card'), false);
    assert.equal(result.requests.some((request) => request.method === 'POST'), false);
  });
}

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
    demo: false,
    authorizer: boundAuthorizer,
    hasLoginSession: true,
    credentialUserEmail: 'new-session@example.invalid',
    defaultBillingEmail: 'new-default@example.invalid',
    boundBillingEmail: 'accepted@example.invalid',
    sessionResponse: { status: 200, data: latestLoginSession },
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

for (const checkoutMode of ['custom', 'hosted'] as const) {
  test(`${checkoutMode} forces a Session refresh before the first checkout even with saved subscription preflight`, async () => {
    const result = await execute({
      checkoutMode,
      demo: false,
      authorizer: boundAuthorizer,
      credentialUserEmail: 'saved@example.invalid',
      hasLoginSession: true,
      resumed: true,
      sessionResponse: { status: 200, data: latestLoginSession },
    });
    assert.equal(result.finish.status, 'completed', result.finish.error);
    const reads = result.requests.filter((request) => new URL(request.url).pathname === '/api/auth/session');
    assert.equal(reads.length, 2);
    const [plain, refresh] = reads;
    assert.equal(plain.method, 'GET');
    assert.equal(new URL(plain.url).search, '');
    assert.equal(plain.headers?.['cache-control'], 'no-cache');
    assert.equal(plain.headers?.authorization, undefined);
    assert.equal(refresh.method, 'GET');
    const query = new URL(refresh.url).searchParams;
    assert.equal(query.get('refresh'), 'true');
    assert.equal(query.get('reason'), 'token_expired');
    assert.equal(query.get('method'), 'POST');
    assert.equal(query.get('path'), '/backend-api/payments/checkout');
    assert.equal(refresh.headers?.['x-openai-failed-access-token-iat'], undefined);
    assert.equal(refresh.headers?.authorization, undefined);
    for (const path of ['/accounts/check/', '/checkout_pricing_config/', '/payments/checkout']) {
      const request = result.requests.find((entry) => entry.url.includes(path))!;
      assert.ok(result.requests.indexOf(request) > result.requests.indexOf(refresh));
      assert.equal(request.headers?.authorization, 'Bearer ' + latestLoginSession.access_token);
    }
    assert.equal(result.finish.context.billingEmailBinding.email, latestLoginSession.user.email);
  });
}

test('the forced pre-checkout Session refresh forwards the failed token iat without sending the old token', async () => {
  const iat = 1795333522;
  const accessToken =
    'fixture.' +
    Buffer.from(JSON.stringify({ iat, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') +
    '.signature';
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    credentialUserEmail: 'saved@example.invalid',
    hasLoginSession: true,
    sessionResponse: { status: 200, data: { ...latestLoginSession, access_token: accessToken } },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const refresh = result.requests.find(
    (request) => new URL(request.url).searchParams.get('refresh') === 'true',
  )!;
  assert.equal(refresh.headers?.['x-openai-failed-access-token-iat'], String(iat));
  assert.equal(refresh.headers?.authorization, undefined);
  assert.equal(refresh.headers?.['x-openai-target-path'], '/api/auth/session');
  const checkout = result.requests.find((request) => request.url.endsWith('/payments/checkout'))!;
  assert.equal(checkout.headers?.authorization, 'Bearer ' + accessToken);
});

test('the checkout write carries the refreshed Session instead of the plain read', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    credentialUserEmail: 'saved@example.invalid',
    hasLoginSession: true,
    sessionResponse: { status: 200, data: latestLoginSession },
    refreshResponse: {
      status: 200,
      data: { ...latestLoginSession, access_token: 'refreshed-session-access' },
    },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.finish.context.session.accessToken, 'refreshed-session-access');
  for (const path of ['/accounts/check/', '/checkout_pricing_config/', '/payments/checkout']) {
    assert.equal(
      result.requests.find((request) => request.url.includes(path))!.headers?.authorization,
      'Bearer refreshed-session-access',
      path,
    );
  }
});

for (const [name, sessionResponse, expected] of [
  ['upstream refusal', { status: 403, data: { detail: 'Session request refused' } }, /Session request refused/],
  ['foreign account', { status: 200, data: { ...latestLoginSession, account: { id: 'other' } } }, /账号与原订单不一致/],
  ['foreign user', { status: 200, data: { ...latestLoginSession, user: { id: 'other' } } }, /用户与原订单不一致/],
  ['unconfirmed user', { status: 200, data: { ...latestLoginSession, user: {} } }, /缺少原账号或用户标识/],
] as const) {
  test(`checkout stops before pricing and authorization on ${name} during the forced Session refresh`, async () => {
    const result = await execute({
      demo: false,
      authorizer: async () => assert.fail('checkout authorization must not run'),
      credentialUserEmail: 'saved@example.invalid',
      hasLoginSession: true,
      sessionResponse,
    });
    assert.equal(result.finish.status, 'failed');
    assert.match(result.finish.error, expected);
    assert.equal(result.finish.context.session.accessToken, 'test-access');
    assert.equal(
      result.requests.filter((request) => new URL(request.url).pathname === '/api/auth/session').length,
      2,
    );
    assert.ok(!result.requests.some((request) => request.url.includes('/checkout_pricing_config/')));
    assert.ok(!result.requests.some((request) => request.method === 'POST'));
  });
}

async function execute(
  options: {
    checkoutMode?: 'custom' | 'hosted';
    cleanupChat?: ExecutionServices['cleanupChat'];
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
    checkoutConfigurationOnly?: boolean;
    checkoutStripe?: Record<string, unknown>;
    taxStripe?: Record<string, unknown>;
    snapshotConfirmReturnUrl?: string;
    omitMerchantReturnUrl?: boolean;
    stripeAccount?: string;
    stripeProvider?: boolean;
    sdkWrongCard?: boolean;
    tokenResponse?: (input: HttpInput, cancellation: AbortController) => Promise<HttpOutput>;
    tokenData?: any;
    intentResponse?: (input: HttpInput) => HttpOutput;
    merchantDisconnect?: boolean;
    merchantData?: any;
    merchantStatus?: number;
    checkoutCustomer?: string;
    card?: { number: string; expiry: string; cvc: string; lastFour?: string };
    nestedTaxQuote?: boolean;
    hostedUrlConfig?: boolean;
    hostedKeyMissing?: boolean;
    hostedPageStatus?: number;
    credentialUserEmail?: string;
    hasLoginSession?: boolean;
    sessionResponse?: Pick<HttpOutput, 'status' | 'data'>;
    refreshResponse?: Pick<HttpOutput, 'status' | 'data'>;
    refreshedUserEmail?: string;
    defaultBillingEmail?: string;
    billingPhone?: string;
    boundBillingEmail?: string;
    proxyUrl?: string;
    beforeCommand?: (action: string, body: any, context: RuntimeContext) => void;
    checkoutResponse?: HttpOutput;
    transportAttemptAudit?: boolean;
    transportRetryAudit?: boolean;
    initialContext?: RuntimeContext;
    checkoutReadResponse?: HttpOutput;
  } = {},
) {
  const environment = createEnvironment('PH', options.proxyUrl || '');
  const cancellation = new AbortController();
  const assignment = {
    run: {
      id: 'custom-order',
      order: { cdkRedeemType: 'gpt_plus', cdkPaymentCurrency: 'PHP' },
      workflow: {
        plan: 'gpt_plus',
        cleanup: {},
        checkoutMode: options.checkoutMode,
      },
      paymentSubmitted: false,
      dispatches: {},
    },
    context: {
      environment,
      credential: JSON.stringify({
        accessToken: 'test-access',
        account: { id: 'demo-account' },
        ...(options.hasLoginSession ? { sessionToken: 'fixture-login-session' } : {}),
        ...(options.credentialUserEmail
          ? { user: { id: 'demo-user', email: options.credentialUserEmail } }
          : {}),
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
  if (options.initialContext) {
    assignment.context = structuredClone(options.initialContext);
    assignment.billing = assignment.context.billing || undefined;
  }
  const requests: HttpInput[] = [],
    commands: { action: string; body: any }[] = [];
  const card = options.card || {
    number: '4242424242424242',
    expiry: '12/30',
    cvc: '123',
  };
  let sdkRequest: any, activeChecks = 0;
  class Transport extends DemoTransport {
    constructor() {
      super(0);
    }
    override async request(input: HttpInput, requestOptions?: TransportRequestOptions) {
      const url = new URL(input.url);
      if (url.pathname === '/backend-api/payments/checkout' && options.transportAttemptAudit)
        await requestOptions?.onAttempt?.({
          requestId: '11111111-1111-4111-8111-111111111111',
          attemptId: '22222222-2222-4222-8222-222222222222',
          attempt: 1, method: input.method, targetHost: url.hostname, outcome: 'running',
          startedAt: new Date().toISOString(), elapsedMs: 0, totalElapsedMs: 0,
        });
      if (url.pathname === '/backend-api/payments/checkout' && options.transportRetryAudit)
        await requestOptions?.onAttempt?.({
          requestId: '11111111-1111-4111-8111-111111111111',
          attemptId: '33333333-3333-4333-8333-333333333333',
          attempt: 2, method: input.method, targetHost: url.hostname, outcome: 'running',
          startedAt: new Date().toISOString(), elapsedMs: 0, totalElapsedMs: 0,
        });
      requests.push(input);
      if (url.pathname.includes('/checkout/openai_llc/') && options.checkoutReadResponse)
        return options.checkoutReadResponse;
      if (url.pathname === '/backend-api/payments/checkout' && options.checkoutResponse)
        return options.checkoutResponse;
      if (url.pathname.endsWith('/payments/checkout') && options.checkoutStripe) {
        const response = await super.request(input);
        Object.assign(response.data, options.checkoutStripe);
        return response;
      }
      if (url.pathname.endsWith('/checkout/taxes') && options.taxStripe) {
        const response = await super.request(input);
        Object.assign(response.data.checkout_session, options.taxStripe);
        return response;
      }
      if (url.pathname.endsWith('/payments/checkout') && options.checkoutConfigurationOnly) {
        const response = await super.request(input);
        Object.assign(response.data, { publishable_key: 'pk_test_original', customer_session_client_secret: 'cuss_original', confirm_return_url: 'https://chatgpt.com/checkout/verify?stripe_session_id=' + response.data.internal_checkout_session_id });
        return response;
      }
      if (url.pathname.endsWith('/checkout/taxes') && options.checkoutConfigurationOnly) {
        const response = await super.request(input);
        delete response.data.checkout_session.publishable_key;
        return response;
      }
      if (url.pathname.includes('/checkout/openai_llc/') && options.merchantData?.status === 'subscription_limit' && !options.merchantData.client_secret && !options.merchantData.payment_intent) {
        return { status: 200, headers: {}, body: '', data: { checkout_session: { id: JSON.parse(requests.find(request => request.url.endsWith('/checkout/confirm'))!.body!).checkout_session_id, status: 'open', payment_status: 'unpaid' } } };
      }
      if (
        url.pathname === '/api/auth/session' &&
        url.searchParams.get('refresh') === 'true' &&
        options.refreshResponse
      ) {
        const { status, data } = options.refreshResponse;
        return { status, headers: {}, body: JSON.stringify(data), data };
      }
      if (url.pathname === '/api/auth/session' && options.sessionResponse) {
        const { status, data } = options.sessionResponse;
        return { status, headers: {}, body: JSON.stringify(data), data };
      }
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
        response.data.accounts.default.account.plan_type = options.active ? 'plus' : 'free';
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
      if (url.pathname.endsWith('/checkout/taxes') && options.snapshotConfirmReturnUrl) {
        const response = await super.request(input);
        response.data.checkout_session.confirm_return_url = options.snapshotConfirmReturnUrl;
        delete response.data.checkout_session.return_url;
        return response;
      }
      if (url.pathname.endsWith('/checkout/confirm') && options.omitMerchantReturnUrl) {
        const response = await super.request(input);
        delete response.data.confirm_return_url;
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
      if (url.pathname.endsWith('/checkout/taxes') && (options.hostedUrlConfig || options.hostedKeyMissing)) {
        const response = await super.request(input);
        const c = response.data.checkout_session;
        const bytes = Buffer.from(JSON.stringify({ apiKey: c.publishable_key }));
        for (let i = 0; i < bytes.length; i++) bytes[i] ^= 5;
        c.url = options.hostedUrlConfig
          ? 'https://checkout.stripe.com/c/pay/' + c.id + '#' + bytes.toString('base64')
          : undefined;
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
        if (options.tokenData)
          return {
            status: 200,
            headers: {},
            body: JSON.stringify(options.tokenData),
            data: options.tokenData,
          };
      }
      if (url.pathname.startsWith('/v1/payment_pages/') && input.method === 'GET' && options.hostedPageStatus)
        return {
          status: options.hostedPageStatus,
          headers: {},
          body: '',
          data: { error: { message: 'original page key rejected' } },
        };
      if (url.pathname.endsWith('/checkout') && options.returnedCheckoutId)
        return {
          status: 200,
          headers: {},
          body: '',
          data: { internal_checkout_session_id: options.returnedCheckoutId },
        };
      if (url.pathname.endsWith('/checkout/confirm') && options.merchantData)
        return {
          status: options.merchantStatus || 200,
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
  const activeStages = new Set<string>();
  const control: Control = {
    signal: cancellation.signal,
    async assertActive(stage) {
      activeChecks++;
      if (stage) activeStages.add(stage);
    },
    async request(action, body = {}) {
      options.beforeCommand?.(action, body, assignment.context);
      commands.push({ action, body: structuredClone(body) });
      if (action === 'authorize') assignment.run.dispatches[(body as any).action] = new Date().toISOString();
      if (action === 'card') return card;
      if (action === 'verification' && body.action === 'start')
        return { challengeId: 'customer-challenge', kind: 'stripe', state: 'waiting', expiresAt: Date.now() + 300000 };
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
    options.cleanupChat,
  ).execute();
  return {
    assignment,
    requests,
    commands,
    sdkRequest,
    activeChecks,
    activeStages,
    card,
    control,
    transport,
    finish: commands.filter((c) => c.action === 'finish').at(-1)?.body,
  };
}

test('custom execution persists recovery boundaries without redundant phase or authorization checkpoints', async () => {
  const result = await execute({ demo: false, authorizer: boundAuthorizer,
    credentialUserEmail: 'session@example.invalid' });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const stages = result.commands.filter((c) => c.action === 'checkpoint').map((c) => c.body.stage);
  assert.deepEqual(stages, ['billing_email_ready', 'subscription_ready', 'checkout_created',
    'taxes_ready', 'elements_ready', 'confirmation_token_ready', 'intent_ready']);
  assert.equal(result.activeStages.size, 0);
  const loggedStages = result.commands.filter((c) => c.action === 'step').map((c) => c.body.step.request?.stage);
  for (const stage of ['proxy_check', 'subscription_check', 'checkout'])
    assert.ok(loggedStages.includes(stage), stage);
  assert.ok(!result.commands.some((c) => c.action === 'step' && c.body.step.name === '保存执行进度'));
  assert.equal(result.commands.filter((c) => c.action === 'card').length, 1);
  assert.deepEqual(result.commands.filter((c) => c.action === 'authorize').map((c) => c.body.action),
    ['merchant_confirm', 'stripe_confirm', 'registration']);
});

test('Stripe requests retain the connected account when the tax response omits it', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutStripe: { publishable_key: 'pk_test_demo', stripe_account: 'acct_original' },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const stripe = result.requests.filter((request) => new URL(request.url).hostname === 'api.stripe.com');
  assert.ok(stripe.length > 0);
  assert.ok(stripe.every((request) => request.headers?.['Stripe-Account'] === 'acct_original'));
});

test('conflicting or invalid Stripe configuration stops before Stripe calls and card selection', async () => {
  for (const options of [
    { checkoutStripe: { publishable_key: 'pk_test_original' }, error: /publishable key 前后不一致/ },
    {
      checkoutStripe: { stripe_account: 'acct_original' },
      taxStripe: { stripe_account: 'acct_other' },
      error: /Stripe-Account 前后不一致/,
    },
    { taxStripe: { livemode: true }, error: /Stripe 环境与 publishable key 不一致/ },
    { checkoutStripe: { publishable_key: 'sk_test_misrouted' }, error: /publishable key 格式无效/ },
  ]) {
    const result = await execute({ demo: false, authorizer: boundAuthorizer, ...options });
    assert.equal(result.finish.status, 'failed');
    assert.equal(result.finish.failureRetryable, false);
    assert.match(result.finish.error, options.error);
    assert.doesNotMatch(result.finish.error, /sk_test_misrouted|acct_other/);
    assert.equal(result.requests.some((request) => new URL(request.url).hostname === 'api.stripe.com'), false);
    assert.equal(result.commands.some(({ action }) => action === 'card' || action === 'authorize'), false);
  }
});

test('native first-attempt audits share the dispatch guard while retries get a fresh guard', async () => {
  const options = { demo: false, authorizer: boundAuthorizer };
  const plain = await execute(options);
  const first = await execute({ ...options, transportAttemptAudit: true });
  const retry = await execute({ ...options, transportAttemptAudit: true, transportRetryAudit: true });
  for (const result of [plain, first, retry]) assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(first.activeChecks, plain.activeChecks);
  assert.equal(retry.activeChecks, first.activeChecks + 1);
});

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
  assert.equal(pricing.headers?.['openai-sentinel-token'], undefined);
  assert.equal(pricing.headers?.['openai-sentinel-so-token'], undefined);
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
  assert.ok(result.requests.indexOf(pricing) < authIndex);
  assert.equal(
    result.commands.filter((c) => c.action === 'authorize' && c.body.action === 'merchant_confirm').length,
    1,
  );
});

test('each Sentinel grant is sent only to its matching write and never to reads or Stripe', async () => {
  const result = await execute({
    beforeCommand(action, body, context) {
      if (action === 'checkpoint' && body.stage === 'subscription_ready') {
        context.sentinel = 'stale-checkpoint-main';
        context.sentinelSo = 'stale-checkpoint-observer';
      }
    },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const protectedWrites = result.requests.filter((r) => r.headers?.['openai-sentinel-token']);
  assert.deepEqual(protectedWrites.map((r) => [r.method, new URL(r.url).pathname]), [
    ['POST', '/backend-api/payments/checkout'],
    ['POST', '/backend-api/payments/checkout/taxes'],
    ['POST', '/backend-api/payments/checkout/confirm'],
  ]);
  const steps = result.commands.filter((c) => c.action === 'step' && c.body.step.status === 'succeeded').map((c) => c.body.step);
  const grants = steps.filter((s) => s.name === '取得本单 Sentinel 授权').map((s) => s.response.grantId);
  const writes = steps.filter((s) => s.request?.grantId).map((s) => s.request.grantId);
  assert.equal(new Set(grants).size, 3);
  assert.deepEqual(writes, grants);
  assert.ok(!JSON.stringify(result.requests).includes('stale-checkpoint'));
});

test('an environment change during the checkout audit round trip blocks the actual POST', async () => {
  const result = await execute({
    beforeCommand(action, body, context) {
      if (action === 'step' && body.step.name === '创建支付链接' && body.step.status === 'running')
        context.environment.proxyUrl = 'http://other.invalid:8080';
    },
  });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /签发后本单凭证或环境发生变化/);
  assert.ok(!result.requests.some((r) => r.url.endsWith('/payments/checkout')));
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

test('an expired checkout grant stops before the POST without acquiring cards or replaying it', async (t) => {
  const afterExpiry = Date.now() + 120000;
  const result = await execute({
    beforeCommand(action, body) {
      if (action === 'step' && body.step.name === '创建支付链接' && body.step.status === 'running')
        t.mock.method(Date, 'now', () => afterExpiry);
    },
  });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /本地新鲜度期限/);
  assert.ok(!result.requests.some((r) => r.url.endsWith('/payments/checkout')));
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

test('an environment change inside the native attempt audit blocks the wire request', async () => {
  const result = await execute({
    transportAttemptAudit: true,
    beforeCommand(action, body, context) {
      if (action === 'step' && body.step.name === '原生 HTTP 传输尝试' && body.step.status === 'running')
        context.environment.deviceId = 'other-device';
    },
  });
  assert.equal(result.finish.status, 'failed');
  assert.match(result.finish.error, /签发后本单凭证或环境发生变化/);
  assert.ok(!result.requests.some((r) => r.url.endsWith('/payments/checkout')));
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
});

test('an unusual-activity checkout refusal retains the upstream diagnostic without replay or card access', async () => {
  const detail = 'Our systems have detected unusual activity. Please try again later.';
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    hasLoginSession: true,
    sessionResponse: { status: 200, data: latestLoginSession },
    checkoutResponse: { status: 400, headers: {}, body: JSON.stringify({ detail }), data: { detail } },
  });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.error, 'HTTP 400：' + detail);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/payments/checkout')).length, 1);
  assert.equal(result.requests.filter((r) => new URL(r.url).pathname === '/api/auth/session').length, 2);
  assert.ok(!result.commands.some((c) => ['card', 'authorize'].includes(c.action)));
  assert.ok(!result.requests.some((r) => new URL(r.url).hostname === 'api.stripe.com'));
});

test('Sentinel and merchant audits identify the same frozen proxy without exposing its credentials', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    proxyUrl: 'http://private-proxy-user:private-proxy-password@proxy.invalid:8080/',
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  const logs = result.commands.filter((c) => c.action === 'step').map((c) => c.body.step);
  const merchant = logs.find((entry) => entry.name === '商户付款确认');
  const sentinel = logs.filter((entry) => entry.name === '取得本单 Sentinel 授权');
  assert.ok(sentinel.length >= 2);
  for (const entry of sentinel) {
    assert.equal(entry.request.environmentId, merchant.request.environmentId);
    assert.equal(entry.request.profile, merchant.request.profile);
    assert.equal(entry.request.proxyUrl, merchant.request.proxyUrl);
    assert.equal(entry.request.networkMode, 'proxy');
    assert.equal(entry.request.observerFlow, 'chatgpt_checkout');
    assert.equal(entry.request.deviceId, result.assignment.context.environment.deviceId);
    assert.equal(entry.request.accountId, result.assignment.context.accountId);
    assert.match(entry.request.stage, /sentinel_authorization$/);
  }
  assert.equal(merchant.request.stage, 'merchant_confirm');
  assert.equal(JSON.stringify(logs).includes('private-proxy-user'), false);
  assert.equal(JSON.stringify(logs).includes('private-proxy-password'), false);
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
  assert.equal(authorizations, 3);
  assert.ok(!result.requests.some((r) => r.url.includes('/sentinel/req')));
  assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
  const checkout = result.requests.find((r) => r.url.endsWith('/payments/checkout'))!;
  const confirm = result.requests.find((r) => r.url.endsWith('/payments/checkout/confirm'))!;
  assert.equal(JSON.parse(checkout.headers!['openai-sentinel-token']).c, 'test-auth-1');
  assert.equal(JSON.parse(confirm.headers!['openai-sentinel-token']).c, 'test-auth-3');
  const stages = result.commands.filter((c) => c.action === 'checkpoint').map((c) => c.body.stage);
  assert.ok(!stages.some((stage) => /sentinel_(authorization|ready)$/.test(stage)));
  const authorizationStages = result.commands.filter((c) => c.action === 'step'
    && c.body.step.name === '取得本单 Sentinel 授权').map((c) => c.body.step.request.stage);
  assert.ok(authorizationStages.includes('checkout_sentinel_authorization'));
  assert.ok(authorizationStages.includes('payment_sentinel_authorization'));
  assert.ok(stages.indexOf('confirmation_token_ready') < stages.indexOf('intent_ready'));
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
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    billingPhone: '   ',
  });
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
    elements: {
      payment_method_preference: {
        ordered_payment_method_types: ['card', 'link', 'ideal'],
      },
    },
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

test('the live custom snapshot confirm_return_url reaches SDK preparation and the original Intent confirmation', async () => {
  const returnUrl = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_original&processor_entity=openai_llc&plan_type=plus';
  for (const stripeProvider of [false, true]) {
    const result = await execute({
      demo: false, authorizer: boundAuthorizer, stripeProvider,
      snapshotConfirmReturnUrl: returnUrl, omitMerchantReturnUrl: true,
    });
    assert.equal(result.finish.status, 'completed', result.finish.error);
    if (stripeProvider) assert.equal(result.sdkRequest.returnUrl, returnUrl);
    const confirm = result.requests.find(request => request.url.includes('/payment_intents/') && request.url.endsWith('/confirm'))!;
    assert.equal(new URLSearchParams(confirm.body).get('return_url'), returnUrl);
  }
});

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
    message: /HTTP 400.*官方 Stripe SDK/,
    code: 'STRIPE_SDK_REQUIRED',
  },
  {
    name: 'Stripe authentication failure',
    status: 401,
    data: { error: { type: 'invalid_request_error', message: 'upstream-sensitive-diagnostic' } },
    message: /HTTP 401.*无法认证/,
    code: 'STRIPE_AUTHENTICATION_FAILED',
  },
  {
    name: 'Stripe permission failure',
    status: 403,
    data: { error: { type: 'invalid_request_error', message: 'upstream-sensitive-diagnostic' } },
    message: /HTTP 403.*拒绝.*权限/,
    code: 'STRIPE_PERMISSION_DENIED',
  },
  {
    name: 'an unclassified gateway denial',
    status: 403,
    data: { error: { type: 'invalid_request_error', message: 'gateway refused the request' } },
    message: /HTTP 403.*gateway refused/,
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
      tokenResponse: async () => {
        const headers: HttpOutput['headers'] = failure.code
          ? { 'Request-Id': ['req_StripeFailure1'], 'X-Debug': ['upstream-sensitive-diagnostic'] }
          : {};
        return { status: failure.status, headers, data: failure.data, body: JSON.stringify(failure.data) };
      },
    });
    assert.equal(result.finish.status, 'failed');
    assert.match(result.finish.error, failure.message);
    assert.equal(result.finish.failureRetryable, failure.code ? false : undefined);
    if (failure.code) {
      const step = result.commands.find(({ action, body }) =>
        action === 'step' && body.step.name === '创建原卡确认令牌' && body.step.status === 'failed',
      )!.body.step;
      assert.deepEqual(step.response.stripe, {
        code: failure.code,
        type: 'invalid_request_error',
        requestId: 'req_StripeFailure1',
      });
      assert.equal(step.httpStatus, failure.status);
      assert.equal(step.errorDetail.code, failure.code);
      assert.ok(!JSON.stringify(result.commands).includes('upstream-sensitive-diagnostic'));
    }
    assert.equal(result.assignment.run.paymentSubmitted, false);
    assert.equal(result.assignment.context.confirmationToken, undefined);
    assert.equal(result.requests.filter((r) => r.url.endsWith('/confirmation_tokens')).length, 1);
    assert.ok(!result.commands.some((c) => c.action === 'authorize'));
    assert.ok(!result.requests.some((r) => /\/checkout\/confirm$|\/payment_intents\//.test(r.url)));
    assert.deepEqual(result.card, { number: '', cvc: '', expiry: '' });
  });
}

test('Stripe permission failure on confirmation leaves the original payment in read-only reconciliation', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    intentResponse(input) {
      const url = new URL(input.url);
      const data = {
        error: {
          type: 'invalid_request_error',
          message: 'missing permission',
          payment_intent: {
            id: url.pathname.split('/')[3],
            client_secret: new URLSearchParams(input.body ?? url.search).get('client_secret'),
            status: 'requires_payment_method',
            last_payment_error: { type: 'card_error', code: 'card_declined' },
          },
        },
      };
      return { status: 403, headers: { 'request-id': ['req_StripePermission1'] }, data, body: JSON.stringify(data) };
    },
  });
  assert.equal(result.finish.status, 'pending_confirmation');
  assert.equal(result.finish.paymentOutcome, undefined);
  assert.equal(result.finish.failureRetryable, false);
  assert.equal(result.assignment.run.paymentSubmitted, true);
  const intent = result.assignment.context.intent!;
  assert.notEqual(intent.status, 'requires_payment_method');

  const requestCount = result.requests.length;
  const commandCount = result.commands.length;
  await new ProtocolEngine(result.assignment, result.control, result.transport, boundAuthorizer).execute();
  assert.deepEqual(
    result.requests.slice(requestCount).map(({ method, url }) => [method, new URL(url).pathname]),
    [['GET', '/json/'], ['GET', '/v1/payment_intents/' + intent.id]],
  );
  assert.ok(!result.commands.slice(commandCount).some((c) => ['card', 'authorize'].includes(c.action)));
  const recovered = result.commands.filter((c) => c.action === 'finish').at(-1)!.body;
  assert.equal(recovered.status, 'pending_confirmation');
  assert.equal(recovered.paymentOutcome, undefined);
});

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
        return {
          status: responseStatus,
          headers: {},
          data,
          body: JSON.stringify(data),
        };
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
    assert.deepEqual(
      recoveryRequests.map(({ method, url }) => [method, new URL(url).pathname]),
      [['GET', '/json/'], ['GET', '/v1/payment_intents/' + originalIntentId]],
    );
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

test('an explicit subscription limit checks the original unpaid checkout and free account without another payment', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    merchantData: { status: 'subscription_limit' },
  });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.paymentOutcome, 'failed');
  assert.match(result.finish.error, /subscription_limit；原结账未付款，原账号无有效订阅/);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  assert.ok(!result.requests.some((r) => /\/v1\/payment_intents\//.test(r.url)));
  assert.equal(result.assignment.run.paymentSubmitted, true);
  const merchantIndex = result.requests.findIndex(request => request.url.endsWith('/checkout/confirm'));
  assert.ok(result.requests.slice(merchantIndex + 1).some(request => request.url.includes('/checkout/openai_llc/')));
  assert.ok(result.requests.slice(merchantIndex + 1).every(request => request.method === 'GET'));
});

test('initial checkout configuration remains available when a tax snapshot omits it', async () => {
  for (const stripeProvider of [false, true]) {
    const result = await execute({ demo: false, authorizer: boundAuthorizer, stripeProvider, checkoutConfigurationOnly: true });
    assert.equal(result.finish.status, 'completed', result.finish.error);
    assert.ok(!result.requests.some(request => request.url.endsWith('/stripe_client_bootstrap')));
    if (stripeProvider) {
      assert.equal(result.sdkRequest.publishableKey, 'pk_test_original');
      assert.equal(result.sdkRequest.customerSessionClientSecret, 'cuss_original');
      assert.match(result.sdkRequest.returnUrl, /checkout\/verify/);
    } else assert.equal(new URL(result.requests.find(request => request.url.includes('/elements/sessions'))!.url).searchParams.get('customer_session_client_secret'), 'cuss_original');
  }
});

test('browser cleanup audit retains actual headers, status and a non-JSON failure response', async () => {
  const result = await execute({ hasLoginSession: true, cleanupChat: async (_name, path, body, _headers, observe) => {
    if (path.startsWith('/api/auth/session'))
      return { accessToken: 'fixture-fresh', account: { id: 'demo-account' } };
    if (path.startsWith('/backend-api/accounts/check/'))
      return { accounts: { default: { account: { account_id: 'demo-account' } } } };
    assert.equal(path, '/backend-api/payments/checkout_session');
    observe?.({ request: { method: 'POST', url: 'https://chatgpt.com' + path, headers: { authorization: 'Bearer browser-private', 'content-type': 'application/json' }, body: JSON.stringify(body) }, status: 503, headers: { 'x-request-id': ['browser-response-fixture'] }, body: '<html>upstream unavailable</html>' });
    throw new Error('browser cleanup failed');
  } });
  const step = result.commands.filter(command => command.action === 'step').map(command => command.body.step).find(step => step.name === '原订阅完成登记' && step.status === 'failed');
  assert.equal(step.httpStatus, 503);
  assert.equal(step.request.stage, 'cleanup_registration');
  assert.equal(step.request.headers.authorization, '[REDACTED]');
  assert.equal(step.response.headers['x-request-id'][0], 'browser-response-fixture');
  assert.equal(step.response.body, '<html>upstream unavailable</html>');
  assert.ok(!JSON.stringify(step).includes('browser-private'));
});

for (const status of [200, 402]) {
  test(`Stripe confirmation HTTP ${status} publishes its original action for the customer`, async () => {
    const result = await execute({
      stripeAccount: 'acct_original',
      intentResponse(input) {
        const url = new URL(input.url);
        const intent = { id: url.pathname.split('/')[3],
          client_secret: new URLSearchParams(input.body ?? url.search).get('client_secret'),
          status: 'requires_action', next_action: { type: 'use_stripe_sdk' } };
        const responseStatus = input.method === 'POST' ? status : 200;
        const data = responseStatus === 402 ? { error: { payment_intent: intent } } : intent;
        return { status: responseStatus, headers: {}, data, body: JSON.stringify(data) };
      },
    });
    assert.equal(result.finish.status, 'awaiting_captcha', result.finish.error);
    const start = result.commands.find((c) => c.action === 'verification' && c.body.action === 'start')!.body.body;
    assert.equal(start.params.paymentIntentId, result.assignment.context.intent!.id);
    assert.equal(start.params.stripeAccount, 'acct_original');
    assert.ok(result.requests.filter((r) => new URL(r.url).hostname === 'api.stripe.com')
      .every((r) => r.headers?.['Stripe-Account'] === 'acct_original'));
    assert.equal(result.requests.filter((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url)).length, 1);
    assert.ok(!result.requests.some((r) => /verify_challenge|createTask/.test(r.url)));
  });
}

for (const shape of ['nested', 'checkout_session', 'error']) {
  test(`merchant ${shape} action is read back and handed to CDK without another confirmation`, async () => {
    const intent = { id: 'pi_original', client_secret: 'pi_original_secret_original',
      status: 'requires_action', next_action: { type: 'use_stripe_sdk' } };
    const result = await execute({
      merchantStatus: shape === 'error' ? 402 : 200,
      merchantData: shape === 'checkout_session' ? { status: 'success', checkout_session: { payment_intent: intent } }
        : shape === 'error' ? { error: { payment_intent: intent } }
        : { status: 'success', payment_intent: intent },
      intentResponse(input) {
        assert.equal(input.method, 'GET');
        return { status: 200, headers: {}, data: intent, body: JSON.stringify(intent) };
      },
    });
    assert.equal(result.finish.status, 'awaiting_captcha', result.finish.error);
    assert.equal(result.assignment.context.challenge!.id, 'customer-challenge');
    assert.equal(result.requests.filter((r) => /\/checkout\/confirm$/.test(r.url)).length, 1);
    assert.ok(!result.commands.some((c) => c.action === 'authorize' && c.body.action === 'stripe_confirm'));
    assert.ok(!result.requests.some((r) => /\/payment_intents\/[^/]+\/confirm$/.test(r.url)));
  });
}

test('an error response carrying a foreign Intent cannot replace the original or publish its challenge', async () => {
  const result = await execute({
    intentResponse() {
      const data = { error: { payment_intent: { id: 'pi_foreign', client_secret: 'pi_foreign_secret_foreign',
        status: 'requires_action' } } };
      return { status: 402, headers: {}, data, body: JSON.stringify(data) };
    },
  });
  assert.equal(result.finish.status, 'pending_confirmation');
  assert.notEqual(result.assignment.context.intent!.id, 'pi_foreign');
  assert.ok(!result.commands.some((c) => c.action === 'verification'));
});

test('a subscription limit carrying an Intent remains pending for original-payment reconciliation', async () => {
  for (const data of [
    {
      status: 'subscription_limit',
      client_secret: 'pi_original_secret_fixture',
    },
    { status: 'subscription_limit', payment_intent: { id: 'pi_original' } },
  ]) {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      merchantData: data,
    });
    assert.equal(result.finish.status, 'pending_confirmation');
    assert.notEqual(result.finish.paymentOutcome, 'failed');
  }
});

test('an explicit region refusal finishes failed after one merchant confirmation without another payment', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    merchantStatus: 403,
    merchantData: { detail: 'Checkout is not available in your region.' },
  });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.paymentOutcome, 'failed');
  assert.equal(result.finish.error, 'HTTP 403：Checkout is not available in your region.');
  assert.equal(result.finish.context.merchantConfirmation.status, 'checkout_region_unavailable');
  assert.equal(result.assignment.run.paymentSubmitted, true);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  assert.ok(!result.requests.some((r) => /\/v1\/payment_intents\//.test(r.url)));
});

test('other HTTP refusals and region responses carrying an Intent preserve the submitted boundary', async () => {
  for (const [status, data] of [
    [403, { detail: 'Forbidden' }],
    [500, { detail: 'Checkout is not available in your region.' }],
    [
      403,
      {
        detail: 'Checkout is not available in your region.',
        payment_intent: { id: 'pi_original' },
      },
    ],
    [
      403,
      {
        detail: 'Checkout is not available in your region.',
        client_secret: 'pi_original_secret_fixture',
      },
    ],
    [
      403,
      {
        detail: 'Checkout is not available in your region.',
        error: { payment_intent: { id: 'pi_original' } },
      },
    ],
  ] as const) {
    const result = await execute({
      demo: false,
      authorizer: boundAuthorizer,
      merchantStatus: status,
      merchantData: data,
    });
    assert.equal(result.finish.status, 'pending_confirmation', JSON.stringify({ status, data }));
    assert.notEqual(result.finish.paymentOutcome, 'failed');
    assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  }
});

test('hosted uses Stripe payment pages and merchant approval, records its type, and never calls custom confirmation', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutMode: 'hosted',
  });
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
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutMode: 'hosted',
  });
  const before = result.requests.length;
  const beforeCommands = result.commands.length;
  result.assignment.mode = 'reconcile';
  await new ProtocolEngine(result.assignment, result.control, result.transport, boundAuthorizer).execute();
  const replay = result.requests.slice(before);
  assert.ok(replay.length > 0);
  assert.ok(replay.every((r) => r.method === 'GET'));
  assert.ok(replay.some((r) => r.url.includes('/payment_pages/' + result.assignment.context.checkout!.id)));
  const readLogs = result.commands.slice(beforeCommands).filter(c => c.action === 'step' && c.body.step.category === 'http');
  assert.ok(readLogs.length > 0);
  assert.ok(readLogs.every(c => c.body.step.request.stage === 'stripe_result'));
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

test('hosted without returned public configuration validates the reference key on the original page before card access', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutMode: 'hosted',
    hostedKeyMissing: true,
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.match(result.assignment.context.key!, /^pk_live_/);
  assert.ok(!result.requests.some((r) => r.url.endsWith('/stripe_client_bootstrap')));
  const page = result.requests.findIndex((r) => r.url.includes('/v1/payment_pages/') && r.method === 'GET');
  const token = result.requests.findIndex((r) => r.url.endsWith('/confirmation_tokens'));
  assert.ok(page >= 0 && token > page);
});

test('Stripe rejecting the reference hosted key stops before card assignment or payment authorization', async () => {
  const result = await execute({
    demo: false,
    authorizer: boundAuthorizer,
    checkoutMode: 'hosted',
    hostedKeyMissing: true,
    hostedPageStatus: 404,
  });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.assignment.run.paymentSubmitted, false);
  assert.ok(!result.commands.some((c) => c.action === 'card' || c.action === 'authorize'));
});

async function replacementContext() {
  const initial = await execute();
  assert.equal(initial.finish.status, 'completed');
  const context = structuredClone(initial.assignment.context);
  context.intent = {
    ...context.intent,
    status: 'requires_payment_method',
    amount: context.snapshot.amount_total,
    currency: context.snapshot.currency,
    last_payment_error: { code: 'card_declined', decline_code: 'generic_decline' },
  };
  context.checkoutResume = {
    sourceRunId: 'previous-execution',
    checkoutId: context.checkout!.id,
    kind: 'card_replacement',
    intentId: context.intent.id,
  };
  delete context.confirmationToken;
  delete context.cleanup;
  return context;
}

test('a declined card continues with the original checkout, Elements and Intent without replaying merchant setup', async () => {
  const context = await replacementContext();
  const result = await execute({
    initialContext: context,
    card: { number: '4000000000000077', expiry: '12/30', cvc: '123' },
    authorizer: async () => { throw new Error('Stripe replacement must not request merchant Sentinel authorization'); },
    intentResponse: (input) => ({
      status: 200, headers: {}, body: '',
      data: { ...context.intent, status: input.method === 'GET' ? 'requires_payment_method' : 'succeeded' },
    }),
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.requests[0].method, 'GET');
  assert.equal(new URL(result.requests[0].url).hostname, 'ipapi.co');
  assert.ok(result.requests[1].url.includes('/payment_intents/' + context.intent!.id + '?'));
  const logs = result.commands.filter((c) => c.action === 'step').map((c) => c.body.step);
  const probe = logs.find((step) => step.name === '记录本单网络出口');
  const confirm = logs.find((step) => step.name === 'Stripe 原 Intent 确认');
  assert.equal(probe.response.source, 'ipapi.co');
  assert.equal(confirm.request.exitFingerprint, probe.response.exitFingerprint);
  assert.equal(confirm.request.exitProbe.observedAt, probe.response.observedAt);
  assert.equal(JSON.stringify(logs).includes(result.assignment.context.exitIp!), false);
  assert.equal(result.commands.filter((c) => c.action === 'card').length, 1);
  assert.deepEqual(result.commands.filter((c) => c.action === 'authorize' && c.body.action !== 'registration').map((c) => c.body.action), ['stripe_confirm']);
  const preparation = result.requests.slice(0, result.requests.findIndex((r) => r.method === 'POST' && r.url.includes('/payment_intents/')));
  assert.equal(preparation.some((r) => /checkout_pricing|accounts\/check|elements\/sessions|payments\/checkout/.test(r.url)), false);
  const confirmation = result.requests.filter((r) => r.url.endsWith('/' + context.intent!.id + '/confirm'));
  assert.equal(confirmation.length, 1);
  assert.equal(new URLSearchParams(confirmation[0].body).get('confirmation_token'), result.assignment.context.confirmationToken);
  const token = result.requests.find((r) => r.url.endsWith('/confirmation_tokens'))!;
  assert.equal(new URLSearchParams(token.body).get('payment_method_data[card][number]'), '4000000000000077');
  assert.deepEqual(result.assignment.context.checkout, context.checkout);
  assert.deepEqual(result.assignment.context.elements, context.elements);
  assert.deepEqual(result.assignment.context.environment, context.environment);
  assert.equal(result.commands.some((c) => c.action === 'checkpoint' && /subscription|checkout_created|taxes_ready|elements_ready/.test(c.body.stage)), false);
});

for (const changed of ['succeeded', 'processing', 'requires_action', 'canceled', 'different_amount', 'different_intent'])
  test(`replacement does not allocate a card or dispatch when the original payment changed: ${changed}`, async () => {
    const context = await replacementContext();
    const result = await execute({
      initialContext: context,
      intentResponse: () => ({
        status: 200, headers: {}, body: '',
        data: {
          ...context.intent,
          ...(changed === 'different_intent' ? { id: 'pi_foreign', client_secret: 'pi_foreign_secret_private' } : {}),
          status: changed.startsWith('different_') ? 'requires_payment_method' : changed,
          ...(changed === 'different_amount' ? { amount: context.snapshot.amount_total + 1 } : {}),
        },
      }),
    });
    assert.equal(result.commands.some((c) => c.action === 'card' || c.action === 'authorize'), false);
    assert.equal(result.requests.some((r) => r.method === 'POST'), false);
    assert.equal(result.finish.status, changed === 'different_intent' ? 'failed' : 'paused');
  });

test('a pre-dispatch failure resumes the accepted checkout without another quote, tax or Elements request', async () => {
  const context = await replacementContext();
  delete context.intent;
  context.checkoutResume!.kind = 'prepayment_retry';
  delete context.checkoutResume!.intentId;
  delete context.merchantConfirmation;
  const result = await execute({
    initialContext: context,
    checkoutReadResponse: { status: 200, headers: {}, body: '', data: { checkout_session: {
      id: context.checkout!.id, status: 'open', payment_status: 'unpaid', account_id: context.accountId,
    } } },
  });
  assert.equal(result.finish.status, 'completed', result.finish.error);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/checkout/confirm')).length, 1);
  const preparation = result.requests.slice(0, result.requests.findIndex((r) => r.method === 'POST' && r.url.includes('/payment_intents/')));
  assert.equal(preparation.some((r) => /checkout_pricing|accounts\/check|elements\/sessions|checkout\/taxes/.test(r.url)), false);
  assert.equal(result.requests.some((r) => r.method === 'POST' && r.url.endsWith('/payments/checkout')), false);
});
