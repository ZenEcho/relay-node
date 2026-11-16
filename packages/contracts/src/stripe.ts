import type { Billing } from './execution.js';

export type StripeTokenRequest = {
  checkoutId: string;
  accountId: string;
  environmentId: string;
  deviceId: string;
  publishableKey: string;
  customerSessionClientSecret?: string;
  amountMinor: number;
  currency: string;
  billing: Billing;
  returnUrl: string;
  cardLastFour: string;
};
export type StripeTokenResult = { id: string; lastFour: string };
// Optional custom-provider contract. Metadata may cross an authorization bridge;
// card credentials stay local to the trusted provider. The default HTTP engine
// sends card data directly to Stripe without invoking this provider.
export type StripeLocalCard = {
  number?: string;
  cvc?: string;
  expiry?: string;
};
export type StripeTokenProvider = (
  request: StripeTokenRequest,
  localCard?: StripeLocalCard,
) => Promise<StripeTokenResult>;
