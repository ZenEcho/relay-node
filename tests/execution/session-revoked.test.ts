import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightExecution } from '../../apps/worker/src/execution/preflight.js';
import { refreshExpiredAccessToken } from '../../apps/worker/src/execution/session-refresh.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';

const accountPath = '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480';
const now = () => Math.floor(Date.now() / 1000);
const jwt = (iat: number, exp: number) =>
  'fixture.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.signature';

// 建单前总是强制刷新一次：成功用刷新回来的会话，失败沿用提交的会话，都不在这里判死。
function fixture(refresh: 'ok' | 'rejected' | 'http' | 'foreign' | 'expired' = 'rejected') {
  const submittedToken = jwt(now() - 3600, now() + 5 * 86400);
  const account = { id: 'acct' };
  const user = { id: 'user', email: 'fixture@example.invalid' };
  const context: any = {
    environment: createEnvironment('PH', 'http://proxy.invalid:8080'),
    session: { accessToken: submittedToken, account, user },
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
  const logs: any[] = [];
  const paths: string[] = [];
  const checkpoints: string[] = [];
  const refreshedToken = jwt(now() - 10, now() + 6 * 86400);
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
          accounts: { acct: { account, entitlement: { has_active_subscription: false } } },
          user,
        };
      if (path === '/api/auth/session') return { accessToken: submittedToken, account, user };
      if (refresh === 'http') throw Object.assign(new Error('HTTP 403: Session request refused'), { status: 403 });
      if (refresh === 'ok') return { accessToken: refreshedToken, sessionToken: 'rotated', account, user, expires: '2099-01-01T00:00:00Z' };
      if (refresh === 'foreign') return { accessToken: refreshedToken, account: { id: 'other' }, user, expires: '2099-01-01T00:00:00Z' };
      if (refresh === 'expired') return { accessToken: jwt(1, 1), account, user, expires: '2099-01-01T00:00:00Z' };
      return { accessToken: submittedToken, account, user, error: 'RefreshAccessTokenError', expires: '2099-01-01T00:00:00Z' };
    },
  } as unknown as ExecutionServices;
  return { context, services, logs, paths, checkpoints, submittedToken, refreshedToken };
}

test('a successful forced refresh replaces the submitted Session', async () => {
  const f = fixture('ok');
  await preflightExecution(f.services);
  assert.equal(f.paths.filter((path) => path.includes('refresh=true')).length, 1);
  assert.equal(f.context.session.accessToken, f.refreshedToken);
  assert.equal(f.context.session.sessionToken, 'rotated');
  assert.ok(!f.logs.some((entry) => entry.name.includes('沿用提交的 Session')));
  assert.deepEqual(f.checkpoints, ['subscription_ready']);
});

test('a rejected forced refresh falls back to the submitted Session instead of failing the order', async () => {
  const f = fixture('rejected');
  await preflightExecution(f.services);
  assert.equal(f.paths.filter((path) => path.includes('refresh=true')).length, 1);
  assert.equal(f.context.session.accessToken, f.submittedToken);
  assert.equal(f.context.environment.cookies[0].value, 'private-login');
  const fallback = f.logs.find((entry) => entry.name === 'Session 刷新未成功 · 沿用提交的 Session');
  assert.ok(fallback, '刷新失败应当记一条沿用提交会话的事件');
  assert.match(fallback.response.reason, /RefreshAccessTokenError/);
  assert.deepEqual(f.checkpoints, ['subscription_ready']);
});

for (const [name, refresh, expected] of [
  ['an HTTP refusal', 'http', /403|refused/i],
  ['a foreign account', 'foreign', /原订单不一致|原账号|不一致/],
  ['an expired token', 'expired', /已过期/],
] as const) {
  test(`${name} during the forced refresh falls back to the submitted Session`, async () => {
    const f = fixture(refresh);
    await preflightExecution(f.services);
    assert.equal(f.context.session.accessToken, f.submittedToken);
    assert.equal(f.context.environment.cookies[0].value, 'private-login');
    const fallback = f.logs.find((entry) => entry.name === 'Session 刷新未成功 · 沿用提交的 Session');
    assert.ok(fallback);
    assert.match(fallback.response.reason, expected);
    assert.deepEqual(f.checkpoints, ['subscription_ready']);
  });
}

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
