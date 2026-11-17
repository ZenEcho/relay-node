import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

function fixture() {
  const environment = createEnvironment('PH', '');
  environment.cookies.push({
    name: '__Secure-next-auth.session-token',
    value: 'fixture-cookie',
    domain: 'chatgpt.com',
  });
  const assignment: any = {
    run: {
      id: 'fixture-run',
      paymentSubmitted: true,
      paymentOutcome: 'unknown',
      dispatches: {},
      workflow: { cleanup: {} },
      order: {},
    },
    context: {
      environment,
      session: { accessToken: 'fixture' },
      accountId: 'demo-account',
      checkout: { id: 'oaics_original', processor_entity: 'openai_llc' },
      key: 'pk_test_original',
      intent: {
        id: 'pi_original',
        client_secret: 'pi_original_secret_original',
      },
    },
    mode: 'reconcile',
    demo: true,
  };
  const requests: any[] = [],
    commands: any[] = [],
    checkpoints: any[] = [];
  let intent: any = {
    id: 'pi_original',
    status: 'requires_action',
    next_action: { type: 'use_stripe_sdk', revision: 1 },
  };
  let hostedPage: any;
  let notification: any;
  let receiptFailures = 0;
  let resultFailures = 0;
  let registrationSuccess = true;
  let cancellationWorks = true;
  let renew = true;
  let revision = 0;
  const control = {
    async request(action: string, body: any = {}) {
      commands.push({ action, body: structuredClone(body) });
      if (action === 'checkpoint') checkpoints.push(structuredClone(body.context));
      if (action === 'authorize') {
        assert.ok(
          !assignment.run.dispatches[body.action],
          'No repeated financial/registration dispatch',
        );
        assignment.run.dispatches[body.action] = 'recorded';
      }
      if (action === 'verification') {
        if (body.action === 'start')
          return {
            challengeId: 'challenge-' + ++revision,
            kind: 'stripe',
            state: 'waiting',
            expiresAt: Date.now() + 300000,
          };
        if (body.action === 'result') {
          if (resultFailures-- > 0)
            throw Object.assign(new Error('temporary disconnect'), {
              status: 503,
            });
          return (
            notification || {
              challengeId: assignment.run.challengeId,
              kind: 'stripe',
              state: 'waiting',
              source: assignment.context.challenge.source,
            }
          );
        }
        if (body.action === 'receipt') {
          if (receiptFailures-- > 0) throw new Error('receipt response lost');
          return { challengeId: body.body.challengeId, state: 'applied' };
        }
      }
      return { ok: true };
    },
  };
  class Transport extends DemoTransport {
    constructor() {
      super(0);
    }
    override async request(input: any) {
      requests.push(structuredClone(input));
      const path = new URL(input.url).pathname;
      let data: any;
      if (path.startsWith('/v1/payment_intents/')) {
        assert.equal(
          input.method,
          'GET',
          'Verification recovery must never confirm/capture a payment',
        );
        data = structuredClone(intent);
      } else if (path.startsWith('/v1/payment_pages/') && hostedPage)
        data = structuredClone(hostedPage);
      else if (path.endsWith('/payments/checkout_session'))
        data = { success: registrationSuccess };
      else if (path.endsWith('/subscriptions/cancel')) {
        if (cancellationWorks) renew = false;
        data = { success: true };
      } else if (path.endsWith('/subscriptions')) data = { will_renew: renew };
      else return super.request(input);
      return { status: 200, headers: {}, body: JSON.stringify(data), data };
    }
  }
  const execute = async () => {
    await new ProtocolEngine(assignment, control, new Transport()).execute();
    return commands.filter((c) => c.action === 'finish').at(-1)?.body;
  };
  return {
    assignment,
    requests,
    commands,
    checkpoints,
    execute,
    intent: (v: any) => {
      intent = v;
    },
    page: (v: any) => { hostedPage = v; },
    notify: (overrides: any = {}) => {
      notification = {
        challengeId: assignment.run.challengeId,
        kind: 'stripe',
        state: 'result_received',
        source: structuredClone(assignment.context.challenge.source),
        tokenHash: 'a'.repeat(64),
        token: '',
        verificationResult: {
          paymentIntentId: 'pi_original',
          status: 'succeeded',
        },
        ...overrides,
      };
    },
    receiptFails: (n: number) => {
      receiptFailures = n;
    },
    resultFails: (n: number) => {
      resultFailures = n;
    },
    rejectRegistration: () => {
      registrationSuccess = false;
    },
    rejectCancellation: () => {
      cancellationWorks = false;
    },
  };
}

