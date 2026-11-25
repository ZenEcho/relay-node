import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptCheckoutMode,
  checkoutModeFromId,
  isCheckoutModeRejection,
  modeFallbackBlocked,
  zeroAmountRequiresCustom,
} from '../../apps/worker/src/execution/checkout-mode.js';
import { UpstreamError } from '../../apps/worker/src/execution/http-utils.js';

test('session prefix outranks a contradictory checkout_ui_mode label', () => {
  // 线上 hosted 建单的回包：checkout_ui_mode/tag 仍写 custom，但会话是 cs_live_。
  // Stripe 的确认接口只认会话本身，所以前缀说了算，不能判成"类型不匹配"。
  assert.deepEqual(
    adoptCheckoutMode(
      'hosted',
      'custom',
      'cs_live_a0mGUqkQFb3QR6IuHWCGUjasnHJjQOABh4amSyetDan1oevoy5xucjKptI',
    ),
    { mode: 'hosted', official: false },
  );
  assert.deepEqual(adoptCheckoutMode('custom', 'hosted', 'oaics_c05ec757b5484544b125370d8488dc3f'), {
    mode: 'custom',
    official: false,
  });
  // 标签和前缀一致时，就是官方覆盖了我们的偏好。
  assert.deepEqual(adoptCheckoutMode('custom', 'hosted', 'cs_live_1'), {
    mode: 'hosted',
    official: true,
  });
  assert.deepEqual(adoptCheckoutMode('hosted', 'custom', 'oaics_1'), {
    mode: 'custom',
    official: true,
  });
  // 官方同意偏好时不算覆盖。
  assert.deepEqual(adoptCheckoutMode('custom', 'custom', 'oaics_1'), {
    mode: 'custom',
    official: false,
  });
});

test('without a recognizable prefix, the declared mode wins, then the request', () => {
  assert.deepEqual(adoptCheckoutMode('custom', 'hosted', 'unknown'), {
    mode: 'hosted',
    official: true,
  });
  assert.deepEqual(adoptCheckoutMode('hosted', 'custom', undefined), {
    mode: 'custom',
    official: true,
  });
  assert.deepEqual(adoptCheckoutMode('hosted', undefined, 'unknown'), {
    mode: 'hosted',
    official: false,
  });
  assert.deepEqual(adoptCheckoutMode('custom', 'embedded', 'oaics_1'), {
    mode: 'custom',
    official: false,
  });
  assert.deepEqual(adoptCheckoutMode('custom', 'embedded', 'unknown'), {
    mode: 'custom',
    official: false,
  });
});

test('session prefix always identifies the mode', () => {
  assert.equal(checkoutModeFromId('oaics_3a55ec42fb22421d8c1e6389a9beda88'), 'custom');
  assert.equal(checkoutModeFromId('cs_live_a1b2'), 'hosted');
  assert.equal(checkoutModeFromId('cs_test_a1b2'), 'hosted');
  for (const value of ['', 'oaics_', 'cs_', 'pi_1', 'oaics_1/../cs_2', 42, null, undefined])
    assert.equal(checkoutModeFromId(value), undefined);
});

test('zero amount only runs on the custom (oaics_) checkout', () => {
  assert.equal(zeroAmountRequiresCustom('custom', 0), false);
  assert.equal(zeroAmountRequiresCustom('hosted', 0), true);
  for (const amount of [1, 98214, 110000])
    assert.equal(zeroAmountRequiresCustom('hosted', amount), false);
});

test('only a mode-shaped official rejection is worth the other mode', () => {
  const rejection = (status: number, data: any) =>
    new UpstreamError('创建支付链接失败', status, data);
  assert.equal(isCheckoutModeRejection(rejection(400, { detail: 'checkout_ui_mode is not supported' })), true);
  assert.equal(isCheckoutModeRejection(rejection(422, { error: { message: 'Unsupported checkout UI mode' } })), true);
  // 地区不可用、会话过期、5xx 与网络错误不能当模式问题重试。
  assert.equal(isCheckoutModeRejection(rejection(403, { detail: 'Checkout is not available in your region.' })), false);
  assert.equal(isCheckoutModeRejection(rejection(401, { detail: 'checkout_ui_mode' })), false);
  assert.equal(isCheckoutModeRejection(rejection(500, { detail: 'checkout_ui_mode' })), false);
  assert.equal(isCheckoutModeRejection(new Error('checkout_ui_mode')), false);
});

test('a fallback pinned back to the declined mode stops instead of opening a card', () => {
  assert.equal(modeFallbackBlocked('custom', 'custom'), true);
  assert.equal(modeFallbackBlocked('hosted', 'hosted'), true);
  assert.equal(modeFallbackBlocked('hosted', 'custom'), false);
  assert.equal(modeFallbackBlocked('custom', undefined), false);
  assert.equal(modeFallbackBlocked('custom', 'nonsense'), false);
});
