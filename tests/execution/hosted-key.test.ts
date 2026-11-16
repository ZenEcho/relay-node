import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedPublishableKey } from '../../apps/worker/src/execution/hosted-checkout.js';
const bytes = Buffer.from(JSON.stringify({ apiKey: 'pk_live_fixture' }));
for (let i = 0; i < bytes.length; i++) bytes[i] ^= 5;
const fragment = bytes.toString('base64');
test('hosted public configuration is bound to the original session and trusted URL', () => {
  assert.equal(
    hostedPublishableKey(
      'https://checkout.stripe.com/c/pay/cs_live_original#' + fragment,
      'cs_live_original',
    ),
    'pk_live_fixture',
  );
  for (const url of [
    'http://checkout.stripe.com/c/pay/cs_live_original#' + fragment,
    'https://checkout.stripe.com.evil.invalid/c/pay/cs_live_original#' + fragment,
    'https://checkout.stripe.com/c/pay/cs_live_other#' + fragment,
    'https://user:password@checkout.stripe.com/c/pay/cs_live_original#' + fragment,
    'https://checkout.stripe.com/c/pay/cs_live_original#invalid',
  ])
    assert.equal(hostedPublishableKey(url, 'cs_live_original'), undefined);
});