test('current CDK top-level challenge is bound and repeated waiting polls publish no second challenge', async () => {
  const f = fixture();
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  assert.equal(f.assignment.run.challengeId, 'challenge-1');
  const start = f.commands.find((c) => c.action === 'verification' && c.body.action === 'start')
    .body.body;
  assert.equal(start.params.paymentIntentId, 'pi_original');
  assert.equal(start.params.clientSecret, 'pi_original_secret_original');
  assert.equal(start.params.publishableKey, 'pk_test_original');
  assert.equal(start.source.documentNonce, f.assignment.context.environment.id);
  assert.equal(start.source.mode, 'stripe');
  await f.execute();
  assert.equal(
    f.commands.filter((c) => c.action === 'verification' && c.body.action === 'start').length,
    1,
  );
  assert.ok(f.requests.every((r) => r.method === 'GET'));
});

for (const name of ['foreign Intent', 'foreign source', 'missing digest', 'raw CAPTCHA token']) {
  test('a ' + name + ' notification cannot establish success or reach a Stripe write', async () => {
    const f = fixture();
    await f.execute();
    f.notify(
      name === 'foreign Intent'
        ? {
            verificationResult: {
              paymentIntentId: 'pi_foreign',
              status: 'succeeded',
            },
          }
        : name === 'foreign source'
          ? {
              source: {
                ...f.assignment.context.challenge.source,
                documentNonce: 'foreign',
              },
            }
          : name === 'missing digest'
            ? { tokenHash: '' }
            : { token: 'foreign-token' },
    );
    const result = await f.execute();
    assert.equal(result.status, 'pending_confirmation');
    assert.ok(
      !f.commands.some(
        (c) => c.action === 'finish' && ['paid', 'completed'].includes(c.body.status),
      ),
    );
    assert.ok(!f.commands.some((c) => c.action === 'verification' && c.body.action === 'receipt'));
    assert.ok(f.requests.every((r) => r.method === 'GET'));
  });
}

test('customer success notification only wakes read-only polling; a lost receipt survives worker restart', async () => {
  const f = fixture();
  await f.execute();
  f.notify();
  f.receiptFails(1);
  f.intent({ id: 'pi_original', status: 'processing' });
  assert.equal((await f.execute()).status, 'pending_confirmation');
  assert.ok(f.assignment.context.verificationReceipt);
  assert.ok(f.checkpoints.some((c) => c.verificationReceipt?.tokenHash === 'a'.repeat(64)));
  assert.ok(!f.commands.some((c) => c.action === 'finish' && c.body.status === 'paid'));
  await f.execute();
  assert.equal(f.assignment.context.verificationReceipt, undefined);
  assert.equal(f.assignment.context.challenge.completed, true);
  assert.equal(
    f.commands.filter((c) => c.action === 'verification' && c.body.action === 'result').length,
    1,
  );
  assert.equal(
    f.commands.filter((c) => c.action === 'verification' && c.body.action === 'receipt').length,
    2,
  );
  assert.ok(f.requests.every((r) => r.method === 'GET'));
});

test('temporary CDK result disconnect does not expire a live challenge or create another SDK action', async () => {
  const f = fixture();
  await f.execute();
  f.resultFails(1);
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  assert.ok(!f.assignment.context.challenge.expired);
  await f.execute();
  assert.equal(
    f.commands.filter((c) => c.action === 'verification' && c.body.action === 'start').length,
    1,
  );
});

