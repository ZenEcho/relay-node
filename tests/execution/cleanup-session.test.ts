import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupExecution } from '../../apps/worker/src/execution/cleanup.js';
import { executeWithOnDemandSdk } from '../../apps/worker/src/browser/runtime.js';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { UpstreamError } from '../../apps/worker/src/execution/http-utils.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';

const token = (iat: number, exp = Math.floor(Date.now() / 1000) + 3600) =>
  'fixture.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.signature';
function fixture(
  options: {
    initialFails?: boolean;
    refreshFails?: boolean;
    otherAccount?: boolean;
    expired?: boolean;
    rejectToken?: boolean;
    repeatRejection?: boolean;
  } = {},
) {
  const old = token(1),
    initial = token(2),
    fresh = token(3, options.expired ? 1 : undefined);
  const context: any = {
    environment: createEnvironment('CL', ''),
    accountId: 'original',
    userId: 'user',
    session: {
      accessToken: old,
      account: { id: 'original' },
      user: { id: 'user' },
    },
    checkout: { id: 'oaics_original', processor_entity: 'openai_llc' },
    latestSession: 'stale',
  };
  context.environment.cookies.push({
    name: '__Secure-next-auth.session-token',
    value: 'login',
    domain: 'chatgpt.com',
  });
  const assignment: any = {
    context,
    mode: 'cleanup',
    demo: false,
    run: {
      id: 'run',
      paymentSubmitted: true,
      dispatches: { registration: 'already-dispatched' },
      workflow: { cleanup: { refresh: true, cancel: true, invoices: true } },
    },
  };
  const paths: string[] = [],
    commands: any[] = [];
  let refreshes = 0,
    cancels = 0,
    renew = true,
    rejected = false;
  const browser: ExecutionServices['chat'] = async (_name, path, body, headers) => {
    paths.push(path);
    if (path === '/api/auth/session') {
      if (options.initialFails) throw new Error('plain Session disconnected');
      return { accessToken: initial };
    }
    if (path.includes('refresh=true')) {
      refreshes++;
      const url = new URL(path, 'https://chatgpt.com');
      assert.equal(url.pathname, '/api/auth/session');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        refresh: 'true',
        reason: 'token_expired',
        method: 'POST',
        path: '/backend-api/subscriptions/cancel',
      });
      assert.equal(body, undefined);
      assert.equal(headers?.['x-openai-failed-access-token-iat'], options.initialFails ? '1' : '2');
      if (options.refreshFails) throw new Error('forced refresh failed');
      context.environment.cookies = [
        {
          name: '__Secure-next-auth.session-token.0',
          value: 'rotated',
          domain: 'chatgpt.com',
        },
      ];
      return {
        accessToken: fresh,
        account: { id: options.otherAccount ? 'foreign' : 'original' },
        user: { id: 'user' },
      };
    }
    assert.equal(context.session.accessToken, fresh, 'protected calls must use the refreshed token');
    if (path.includes('/accounts/check/'))
      return {
        accounts: { original: { account: { account_id: 'original' } } },
        user: { id: 'user' },
      };
    if (path === '/backend-api/payments/checkout_session') return { success: true };
    if (options.rejectToken && path.includes('/subscriptions') && (!rejected || options.repeatRejection)) {
      rejected = true;
      throw new UpstreamError('HTTP 401: token expired', 401, {});
    }
    if (path.endsWith('/subscriptions/cancel')) {
      assert.equal(body?.account_id, 'original');
      cancels++;
      renew = false;
      return { success: true };
    }
    if (path.includes('/subscriptions?')) return { will_renew: renew };
    if (path.includes('/invoices?'))
      return {
        invoices: [{ hosted_invoice_url: 'https://billing.example/invoice' }],
      };
    assert.fail('unexpected browser endpoint: ' + path);
  };
  const services: ExecutionServices = {
    assignment,
    context,
    cleanupChat: browser,
    chat: async () => {
      assert.fail('cleanup must not fall back to the native transport');
    },
    command: async (action, body) => {
      commands.push({ action, body: structuredClone(body) });
      return {};
    },
    setStage: (stage: string) => { context.phase = stage; },
    checkpoint: async () => {},
    log: async () => {},
  } as any;
  return {
    assignment,
    services,
    paths,
    commands,
    browser,
    counts: () => ({ refreshes, cancels }),
  };
}

test('browser cleanup recovers an activation-expired Session even when the plain read disconnects', async () => {
  const f = fixture({ initialFails: true });
  await cleanupExecution(f.services);
  const result = f.commands.at(-1).body;
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.refresh.status, 'succeeded');
  assert.equal(result.cleanup.cancel.status, 'succeeded');
  assert.equal(result.cleanup.invoices.status, 'succeeded');
  assert.equal(result.cleanup.registration.status, 'failed');
  assert.equal(result.context.renewalStatus, 'cancelled');
  assert.equal(JSON.parse(result.context.latestSession).cookies[0].value, 'rotated');
  assert.deepEqual(f.counts(), { refreshes: 1, cancels: 1 });
  assert.ok(!f.commands.some((c) => c.action === 'authorize'));
});

