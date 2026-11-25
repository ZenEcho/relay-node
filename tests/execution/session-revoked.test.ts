import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightExecution } from '../../apps/worker/src/execution/preflight.js';
import { refreshExpiredAccessToken } from '../../apps/worker/src/execution/session-refresh.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';

const accountPath = '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480';

function preflightFixture() {
  const logs: any[] = [];
  const paths: string[] = [];
  const context: any = {
    environment: createEnvironment('PH', 'http://proxy.invalid:8080'),
    session: { accessToken: 'private-old-token', account: { id: 'acct' }, user: { id: 'user' } },
  };
  context.environment.cookies = [
    { name: '__Secure-next-auth.session-token', value: 'private-login', domain: 'chatgpt.com' },
  ];
  const services = {
    context,
    assignment: { mode: 'execute', paymentEnabled: true },
    setStage: (stage: string) => {
      context.phase = stage;
    },
    checkpoint: async () => assert.fail('must not checkpoint a revoked Session'),
    request: async () => ({
      status: 200,
      headers: {},
      data: null,
      body: 'h=chatgpt.com\nip=203.0.113.42\nloc=PH\n',
    }),
    log: async (entry: any) => {
      logs.push(entry);
    },
    requireSentinel: async () => assert.fail('must not request Sentinel'),
    chat: async (_name: string, path: string) => {
      paths.push(path);
      return {
        accessToken: 'private-stale-token',
        account: { id: 'acct' },
        user: { id: 'user' },
        expires: '2027-02-23T04:39:29.238Z',
        error: 'RefreshAccessTokenError',
      };
    },
  } as unknown as ExecutionServices;
  return { context, services, logs, paths };
}

test('a rejected forced refresh stops before subscription, checkout or payment', async () => {
  const f = preflightFixture();
  await assert.rejects(preflightExecution(f.services), (error: any) => {
    assert.equal(error.code, 'SESSION_REVOKED');
    assert.match(error.message, /Session 已失效/);
    return true;
  });
  assert.equal(f.paths.length, 1);
  assert.ok(f.paths[0].startsWith('/api/auth/session?'));
  assert.equal(f.context.phase, 'subscription_check');
  const failure = f.logs.find((entry) => entry.name === '账号 Session 无法刷新');
  assert.ok(failure, 'a rejected refresh must be recorded as its own failed event');
  assert.equal(failure.status, 'failed');
  assert.equal(failure.response.error, 'RefreshAccessTokenError');
  const serialized = JSON.stringify(f.logs);
  for (const secret of ['private-stale-token', 'private-old-token', 'private-login'])
    assert.equal(serialized.includes(secret), false, secret);
});

test('a rejected refresh during access-token recovery is terminal and never replayed', async () => {
  const environment = createEnvironment('PH', 'http://proxy.invalid:8080');
  environment.cookies = [
    { name: '__Secure-next-auth.session-token', value: 'private-login', domain: 'chatgpt.com' },
  ];
  const context: any = {
    environment,
    accountId: 'acct',
    userId: 'user',
    session: { accessToken: 'private-expired-token', account: { id: 'acct' }, user: { id: 'user' } },
  };
  const paths: string[] = [];
  const chat = async (_name: string, path: string) => {
    paths.push(path);
    if (path === '/api/auth/session') return { ...context.session };
    return { ...context.session, error: 'RefreshAccessTokenError' };
  };
  await assert.rejects(
    refreshExpiredAccessToken(context, chat as any, accountPath),
    (error: any) => {
      assert.equal(error.code, 'SESSION_REVOKED');
      assert.match(error.message, /Session 已失效/);
      return true;
    },
  );
  assert.equal(paths.length, 2);
  assert.equal(paths[0], '/api/auth/session');
  const query = new URL(paths[1], 'https://chatgpt.com').searchParams;
  assert.equal(query.get('refresh'), 'true');
  assert.equal(query.get('reason'), 'token_expired');
  assert.equal(query.get('path'), accountPath);
  assert.equal(context.session.accessToken, 'private-expired-token');
});

