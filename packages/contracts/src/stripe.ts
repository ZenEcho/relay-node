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
// Metadata can cross an authorization bridge. The optional card stays in the
// trusted node process and is entered only into Stripe's official iframe.
export type StripeLocalCard = {
  number?: string;
  cvc?: string;
  expiry?: string;
};
export type StripeTokenProvider = (
  request: StripeTokenRequest,
  localCard?: StripeLocalCard,
) => Promise<StripeTokenResult>;
