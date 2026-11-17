import { reconcileHostedCheckout } from './hosted-checkout.js';
import { form } from './http-utils.js';
import type { ExecutionServices } from './services.js';
export async function reconcilePayment(services: ExecutionServices) {
  const challenge = services.context.challenge;
  if (
    challenge &&
    services.assignment.run.challengeId &&
    !challenge.completed &&
    !challenge.expired &&
    !services.context.verificationReceipt
  ) {
    const result = await services
      .command('verification', {
        action: 'result',
        body: { challengeId: services.assignment.run.challengeId },
      })
      .catch(async (error: Error) => {
        // Transport failures do not expire a customer's live SDK action.
        if ((error as any).status === 410 || (error as any).statusCode === 410) {
          challenge.expired = true;
          challenge.error = error.message;
        }
        await services.log({
          name: '读取客户验证结果',
          status: 'pending',
          error: error.message,
        });
        return null;
      });
    if (result) {
      const source = challenge.source;
      if (
        result.challengeId !== challenge.id ||
        result.kind !== 'stripe' ||
        !source ||
        !['documentNonce', 'widgetId', 'revision', 'url', 'mode'].every(
          (key) => result.source?.[key] === source[key],
        )
      )
        throw new Error('客户验证回执不属于原挑战或原付款');
      if (['expired', 'cancelled', 'rejected'].includes(result.state)) {
        challenge.expired = true;
        challenge.error = result.error?.message || '客户验证已结束';
      } else if (['result_received', 'applied'].includes(result.state)) {
        if (
          result.verificationResult?.paymentIntentId !== services.context.intent?.id ||
          !/^[a-f0-9]{64}$/.test(result.tokenHash || '') ||
          result.token
        )
          throw new Error('客户验证结果与原 Intent 不匹配');
        services.context.verificationReceipt = {
          challengeId: challenge.id,
          tokenHash: result.tokenHash,
          status: 'applied',
        };
        // Persist the notification digest before acknowledgement. No CAPTCHA
        // token is applied here: CDK's official Stripe SDK owns that action.
        await services.checkpoint('verification_result_received');
      } else if (result.state !== 'waiting') {
        throw new Error('客户验证返回了无法识别的状态');
      }
    }
  }
  if (services.context.intent?.id && services.context.intent.client_secret && services.context.key) {
    const old = services.context.intent;
    const result = await services.stripe(
      '只读核对原付款',
      '/v1/payment_intents/' +
        old.id +
        '?' +
        form({ key: services.context.key, client_secret: old.client_secret }),
    );
    if (result.id !== old.id) throw new Error('付款查询返回了其他 Intent');
    services.context.intent = { ...result, client_secret: old.client_secret };
    if (services.context.verificationReceipt) {
      try {
        await services.acknowledgeVerification();
      } catch (error) {
        await services.log({
          name: '客户验证接收回执待确认',
          status: 'pending',
          error: (error as Error).message,
        });
        await services.checkpoint('verification_receipt_pending');
      }
    }
    await services.handleIntent();
    return;
  }
  if (services.context.checkout?.id?.startsWith('cs_') && services.context.key) {
    await reconcileHostedCheckout(services);
    return;
  }
  if (services.context.checkout?.id) {
    const checkout = services.context.checkout;
    const data = await services.chat(
      '只读核对原商户结账',
      '/backend-api/payments/checkout/' +
        encodeURIComponent(checkout.processor_entity) +
        '/' +
        encodeURIComponent(checkout.id),
    );
    const snapshot = data.checkout_session || data;
    const returnedId = snapshot.checkout_session_id || snapshot.id;
    if (returnedId && returnedId !== checkout.id) throw new Error('商户查询返回了其他结账');
    if (snapshot.processor_entity && snapshot.processor_entity !== checkout.processor_entity)
      throw new Error('商户查询处理方不匹配');
    if (snapshot.status === 'complete' && snapshot.payment_status === 'paid' && returnedId === checkout.id) {
      await services.success();
      return;
    }
    if (snapshot.payment_intent?.client_secret) services.context.intent = snapshot.payment_intent;
    // An explicit merchant refusal is distinct from a lost confirmation
    // response. Resolve only this known refusal after checking the original
    // unpaid checkout and current account; never infer failure from unpaid
    // alone, and never override a successful checkout above.
    const confirmation = services.context.merchantConfirmation;
    if (
      ['subscription_limit', 'checkout_region_unavailable'].includes(confirmation?.status) &&
      !confirmation.client_secret &&
      !confirmation.payment_intent &&
      !services.context.intent &&
      !snapshot.payment_intent &&
      !snapshot.client_secret &&
      snapshot.status === 'open' &&
      snapshot.payment_status === 'unpaid' &&
      returnedId === checkout.id &&
      (!snapshot.account_id || snapshot.account_id === services.context.accountId) &&
      services.assignment.run.dispatches.merchant_confirm &&
      Object.keys(services.assignment.run.dispatches).every((action) => action === 'merchant_confirm')
    ) {
      const info = await services.chat(
        '复核商户拒绝后的原账号订阅',
        '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
      );
      const selected = (Object.values(info.accounts || {}) as any[]).find(
        (account) => (account.account?.account_id || account.account?.id) === services.context.accountId,
      );
      if (
        selected?.entitlement?.has_active_subscription === false &&
        selected.account?.plan_type === 'free'
      ) {
        await services.command('finish', {
          status: 'failed',
          paymentOutcome: 'failed',
          context: services.context,
          error:
            '商户明确拒绝：' +
            (confirmation.status === 'subscription_limit'
              ? 'subscription_limit'
              : 'Checkout is not available in your region.') +
            '；原结账未付款，原账号无有效订阅',
        });
        return;
      }
    }
  }
  await services.park('pending_confirmation', '原付款尚无明确结果，继续只读核对');
}
