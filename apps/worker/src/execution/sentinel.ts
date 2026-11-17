import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
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
  return (
    typeof value === 'string' && !!value.trim() && value.length <= 100000 && !/[\r\n\0]/.test(value)
  );
}

// Grants are process-local: a checkpoint can never restore a usable grant.
const grants = new WeakMap<
  RuntimeContext,
  {
    id: string;
    flow: SentinelFlow;
    token: string;
    soToken?: string;
    expires: number;
    environment: RuntimeContext['environment'];
    binding: string;
  }
>();
function environmentBinding(context: RuntimeContext): string {
  // Compare credentials and the complete frozen environment without logging
  // either their values or this private digest.
  return createHash('sha256')
    .update(
      JSON.stringify(
        {
          environment: context.environment,
          accountId: context.accountId,
          userId: context.userId,
          accessToken: context.session?.accessToken,
        },
        (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
      ),
    )
    .digest('hex');
}
function clearGrant(context: RuntimeContext) {
  grants.delete(context);
  delete context.sentinel;
  delete context.sentinelSo;
  delete context.sentinelFlow;
  delete context.sentinelExpiresAt;
}
export type SentinelGrant = {
  id: string;
  flow: SentinelFlow;
  headers: Record<string, string>;
  assertValid: () => void;
};
export function consumeSentinel(context: RuntimeContext, flow: SentinelFlow): SentinelGrant {
  const grant = grants.get(context);
  const unchanged =
    grant && context.sentinel === grant.token && context.sentinelSo === grant.soToken;
  // Consume before any asynchronous dispatch, including rejected/unknown writes.
  clearGrant(context);
  if (!grant || !unchanged || grant.flow !== flow) invalid('缺少本阶段新取得的授权');
  const assertValid = () => {
    if (context.environment !== grant.environment || environmentBinding(context) !== grant.binding)
      invalid('签发后本单凭证或环境发生变化');
    if (grant.expires <= Date.now()) invalid('令牌已超过本地新鲜度期限');
  };
  assertValid();
  return {
    id: grant.id,
    flow,
    headers: {
      'openai-sentinel-token': grant.token,
      ...(grant.soToken ? { 'openai-sentinel-so-token': grant.soToken } : {}),
    },
    assertValid,
  };
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
  clearGrant(context);
  if (!authorize)
    throw Object.assign(
      new Error('缺少本单真实 Sentinel 授权，请接入已授权会话的签发适配器后重试'),
      {
        code: 'SENTINEL_AUTH_REQUIRED',
      },
    );
  const request: SentinelRequest = Object.freeze({
    flow,
    observerFlow: 'chatgpt_checkout',
    pageUrl,
    deviceId: context.environment.deviceId,
    environmentId: context.environment.id,
    accountId: context.accountId,
  });
  const environment = context.environment;
  const binding = environmentBinding(context);
  const assertBound = () => {
    if (context.environment !== environment || environmentBinding(context) !== binding)
      invalid('签发期间本单凭证或环境发生变化');
  };
  let authorization,
    retryReason: string | undefined,
    attempts = 0;
  for (;;) {
    attempts++;
    try {
      assertBound();
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
  assertBound();
  if (
    !authorization ||
    ['flow', 'observerFlow', 'pageUrl', 'deviceId', 'environmentId', 'accountId'].some(
      (key) =>
        authorization[key as keyof SentinelRequest] !== request[key as keyof SentinelRequest],
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
  if (authorization.soRequired && !validHeader(authorization.soToken))
    invalid('缺少必需的 SO 令牌');
  if (
    authorization.soToken != null &&
    authorization.soToken !== '' &&
    !validHeader(authorization.soToken)
  )
    invalid('SO 令牌请求头格式无效');
  context.sentinel = authorization.token;
  context.sentinelSo = validHeader(authorization.soToken) ? authorization.soToken : undefined;
  context.sentinelFlow = flow;
  context.sentinelExpiresAt = authorization.expiresAt;
  const grantId = randomUUID();
  grants.set(context, {
    id: grantId,
    flow,
    token: context.sentinel,
    soToken: context.sentinelSo,
    expires,
    environment,
    binding,
  });
  return {
    attempts,
    ...(retryReason ? { retryReason } : {}),
    grantId,
    runtime:
      authorization.runtime === 'reference' || authorization.runtime === 'official'
        ? authorization.runtime
        : 'adapter',
    ...(typeof authorization.sdkVersion === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(authorization.sdkVersion)
      ? { sdkVersion: authorization.sdkVersion }
      : {}),
    environmentBound: true,
    localFreshnessMs: expires - issued,
  };
}
