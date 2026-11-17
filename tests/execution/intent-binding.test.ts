import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentIntentFromResponse, verificationSourceUrl } from '../../apps/worker/src/execution/intent-binding.js';

const original = { id: 'pi_original', client_secret: 'pi_original_secret_original', status: 'requires_action',
  next_action: { type: 'use_stripe_sdk', revision: 1 } };

test('original Intent binding accepts direct, nested and error responses without losing partial action context', () => {
  for (const payload of [original, { payment_intent: original }, { error: { payment_intent: original } },
    { payment_page: { payment_intent: original } }, { checkout_session: { payment_intent: original } },
    { payment_intent: original.id, payment_intent_client_secret: original.client_secret,
      payment_intent_status: original.status, next_action: original.next_action }]) {
    assert.deepEqual(paymentIntentFromResponse(payload), original);
  }
  assert.deepEqual(paymentIntentFromResponse({ id: original.id, status: 'processing' }, original),
    { ...original, status: 'processing' });
  assert.equal(paymentIntentFromResponse({ status: 'open', payment_intent: original.id,
    payment_intent_status: 'processing' }, original)?.status, 'processing');
});

test('conflicting Intent identities and credentials never replace the original payment', () => {
  for (const payload of [
    { ...original, id: 'pi_foreign' },
    { ...original, client_secret: 'pi_original_secret_foreign' },
    { client_secret: original.client_secret, payment_intent: 'pi_foreign' },
    { payment_intent: original, error: { payment_intent: { ...original, id: 'pi_foreign' } } },
  ]) assert.throws(() => paymentIntentFromResponse(payload, original), /原 Intent/);
});

test('Hosted verification sources retain only the bound payment page origin and path', () => {
  const checkout = { id: 'cs_test_original', processor_entity: 'openai_llc' };
  assert.equal(verificationSourceUrl(checkout), 'https://checkout.stripe.com/c/pay/cs_test_original');
  assert.equal(verificationSourceUrl({ ...checkout,
    url: 'https://pay.openai.com/c/pay/cs_test_original?locale=en#private' }),
    'https://pay.openai.com/c/pay/cs_test_original');
  for (const url of ['https://checkout.stripe.com/c/pay/cs_test_foreign',
    'https://foreign.invalid/c/pay/cs_test_original', 'https://checkout.stripe.com:444/c/pay/cs_test_original'])
    assert.throws(() => verificationSourceUrl({ ...checkout, url }), /原 Hosted/);
});
