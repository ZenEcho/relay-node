import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  executionOperation,
  throwIfExecutionAborted,
} from '../../../../packages/runtime/src/cancellation.js';

import type {
  SentinelFlow,
  SentinelRequest,
  SentinelAuthorizer,
} from '../../../../packages/contracts/src/sentinel.js';
// Adapters bind their result to this order's account, device and environment.
// Browser credentials remain opaque here; a configured reference adapter also
// checks its bridge's structured output before returning it to this boundary.

function invalid(message: string): never {
  throw Object.assign(new Error('Sentinel 授权无效：' + message), {
    code: 'SENTINEL_AUTH_INVALID',
  });
}
function validHeader(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 100000 && !/[\r\n]/.test(value);
}
export async function authorizeSentinel(
  context: RuntimeContext,
  flow: SentinelFlow,
  pageUrl: string,
  authorize?: SentinelAuthorizer,
  signal?: AbortSignal,
) {
  throwIfExecutionAborted(signal);
  // A saved checkpoint is not a fresh authorization for another phase.
  delete context.sentinel;
  delete context.sentinelSo;
  delete context.sentinelFlow;
  delete context.sentinelExpiresAt;
  if (!authorize)
    throw Object.assign(new Error('缺少本单真实 Sentinel 授权，请接入已授权会话的签发适配器后重试'), {
      code: 'SENTINEL_AUTH_REQUIRED',
    });
  const request: SentinelRequest = Object.freeze({
    flow,
    observerFlow: 'chatgpt_checkout',
    pageUrl,
    deviceId: context.environment.deviceId,
    environmentId: context.environment.id,
    accountId: context.accountId,
  });
  let authorization,
    retryReason: string | undefined,
    attempts = 0;
  for (;;) {
    attempts++;
    try {
      authorization = await executionOperation(signal, () => authorize(request));
      break;
    } catch (error) {
      throwIfExecutionAborted(signal);
      const diagnostic = (error as any)?.runtimeDiagnostic;
      const transient =
        (error as any)?.code === 'SENTINEL_AUTH_REQUIRED' &&
        diagnostic?.component === 'reference_bridge' &&
        diagnostic.retryable === true &&
        ['UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(diagnostic.reason);
      if (!transient || attempts >= 2) throw error;
      retryReason = diagnostic.reason;
      await executionOperation(signal, () => delay(250));
    }
  }
  throwIfExecutionAborted(signal);
  if (
    !authorization ||
    ['flow', 'observerFlow', 'pageUrl', 'deviceId', 'environmentId', 'accountId'].some(
      (key) => authorization[key as keyof SentinelRequest] !== request[key as keyof SentinelRequest],
    )
  )
    invalid('授权运行时与本单账号、设备、页面或流程不一致');
  const issued = Date.parse(authorization?.issuedAt),
    expires = Date.parse(authorization?.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > Date.now() ||
    expires <= Date.now() ||
    expires <= issued
  )
    invalid('令牌已过期或签发时间无法确认');
  // SDK credentials are opaque. The main and observer SDK calls can use
  // different flows and independent challenges; do not compare their internals.
  if (!validHeader(authorization.token)) invalid('主令牌请求头格式无效');
  if (authorization.soRequired && !validHeader(authorization.soToken)) invalid('缺少必需的 SO 令牌');
  if (authorization.soToken != null && authorization.soToken !== '' && !validHeader(authorization.soToken))
    invalid('SO 令牌请求头格式无效');
  context.sentinel = authorization.token;
  context.sentinelSo = validHeader(authorization.soToken) ? authorization.soToken : undefined;
  context.sentinelFlow = flow;
  context.sentinelExpiresAt = authorization.expiresAt;
  return { attempts, ...(retryReason ? { retryReason } : {}) };
}
