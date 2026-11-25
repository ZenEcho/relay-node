import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostedAmountTotal,
  hostedSubmissionFailure,
} from '../../apps/worker/src/execution/hosted-checkout.js';

test('the checkout page amount wins over any snapshot total', () => {
  assert.equal(hostedAmountTotal({ total_summary: { due: 98214, total: 110000 } }), 98214);
  assert.equal(hostedAmountTotal({ total_summary: { total: 110000 } }), 110000);
  assert.equal(hostedAmountTotal({ amount_due: 0 }), 0);
  assert.equal(hostedAmountTotal({ checkout_session: { total_summary: { due: 1234 } } }), 1234);
  assert.equal(hostedAmountTotal({ invoice: { amount_due: 500 } }), 500);
  for (const value of [{}, { total_summary: { due: -1 } }, { total_summary: { due: 1.5 } }, null])
    assert.equal(hostedAmountTotal(value), undefined);
});

test('a failed submission attempt reports the Stripe error code', () => {
  assert.equal(
    hostedSubmissionFailure({
      submission_attempt: { state: 'failed', error: { code: 'checkout_upcoming_invoice_mismatch' } },
    }),
    'checkout_upcoming_invoice_mismatch',
  );
  assert.equal(
    hostedSubmissionFailure({ submission_attempt: { state: 'failed', error: { decline_code: 'card_declined' } } }),
    'card_declined',
  );
  // 审批前、成功后和普通页面都不算失败。
  assert.equal(hostedSubmissionFailure({ submission_attempt: { state: 'requires_approval' } }), undefined);
  assert.equal(hostedSubmissionFailure({ submission_attempt: { state: 'succeeded' } }), undefined);
  assert.equal(hostedSubmissionFailure({ status: 'open', payment_status: 'unpaid' }), undefined);
  assert.equal(hostedSubmissionFailure(null), undefined);
});