test('only a changed original next_action starts a new verification revision', async () => {
  const f = fixture();
  await f.execute();
  f.notify();
  assert.equal((await f.execute()).status, 'pending_confirmation');
  assert.equal(
    f.commands.filter((c) => c.action === 'verification' && c.body.action === 'start').length,
    1,
  );
  f.intent({
    id: 'pi_original',
    status: 'requires_action',
    next_action: { type: 'use_stripe_sdk', revision: 2 },
  });
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  const starts = f.commands.filter((c) => c.action === 'verification' && c.body.action === 'start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].body.body.source.revision, 2);
});

test('a changed action replaces a waiting challenge while partial reads keep the same customer page', async () => {
  const f = fixture();
  await f.execute();
  f.intent({ id: 'pi_original', status: 'requires_action' });
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  assert.equal(f.assignment.run.challengeId, 'challenge-1');
  f.intent({ id: 'pi_original', status: 'requires_action', next_action: { type: 'use_stripe_sdk', revision: 2 } });
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  assert.equal(f.assignment.run.challengeId, 'challenge-2');
  assert.equal(f.assignment.context.challenge.source.revision, 2);
  assert.ok(f.requests.every((r) => r.method === 'GET'));
});

test('read-only verification uses the original Stripe account and rejects a changed client secret', async () => {
  const f = fixture();
  f.assignment.context.snapshot = { stripe_account: 'acct_original' };
  await f.execute();
  assert.equal(f.requests.at(-1).headers['Stripe-Account'], 'acct_original');
  f.intent({ id: 'pi_original', client_secret: 'pi_original_secret_foreign', status: 'succeeded' });
  const result = await f.execute();
  assert.equal(result.status, 'pending_confirmation');
  assert.equal(f.assignment.context.intent.client_secret, 'pi_original_secret_original');
  assert.ok(!f.commands.some((c) => c.action === 'finish' && c.body.status === 'paid'));
});

test('Hosted page recovery binds its separate Intent secret and publishes the original Hosted source', async () => {
  const f = fixture();
  f.assignment.context.checkout = { id: 'cs_test_original', processor_entity: 'openai_llc',
    url: 'https://pay.openai.com/c/pay/cs_test_original?locale=en#private-config' };
  f.assignment.context.checkoutMode = 'hosted';
  delete f.assignment.context.intent;
  f.page({ id: 'cs_test_original', status: 'open', payment_status: 'unpaid',
    payment_intent: 'pi_original', payment_intent_client_secret: 'pi_original_secret_original',
    payment_intent_status: 'requires_action', next_action: { type: 'use_stripe_sdk', revision: 1 } });
  assert.equal((await f.execute()).status, 'awaiting_captcha');
  const start = f.commands.find((c) => c.action === 'verification' && c.body.action === 'start').body.body;
  assert.equal(start.source.url, 'https://pay.openai.com/c/pay/cs_test_original');
  assert.equal(start.params.paymentIntentId, 'pi_original');
  assert.equal(start.params.clientSecret, 'pi_original_secret_original');
  assert.ok(f.requests.some((r) => /\/v1\/payment_intents\/pi_original\?/.test(r.url)));
  assert.ok(f.requests.every((r) => r.method === 'GET'));
});

test('paid cleanup recovery registers once and cancellation failure never turns payment into failure', async () => {
  const f = fixture();
  f.assignment.mode = 'cleanup';
  f.assignment.run.paymentOutcome = 'succeeded';
  f.assignment.run.workflow.cleanup = {
    refresh: true,
    cancel: true,
    invoices: true,
  };
  f.rejectCancellation();
  const result = await f.execute();
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.registration.status, 'succeeded');
  assert.equal(result.cleanup.cancel.status, 'failed');
  assert.equal(result.cleanup.refresh.status, 'succeeded');
  assert.equal(result.cleanup.invoices.status, 'succeeded');
  assert.ok(f.assignment.context.latestSession);
  assert.ok(!f.commands.some((c) => c.action === 'finish' && c.body.status === 'failed'));
  await f.execute();
  assert.equal(f.requests.filter((r) => r.url.endsWith('/payments/checkout_session')).length, 1);
  assert.ok(!f.requests.some((r) => /\/confirm(?:\?|$)/.test(r.url)));
});

test('a non-success merchant registration is retained as cleanup failure and is not silently replayed', async () => {
  const f = fixture();
  f.assignment.mode = 'cleanup';
  f.rejectRegistration();
  assert.equal((await f.execute()).cleanup.registration.status, 'failed');
  assert.equal((await f.execute()).cleanup.registration.status, 'failed');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/payments/checkout_session')).length, 1);
  assert.ok(
    f.commands.filter((c) => c.action === 'finish').every((c) => c.body.status === 'completed'),
  );
});
