import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeSentinel,
  type SentinelAuthorization,
  type SentinelAuthorizer,
} from '../../apps/worker/src/execution/sentinel.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { RuntimeContext } from '../../packages/contracts/src/execution.js';

function fixture() {
  const context: RuntimeContext = {
    environment: createEnvironment('PH', ''),
    accountId: 'test-account',
  };
  const common = {
    c: 'test-issued-authorization',
    id: context.environment.deviceId,
    flow: 'chatgpt_checkout',
  };
  const credentials: SentinelAuthorization = {
    flow: 'chatgpt_checkout',
    observerFlow: 'chatgpt_checkout',
    pageUrl: 'https://chatgpt.com/',
    deviceId: context.environment.deviceId,
    environmentId: context.environment.id,
    accountId: 'test-account',
    token: JSON.stringify({
      p: 'test-proof',
      t: 'test-authentication',
      ...common,
    }),
    soToken: JSON.stringify({ so: 'test-observer', ...common }),
    soRequired: true,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  return { context, credentials };
}

test('Sentinel adapter receives the original identity and its bound credentials are forwarded unchanged', async () => {
  const { context, credentials } = fixture();
  const authorizer: SentinelAuthorizer = async (request) => {
    assert.deepEqual(request, {
      flow: 'chatgpt_checkout',
      observerFlow: 'chatgpt_checkout',
      pageUrl: 'https://chatgpt.com/',
      deviceId: context.environment.deviceId,
      environmentId: context.environment.id,
      accountId: 'test-account',
    });
    return credentials;
  };
  await authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', authorizer);
  assert.equal(context.sentinel, credentials.token);
  assert.equal(context.sentinelSo, credentials.soToken);
});

test('a classified bridge outage retries once in the same bound stage and reports recovery', async () => {
  const { context, credentials } = fixture();
  let attempts = 0;
  const requests: unknown[] = [];
  const result = await authorizeSentinel(
    context,
    'chatgpt_checkout',
    'https://chatgpt.com/',
    async (request) => {
      requests.push(request);
      if (++attempts === 1)
        throw Object.assign(new Error('temporary'), {
          code: 'SENTINEL_AUTH_REQUIRED',
          runtimeDiagnostic: {
            component: 'reference_bridge',
            reason: 'UPSTREAM_TIMEOUT',
            retryable: true,
          },
        });
      return credentials;
    },
  );
  assert.deepEqual(result, { attempts: 2, retryReason: 'UPSTREAM_TIMEOUT' });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(context.sentinel, credentials.token);
});

test('repeated bridge outages are bounded and unknown or identity failures never retry', async () => {
  for (const reason of ['UPSTREAM_UNAVAILABLE', 'MAIN_IDENTITY_MISMATCH', 'BRIDGE_RUNTIME_ERROR']) {
    const { context } = fixture();
    let attempts = 0;
    await assert.rejects(
      authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', async () => {
        attempts++;
        throw Object.assign(new Error(reason), {
          code: 'SENTINEL_AUTH_REQUIRED',
          runtimeDiagnostic: {
            component: 'reference_bridge',
            reason,
            retryable: true,
          },
        });
      }),
      new RegExp(reason),
    );
    assert.equal(attempts, reason === 'UPSTREAM_UNAVAILABLE' ? 2 : 1);
    assert.equal(context.sentinel, undefined);
  }
});

test('cancelling during retry backoff prevents another authorization attempt', async () => {
  const { context } = fixture();
  const cancellation = new AbortController();
  let attempts = 0;
  await assert.rejects(
    authorizeSentinel(
      context,
      'chatgpt_checkout',
      'https://chatgpt.com/',
      async () => {
        attempts++;
        setTimeout(() => cancellation.abort(), 10);
        throw Object.assign(new Error('temporary'), {
          code: 'SENTINEL_AUTH_REQUIRED',
          runtimeDiagnostic: {
            component: 'reference_bridge',
            reason: 'UPSTREAM_TIMEOUT',
            retryable: true,
          },
        });
      },
      cancellation.signal,
    ),
    { code: 'EXECUTION_ABORTED' },
  );
  assert.equal(attempts, 1);
});

const cases: [string, (credentials: SentinelAuthorization) => void][] = [
  [
    'empty main token',
    (c) => {
      c.token = '';
    },
  ],
  [
    'multiline main header',
    (c) => {
      c.token = 'invalid\r\nheader';
    },
  ],
  [
    'wrong device',
    (c) => {
      c.deviceId = 'other-device';
    },
  ],
  [
    'wrong flow',
    (c) => {
      c.flow = 'checkout_session_approval';
    },
  ],
  [
    'wrong account',
    (c) => {
      c.accountId = 'other-account';
    },
  ],
  [
    'blank main header',
    (c) => {
      c.token = '  ';
    },
  ],
  [
    'oversized main header',
    (c) => {
      c.token = 'x'.repeat(100001);
    },
  ],
  [
    'expired token',
    (c) => {
      c.expiresAt = new Date(0).toISOString();
    },
  ],
  [
    'invalid expiration',
    (c) => {
      c.expiresAt = 'invalid';
    },
  ],
  [
    'future issuance',
    (c) => {
      c.issuedAt = new Date(Date.now() + 120000).toISOString();
    },
  ],
  [
    'missing required SO',
    (c) => {
      delete c.soToken;
    },
  ],
  [
    'multiline SO header',
    (c) => {
      c.soToken = 'invalid\nheader';
    },
  ],
  [
    'wrong observer flow binding',
    (c) => {
      (c as any).observerFlow = 'other-flow';
    },
  ],
];
for (const [name, change] of cases) {
  test(`Sentinel rejects ${name} and clears any stale credentials`, async () => {
    const { context, credentials } = fixture();
    context.sentinel = 'old-token';
    context.sentinelSo = 'old-observer';
    change(credentials);
    await assert.rejects(
      authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', async () => credentials),
      (error: any) => error.code === 'SENTINEL_AUTH_INVALID',
    );
    assert.equal(context.sentinel, undefined);
    assert.equal(context.sentinelSo, undefined);
  });
}

test('official main and observer headers are opaque and may have independent flows and challenges', async () => {
  const { context, credentials } = fixture();
  credentials.flow = 'checkout_session_approval';
  credentials.token = JSON.stringify({
    c: 'main-challenge',
    flow: 'checkout_session_approval',
  });
  credentials.soToken = JSON.stringify({
    c: 'observer-challenge',
    flow: 'chatgpt_checkout',
    so: 'opaque-observer',
  });
  await authorizeSentinel(
    context,
    'checkout_session_approval',
    'https://chatgpt.com/',
    async () => credentials,
  );
  assert.equal(context.sentinel, credentials.token);
  assert.equal(context.sentinelSo, credentials.soToken);
});

test('SDK headers need not expose JSON internals to the controller', async () => {
  const { context, credentials } = fixture();
  credentials.token = 'opaque-sdk-main';
  credentials.soToken = 'opaque-sdk-observer';
  await authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', async () => credentials);
  assert.equal(context.sentinel, 'opaque-sdk-main');
});
