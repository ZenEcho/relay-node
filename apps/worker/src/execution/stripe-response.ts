import type { HttpOutput } from '../transport/native.js';
import { UpstreamError } from './http-utils.js';

const failures = {
  STRIPE_SDK_REQUIRED: 'Stripe 要求使用官方 Stripe SDK 收集付款资料',
  STRIPE_AUTHENTICATION_FAILED: 'Stripe 无法认证当前结账的接口请求',
  STRIPE_PERMISSION_DENIED: 'Stripe 拒绝当前结账的接口权限',
} as const;
type StripeIntegrationFailure = keyof typeof failures;

class StripeIntegrationError extends UpstreamError {
  readonly retryable = false;
  readonly response: { code: StripeIntegrationFailure; type: 'invalid_request_error'; requestId?: string };

  constructor(readonly code: StripeIntegrationFailure, status: number, requestId?: string) {
    // A configuration refusal cannot establish an Intent's payment outcome.
    super(`HTTP ${status}：${failures[code]}`, status, null);
    this.response = { code, type: 'invalid_request_error', ...(requestId ? { requestId } : {}) };
  }
}

export function stripeIntegrationError(path: string, method: string, output: HttpOutput) {
  const error = output.data?.error;
  if (error?.type !== 'invalid_request_error') return;
  const ids = Object.entries(output.headers)
    .filter(([name]) => name.toLowerCase() === 'request-id')
    .flatMap(([, values]) => values);
  const requestId = ids.length === 1 && /^req_[A-Za-z0-9]{1,100}$/.test(ids[0]) ? ids[0] : undefined;

  if (
    output.status === 400 && method === 'POST' && path === '/v1/confirmation_tokens' &&
    error.message === 'This publishable key tokenization request is required to use the Stripe SDK.'
  ) return new StripeIntegrationError('STRIPE_SDK_REQUIRED', output.status, requestId);

  // A gateway or intermediary may send its own 401/403. Require Stripe's
  // structured error and a request identifier before classifying the response.
  if (!requestId) return;
  if (output.status === 401)
    return new StripeIntegrationError('STRIPE_AUTHENTICATION_FAILED', output.status, requestId);
  if (output.status === 403)
    return new StripeIntegrationError('STRIPE_PERMISSION_DENIED', output.status, requestId);
}
