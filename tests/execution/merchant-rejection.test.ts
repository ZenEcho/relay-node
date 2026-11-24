import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

async function run(change: any = {}) {
  const assignment: any = {
    mode: 'reconcile',
    demo: false,
    run: {
      id: 'original',
      order: {},
      paymentSubmitted: true,
      dispatches: { merchant_confirm: 'sent' },
      workflow: { cleanup: {} },
    },
    context: {
      session: { accessToken: 'fixture' },
      accountId: 'account-original',
      environment: createEnvironment('PH', ''),
      checkout: { id: 'oaics_original', processor_entity: 'openai_llc' },
      merchantConfirmation: { status: 'subscription_limit' },
    },
  };
  if (change.confirmation) assignment.context.merchantConfirmation = change.confirmation;
  if (change.dispatch) assignment.run.dispatches[change.dispatch] = 'sent';
  const requests: any[] = [],
    commands: any[] = [];
  const snapshot = {
    checkout_session_id: 'oaics_original',
    status: 'open',
    payment_status: 'unpaid',
    ...change.checkout,
  };
  const transport = {
    initialize: async () => {},
    close() {},
    async request(input: any) {
      assert.equal(input.method, 'GET');
      requests.push(input);
      const data = input.url.includes('/accounts/check/')
        ? {
            accounts: {
              original: {
                account: {
                  account_id: change.accountId || 'account-original',
                  plan_type: 'free',
                },
                entitlement: {
                  has_active_subscription: change.active ?? false,
                },
              },
            },
          }
        : snapshot;
      return { status: 200, headers: {}, data, body: JSON.stringify(data) };
    },
  };
  await new ProtocolEngine(
    assignment,
    {
      async request(action, body) {
        commands.push({ action, body });
        return {};
      },
    },
    transport,
  ).execute();
  return {
    requests: requests.filter(({ url }) => /\/accounts\/check\/|\/payments\/checkout\//.test(url)),
    probe: commands.find((c) => c.action === 'step' && c.body.step.name === '记录本单网络出口')?.body.step,
    finish: commands.filter((c) => c.action === 'finish').at(-1)?.body,
  };
}
test('explicit subscription limit resolves failed only after original unpaid checkout and current free account', async () => {
  const result = await run();
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.paymentOutcome, 'failed');
  assert.equal(result.requests.length, 2);
  assert.equal(result.probe.status, 'failed');
  assert.equal(result.probe.response.observed, false);
});

test('a recorded region refusal resolves failed only after checking the original unpaid checkout and free account', async () => {
  const confirmation = { status: 'checkout_region_unavailable' };
  const result = await run({ confirmation });
  assert.equal(result.finish.status, 'failed');
  assert.equal(result.finish.paymentOutcome, 'failed');
  assert.match(result.finish.error, /Checkout is not available in your region\./);
  assert.equal(result.requests.length, 2);
  for (const change of [
    { active: true },
    { checkout: { payment_intent: 'pi_original' } },
    { dispatch: 'stripe_confirm' },
    { accountId: 'other' },
  ]) {
    const pending = await run({ confirmation, ...change });
    assert.equal(pending.finish.status, 'pending_confirmation');
    assert.notEqual(pending.finish.paymentOutcome, 'failed');
  }
});
test('unpaid alone, active or mismatched account, possible intent and later dispatch keep original payment pending', async () => {
  for (const change of [
    { confirmation: {} },
    { active: true },
    { accountId: 'other' },
    { checkout: { payment_intent: 'pi_original' } },
    {
      confirmation: {
        status: 'subscription_limit',
        client_secret: 'pi_original_secret_fixture',
      },
    },
    { dispatch: 'stripe_confirm' },
    { checkout: { status: 'expired' } },
    { checkout: { account_id: 'other' } },
  ]) {
    const result = await run(change);
    assert.equal(result.finish.status, 'pending_confirmation', JSON.stringify(change));
    assert.notEqual(result.finish.paymentOutcome, 'failed');
  }
});
