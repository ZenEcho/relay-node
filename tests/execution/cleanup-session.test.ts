import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupExecution } from '../../apps/worker/src/execution/cleanup.js';
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
    fresh = token(2, options.expired ? 1 : undefined);
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
      return { accessToken: old };
    }
    if (path.includes('refresh=true')) {
      refreshes++;
      assert.equal(headers?.['x-openai-failed-access-token-iat'], '1');
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
