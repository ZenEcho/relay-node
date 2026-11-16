export const DEFAULT_GROK_BILLING_EMAIL = 'pay@grok.com';
import type { BillingEmailProvider, BillingEmailBinding } from '../../contracts/src/execution.js';
export type { BillingEmailProvider, BillingEmailBinding } from '../../contracts/src/execution.js';
export type BillingEmailContext = {
  session?: Record<string, any>;
  email?: string;
  billing?: { email?: string } | null;
  billingEmailBinding?: BillingEmailBinding;
};

export function normalizeBillingEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '';
}
const record = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
};

export function selectBillingEmail(
  provider: BillingEmailProvider,
  request: unknown,
  defaultEmail?: unknown,
): BillingEmailBinding {
  const value = record(request);
  // Grok's authenticated session response exposes email before googleEmail.
  // ChatGPT uses the user's Session email, never the subscription-info profile.
  const session = provider === 'grok' ? record(value.session || value) : value;
  const email =
    provider === 'grok'
      ? normalizeBillingEmail(session.email) || normalizeBillingEmail(session.googleEmail)
      : normalizeBillingEmail(session.user?.email) || normalizeBillingEmail(session.email);
  if (email)
    return {
      provider,
      email,
      source: provider === 'grok' ? 'request' : 'session',
    };
  const fallback = normalizeBillingEmail(
    defaultEmail === undefined && provider === 'grok' ? DEFAULT_GROK_BILLING_EMAIL : defaultEmail,
  );
  return { provider, email: fallback, source: fallback ? 'default' : 'none' };
}

export function bindBillingEmail(
  context: BillingEmailContext,
  provider: BillingEmailProvider,
  defaultEmail?: unknown,
): BillingEmailBinding {
  // Once accepted by the controller, retries and refreshed Sessions retain the
  // same checkout identity even when a later response contains another email.
  const binding =
    context.billingEmailBinding || selectBillingEmail(provider, context.session, defaultEmail);
  context.billingEmailBinding = binding;
  context.email = binding.email;
  if (context.billing) {
    if (binding.email) context.billing.email = binding.email;
    else delete context.billing.email;
  }
  return binding;
}