const jwt = (iat: number, exp: number) =>
  'fixture.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.signature';

function healthyFixture(accessToken: string) {
  const logs: any[] = [];
  const paths: string[] = [];
  const checkpoints: string[] = [];
  const context: any = {
    environment: createEnvironment('PH', 'http://proxy.invalid:8080'),
    session: {
      accessToken,
      account: { id: 'acct' },
      user: { id: 'user', email: 'fixture@example.invalid' },
    },
    accountId: 'acct',
    userId: 'user',
    originalSubscription: { has_active_subscription: false },
    billingEmailBinding: {
      provider: 'chatgpt',
      email: 'fixture@example.invalid',
      source: 'session',
    },
  };
  context.environment.cookies = [
    { name: '__Secure-next-auth.session-token', value: 'private-login', domain: 'chatgpt.com' },
  ];
  const services = {
    context,
    assignment: { mode: 'execute', paymentEnabled: true },
    setStage: (stage: string) => {
      context.phase = stage;
    },
    checkpoint: async (stage: string) => {
      checkpoints.push(stage);
    },
    request: async () => ({
      status: 200,
      headers: {},
      data: null,
      body: 'h=chatgpt.com\nip=203.0.113.42\nloc=PH\n',
    }),
    log: async (entry: any) => {
      logs.push(entry);
    },
    requireSentinel: async () => assert.fail('must not request Sentinel'),
    chat: async (_name: string, path: string) => {
      paths.push(path);
      if (path.startsWith('/backend-api/accounts/check'))
        return {
          accounts: {
            acct: { account: { account_id: 'acct' }, entitlement: { has_active_subscription: false } },
          },
          user: { id: 'user' },
        };
      return {
        accessToken,
        account: { id: 'acct' },
        user: { id: 'user', email: 'fixture@example.invalid' },
        expires: '2027-02-23T04:39:29.238Z',
        error: 'RefreshAccessTokenError',
      };
    },
  } as unknown as ExecutionServices;
  return { context, services, logs, paths, checkpoints };
}

test('a still-valid access token is used as-is instead of burning the refresh token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const f = healthyFixture(jwt(now - 3600, now + 5 * 86400));
  await preflightExecution(f.services);
  assert.deepEqual(f.paths, [], '健康令牌不应当请求 /api/auth/session, 更不应当强制刷新');
  assert.deepEqual(f.checkpoints, ['subscription_ready']);
});

test('a rejected forced refresh keeps the still-valid token instead of declaring the Session dead', async () => {
  const now = Math.floor(Date.now() / 1000);
  // 只剩 5 分钟：进入强制续期区间，但服务端拒绝换令牌。
  const f = healthyFixture(jwt(now - 3600, now + 300));
  await preflightExecution(f.services);
  assert.deepEqual(f.paths[0].startsWith('/api/auth/session?'), true);
  assert.equal(new URL(f.paths[0], 'https://chatgpt.com').searchParams.get('refresh'), 'true');
  assert.equal(f.paths.filter((path) => path.includes('refresh=true')).length, 1);
  assert.ok(!f.logs.some((entry) => entry.name === '账号 Session 无法刷新'));
  const softened = f.logs.find((entry) => entry.name === 'Session 刷新被拒 · 沿用当前 accessToken');
  assert.ok(softened, '应当记录沿用当前令牌');
  assert.equal(softened.status, 'succeeded');
  assert.equal(softened.response.error, 'RefreshAccessTokenError');
  assert.ok(softened.response.accessTokenRemainingSeconds > 0);
  assert.deepEqual(f.checkpoints, ['subscription_ready']);
});

test('a rejected forced refresh without any usable token is still terminal', async () => {
  const now = Math.floor(Date.now() / 1000);
  const f = healthyFixture(jwt(now - 3600, now - 60));
  await assert.rejects(preflightExecution(f.services), (error: any) => {
    assert.equal(error.code, 'SESSION_REVOKED');
    return true;
  });
  assert.ok(f.logs.some((entry) => entry.name === '账号 Session 无法刷新'));
  assert.deepEqual(f.checkpoints, []);
});
