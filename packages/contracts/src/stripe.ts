import type { Billing } from './execution.js';

export type StripeTokenRequest = {
  checkoutId: string;
  accountId: string;
  environmentId: string;
  deviceId: string;
  publishableKey: string;
  stripeAccount?: string;
  customerSessionClientSecret?: string;
  amountMinor: number;
  currency: string;
  billing: Billing;
  returnUrl: string;
  cardLastFour: string;
};
export type StripeTokenResult = { id: string; lastFour: string };
// Metadata may cross an authorization bridge; card credentials stay local to
// the trusted provider. Production nodes use the official Stripe.js provider.
export type StripeLocalCard = {
  number?: string;
  cvc?: string;
  expiry?: string;
};
export type StripeTokenProvider = (
  request: StripeTokenRequest,
  localCard?: StripeLocalCard,
) => Promise<StripeTokenResult>;
