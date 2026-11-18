import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';

type StripeConfigurationSource = {
  publishable_key?: unknown;
  stripe_publishable_key?: unknown;
  stripe?: { publishable_key?: unknown };
  stripe_account?: unknown;
  livemode?: unknown;
};

function invalidConfiguration(message: string): never {
  throw Object.assign(new Error(message), { code: 'STRIPE_CHECKOUT_CONFIGURATION', retryable: false });
}

function consistentValue(label: string, pattern: RegExp, values: unknown[]): string | undefined {
  let selected: string | undefined;
  for (const value of values) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !pattern.test(value))
      invalidConfiguration(`原结账的 ${label} 格式无效`);
    if (selected && selected !== value) invalidConfiguration(`原结账的 ${label} 前后不一致`);
    selected = value;
  }
  return selected;
}

export function bindStripeCheckoutConfiguration(
  context: RuntimeContext,
  source: StripeConfigurationSource | undefined = context.snapshot,
  fallbackKey?: unknown,
) {
  const keyFormat = /^pk_(?:live|test)_[a-zA-Z0-9_]{1,512}$/;
  const key =
    consistentValue('Stripe publishable key', keyFormat, [
      context.key,
      source?.publishable_key,
      source?.stripe_publishable_key,
      source?.stripe?.publishable_key,
    ]) ?? consistentValue('Stripe publishable key', keyFormat, [fallbackKey]);
  const account = consistentValue('Stripe-Account', /^acct_[a-zA-Z0-9_]{1,128}$/, [
    context.stripeAccount,
    context.snapshot?.stripe_account,
    source?.stripe_account,
  ]);
  if (key && typeof source?.livemode === 'boolean' && source.livemode !== key.startsWith('pk_live_'))
    invalidConfiguration('原结账的 Stripe 环境与 publishable key 不一致');
  context.key = key;
  context.stripeAccount = account;
  if (context.snapshot && account) context.snapshot.stripe_account = account;
}