for (const failure of ['refreshFails', 'otherAccount', 'expired'] as const) {
  test(failure + ' blocks cancellation, invoices and publishing stale Session', async () => {
    const f = fixture({ [failure]: true });
    await cleanupExecution(f.services);
    assert.equal(f.services.context.cleanup!.refresh.status, 'failed');
    assert.equal(f.services.context.cleanup!.cancel.status, 'failed');
    assert.equal(f.services.context.cleanup!.invoices.status, 'failed');
    assert.equal(f.services.context.latestSession, undefined);
    assert.ok(!f.paths.some((p) => /\/subscriptions|\/invoices/.test(p.split('?')[0])));
    assert.equal(f.commands.at(-1).body.status, 'completed');
  });
}

test('an explicit cleanup 401 refreshes once before retrying and does not repeat cancellation', async () => {
  const f = fixture({ rejectToken: true });
  await cleanupExecution(f.services);
  assert.deepEqual(f.counts(), { refreshes: 2, cancels: 1 });
  assert.equal(f.services.context.cleanup!.cancel.status, 'succeeded');
});

test('a second 401 removes the rejected Session and blocks later requests', async () => {
  const f = fixture({ rejectToken: true, repeatRejection: true });
  await cleanupExecution(f.services);
  assert.deepEqual(f.counts(), { refreshes: 2, cancels: 0 });
  assert.equal(f.services.context.latestSession, undefined);
  assert.equal(f.services.context.cleanup!.refresh.status, 'failed');
  assert.ok(!f.paths.some((p) => p.includes('/invoices')));
});

test('disabling Session export still refreshes credentials required for cancellation', async () => {
  const f = fixture();
  f.assignment.run.workflow.cleanup.refresh = false;
  await cleanupExecution(f.services);
  assert.equal(f.services.context.cleanup!.refresh.status, 'skipped');
  assert.equal(f.services.context.cleanup!.cancel.status, 'succeeded');
  assert.equal(f.services.context.latestSession, undefined);
});

test('cleanup saves confirmed mutations before the next enabled step', async () => {
  const f = fixture();
  f.assignment.run.dispatches = {};
  const saved: { stage: string; cleanup: Record<string, { status: string }> }[] = [];
  f.services.checkpoint = async (stage) => {
    saved.push({ stage, cleanup: structuredClone(f.services.context.cleanup!) });
  };
  await cleanupExecution(f.services);
  assert.deepEqual(saved.map(({ stage }) => stage), ['cleanup_refresh', 'cleanup_cancel', 'cleanup_invoices']);
  assert.equal(saved[1].cleanup.registration.status, 'succeeded');
  assert.equal(saved[2].cleanup.cancel.status, 'succeeded');
  assert.equal(f.commands.at(-1).body.cleanup.invoices.status, 'succeeded');
});

test('ProtocolEngine routes paid cleanup through the injected browser without native payment requests', async () => {
  const f = fixture();
  await new ProtocolEngine(
    f.assignment,
    { request: f.services.command },
    {
      initialize: async () => {},
      close() {},
      request: async () => {
        assert.fail('no native payment request');
      },
    },
    undefined,
    undefined,
    f.browser,
  ).execute();
  assert.equal(
    f.commands.filter((c) => c.action === 'finish').at(-1).body.cleanup.cancel.status,
    'succeeded',
  );
});

for (const cleanup of [{ refresh: true, cancel: true, invoices: true }, {}]) {
  test(`a missing browser leaves paid cleanup recoverable with ${cleanup.refresh ? 'all' : 'no'} optional steps enabled`, async () => {
    const f = fixture();
    f.assignment.run.workflow.cleanup = cleanup;
    f.assignment.run.dispatches = {};
    await executeWithOnDemandSdk(
      f.assignment,
      { request: f.services.command },
      {
        initialize: async () => {},
        close() {},
        request: async () => assert.fail('no native payment or cleanup request'),
      },
      { executablePath: '/does-not-exist/Chrome' },
    );
    const result = f.commands.findLast((c) => c.action === 'finish').body;
    assert.equal(result.status, 'completed');
    for (const step of ['refresh', 'registration', 'cancel', 'invoices']) {
      if (cleanup.refresh || step === 'registration') {
        assert.equal(result.cleanup[step].status, 'failed');
        assert.match(result.cleanup[step].error, /Chrome\/Chromium.*officialSdk\.executablePath/);
      } else assert.equal(result.cleanup[step].status, 'skipped');
    }
    assert.equal(result.context.latestSession, undefined);
    assert.ok(!f.commands.some((c) => c.action === 'authorize'));
    assert.ok(!f.commands.some((c) => c.action === 'checkpoint'));
    assert.ok(!f.commands.some((c) => c.body?.step?.name === '强制刷新最新 Session'));
  });
}
