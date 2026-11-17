import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCleanupInPage } from '../../apps/worker/src/browser/cleanup.js';
import { OnDemandSdkRuntime } from '../../apps/worker/src/browser/runtime.js';
import { sdkLoginCookies } from '../../apps/worker/src/browser/configuration.js';
import { runInNewContext } from 'node:vm';

const execute = (request: any, fetch: any) =>
  runInNewContext('(' + requestCleanupInPage.toString() + ')(' + JSON.stringify(request) + ')', {
    URL,
    window: {
      location: { origin: 'https://chatgpt.com' },
      AbortSignal,
      fetch,
    },
  });

test('a resumed native jar imports the rotated whole login cookie without its stale synthetic chunks', () => {
  const login = sdkLoginCookies([
    { name: '__Secure-next-auth.session-token.0', value: 'old', domain: 'chatgpt.com', expires: 0 },
    { name: '__Secure-next-auth.session-token.1', value: 'chunks', domain: 'chatgpt.com', expires: 0 },
    {
      name: '__Secure-next-auth.session-token',
      value: 'rotated',
      domain: 'chatgpt.com',
      expires: Date.now() / 1000 + 3600,
    },
  ]);
  assert.deepEqual(
    login.map((c) => c.value),
    ['rotated'],
  );
});
test('ambiguous mixed login generations cannot be imported together', () => {
  assert.throws(
    () =>
      sdkLoginCookies([
        { name: '__Secure-next-auth.session-token.0', value: 'old', domain: 'chatgpt.com' },
        { name: '__Secure-next-auth.session-token', value: 'other', domain: 'chatgpt.com' },
      ]),
    /轮换版本冲突/,
  );
});
test('page Session refresh includes browser cookies but never sends the expired bearer', async () => {
  await execute(
    {
      path: '/api/auth/session?refresh=true',
      accountId: 'original',
      accessToken: 'expired',
    },
    async (url: string, init: any) => {
      assert.equal(new URL(url).origin, 'https://chatgpt.com');
      assert.equal(init.credentials, 'include');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, undefined);
      assert.ok(init.signal);
      return { status: 200, json: async () => ({ accessToken: 'fresh' }) };
    },
  );
});
for (const request of [
  { path: 'https://other.example/api/auth/session' },
  { path: '/backend-api/payments/checkout/confirm', body: {} },
  { path: '/backend-api/invoices?account_id=foreign' },
  {
    path: '/backend-api/subscriptions/cancel',
    body: { account_id: 'foreign' },
  },
  { path: '/api/auth/session', body: {} },
])
  test('browser rejects off-scope request ' + request.path, async () => {
    await assert.rejects(
      execute({ accountId: 'original', accessToken: 'fresh', ...request }, () => assert.fail('no network')),
    );
  });

test('browser cookie export replaces old login chunks after rotation', async () => {
  const context: any = {
    accountId: 'original',
    session: { accessToken: 'fresh' },
    environment: {
      cookies: [
        {
          name: '__Secure-next-auth.session-token.0',
          domain: 'chatgpt.com',
          value: 'old0',
        },
        {
          name: '__Secure-next-auth.session-token.1',
          domain: 'chatgpt.com',
          value: 'old1',
        },
        { name: 'other', domain: 'auth.openai.com', value: 'keep' },
      ],
    },
  };
  const runtime: any = new OnDemandSdkRuntime({ context } as any);
  runtime.open = async () => {};
  runtime.cdp = {
    evaluate: async () => ({ status: 200, data: { accessToken: 'fresh' } }),
    send: async () => ({
      cookies: [
        {
          name: '__Secure-next-auth.session-token',
          domain: '.chatgpt.com',
          value: 'new',
          httpOnly: true,
          secure: true,
        },
        { name: 'foreign', domain: 'other.example', value: 'exclude' },
      ],
    }),
  };
  await runtime.cleanupChat('refresh', '/api/auth/session');
  assert.deepEqual(
    context.environment.cookies.map((c: any) => c.name),
    ['other', '__Secure-next-auth.session-token'],
  );
  assert.equal(context.environment.cookies[1].httpOnly, true);
});
