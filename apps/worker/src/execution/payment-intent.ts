import { createHash } from 'node:crypto';
import { verificationSourceUrl } from './intent-binding.js';
import type { ExecutionServices } from './services.js';
export async function handlePaymentIntent(services: ExecutionServices) {
  const intent = services.context.intent!;
  if (intent.status === 'succeeded') {
    await services.success();
    return;
  }
  if (['requires_payment_method', 'canceled'].includes(intent.status)) {
    await services.command('finish', {
      status: 'failed',
      paymentOutcome: 'failed',
      context: services.context,
      error: intent.last_payment_error?.message || '原付款已明确失败',
    });
    return;
  }
  if (intent.status === 'requires_action') {
    const next = intent.next_action || {};
    const signature = createHash('sha256').update(JSON.stringify(next)).digest('hex');
    const prior = services.context.challenge;
    if (
      prior?.nextActionSignature &&
      intent.next_action != null &&
      prior.nextActionSignature !== signature
    ) {
      delete services.context.challenge;
      services.assignment.run.challengeId = undefined;
    } else if (prior?.completed) {
      await services.park('pending_confirmation', '验证通知已接收，继续只读核对原付款');
      return;
    }
    if (services.assignment.run.executionExhausted) {
      await services.park('pending_confirmation', '执行重试次数已用完，后台继续核对原付款');
      return;
    }
    if (services.context.challenge?.expired) {
      await services.park(
        'pending_confirmation',
        '原客户验证已失效，保留原付款并继续核对；' + services.context.challenge.error,
      );
      return;
    }
    if (!services.context.challenge) {
      if (
        !/^pi_[a-zA-Z0-9]+$/.test(intent.id || '') ||
        !String(intent.client_secret || '').startsWith(intent.id + '_secret_') ||
        !/^pk_(test|live)_[a-zA-Z0-9]+$/.test(services.context.key || '')
      )
        throw new Error('原付款的 Stripe 客户验证参数不完整');
      const revision = (services.context.verificationRevision || 0) + 1;
      const source = {
        documentNonce: services.context.environment.id,
        widgetId: intent.id,
        revision,
        url: verificationSourceUrl(services.context.checkout!),
        canApply: true,
        mode: 'stripe',
      };
      await services.checkpoint('verification_ready');
      const response = await services.command('verification', {
        action: 'start',
        body: {
          kind: 'stripe',
          source,
          params: {
            paymentIntentId: intent.id,
            clientSecret: intent.client_secret,
            publishableKey: services.context.key,
            ...(services.context.snapshot?.stripe_account
              ? { stripeAccount: services.context.snapshot.stripe_account }
              : {}),
            status: 'requires_action',
          },
        },
      });
      const published = response.challengeId ? response : response.challenge;
      if (
        !/^[a-zA-Z0-9_-]{1,150}$/.test(published?.challengeId || '') ||
        published.state !== 'waiting' ||
        published.kind !== 'stripe' ||
        !Number.isFinite(published.expiresAt) ||
        published.expiresAt <= Date.now() ||
        (response.challengeId &&
          response.challenge?.challengeId &&
          response.challengeId !== response.challenge.challengeId)
      )
        throw new Error('CDK 未确认有效的原付款验证请求');
      services.context.verificationRevision = revision;
      services.context.challenge = {
        id: published.challengeId,
        source,
        expiresAt: published.expiresAt,
        nextActionType: next.type,
        nextActionSignature: signature,
      };
      services.assignment.run.challengeId = published.challengeId;
      await services.checkpoint('verification_waiting');
    }
    await services.park('awaiting_captcha', '等待客户完成原付款验证');
    return;
  }
  await services.park('pending_confirmation', '原付款状态：' + String(intent.status || 'unknown'));
}
