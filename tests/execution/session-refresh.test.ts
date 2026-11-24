import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { UpstreamError } from '../../apps/worker/src/execution/http-utils.js';
import {
  isExpiredAccessToken,
  refreshExpiredAccessToken,
} from '../../apps/worker/src/execution/session-refresh.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { Assignment, Control, RuntimeContext } from '../../packages/contracts/src/execution.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';
import type { HttpInput, Transport } from '../../apps/worker/src/transport/native.js';

const accountPath = '/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480';
const token = (iat: number, exp = Math.floor(Date.now() / 1000) + 3600) =>
  'fixture.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.signature';
const expired = token(1, 1);
const fresh = token(2);
const accountInfo = () => ({
  accounts: {
    original: { account: { account_id: 'original' }, entitlement: {} },
  },
  user: { id: 'user' },
});

function fixture() {
  const environment = createEnvironment('PH', 'http://proxy.invalid:8080');
  environment.cookies = [
    {
      name: '__Secure-next-auth.session-token',
      value: 'login',
      domain: 'chatgpt.com',
    },
  ];
  const session = {
    accessToken: expired,
    account: { id: 'original' },
    user: { id: 'user', email: 'fixture@example.invalid' },
  };
  const context: RuntimeContext = {
    environment,
    accountId: 'original',
    userId: 'user',
    session,
  };
  const paths: string[] = [];
  const responses = {
    initial: session as any,
    refreshed: { ...session, accessToken: fresh } as any,
    info: accountInfo() as any,
  };
  const chat: ExecutionServices['chat'] = async (_name, path, body, headers) => {
    assert.equal(body, undefined);
    paths.push(path);
    if (path === '/api/auth/session') return responses.initial;
    if (path.startsWith('/api/auth/session?')) {
      const query = new URL(path, 'https://chatgpt.com').searchParams;
      assert.equal(query.get('refresh'), 'true');
      assert.equal(query.get('reason'), 'token_expired');
      assert.equal(query.get('method'), 'GET');
      assert.equal(query.get('path'), accountPath);
      assert.equal(headers?.['x-openai-failed-access-token-iat'], '1');
      context.environment.cookies = [
        {
          name: '__Secure-next-auth.session-token',
          value: 'rotated',
          domain: 'chatgpt.com',
        },
      ];
      return responses.refreshed;
    }
    assert.equal(path, accountPath);
    assert.equal(context.session?.accessToken, fresh);
    return responses.info;
  };
  return { context, session, paths, responses, chat };
}

test('only an explicit expired access token on a 401 triggers account recovery', () => {
  for (const error of [
    new UpstreamError('HTTP 401: rejected', 401, {
      error: { code: 'token_expired' },
    }),
    new UpstreamError('HTTP 401: token_expired', 401, {}),
    new UpstreamError('Your authentication token has expired. Please try refreshing it.', 401, {}),
  ])
    assert.equal(isExpiredAccessToken(error), true);
  for (const error of [
    new UpstreamError('HTTP 401: Unauthorized', 401, {}),
    new UpstreamError('HTTP 401: session_expired', 401, {}),
    new UpstreamError('HTTP 401: token_revoked', 401, {}),
    new UpstreamError('HTTP 403: challenge', 403, {
      error: { code: 'token_expired' },
    }),
    new Error('network timeout'),
    new Error('Checkout session has expired'),
  ])
    assert.equal(isExpiredAccessToken(error), false);
});

test('a refreshed Session is accepted only after the original account and user are confirmed', async () => {
  const f = fixture();
  await refreshExpiredAccessToken(f.context, f.chat, accountPath);
  assert.equal(f.context.session?.accessToken, fresh);
  assert.equal(f.context.accountId, 'original');
  assert.equal(f.context.userId, 'user');
  assert.equal(f.context.environment.cookies[0].value, 'rotated');
  assert.equal(f.paths.length, 3);
});

test('a failed ordinary Session read still permits the forced refresh with the failed token iat', async () => {
  const f = fixture();
  await refreshExpiredAccessToken(
    f.context,
    async (...args) => {
      if (args[1] === '/api/auth/session') throw new Error('plain Session disconnected');
      return f.chat(...args);
    },
    accountPath,
  );
  assert.equal(f.context.session?.accessToken, fresh);
});

test('access_token aliases and account-check identity can validate a minimal refresh response', async () => {
  const f = fixture();
  f.responses.refreshed = { access_token: fresh };
  await refreshExpiredAccessToken(f.context, f.chat, accountPath);
  assert.equal(f.context.session?.accessToken, fresh);
});

for (const [name, change] of [
  [
    'foreign refreshed account id',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.account = { id: 'foreign' };
    },
  ],
  [
    'foreign refreshed account_id',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.account = { account_id: 'foreign' };
    },
  ],
  [
    'conflicting refreshed account aliases',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.account = { id: 'original', account_id: 'foreign' };
    },
  ],
  [
    'foreign refreshed user',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.user = { id: 'foreign-user' };
    },
  ],
  [
    'missing access token',
    (f: ReturnType<typeof fixture>) => {
      delete f.responses.refreshed.accessToken;
    },
  ],
  [
    'non-string access token',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.accessToken = { token: fresh };
    },
  ],
  [
    'unchanged access token',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.accessToken = expired;
    },
  ],
  [
    'another expired access token',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.accessToken = token(2, 1);
    },
  ],
  [
    'expired response lifetime',
    (f: ReturnType<typeof fixture>) => {
      f.responses.refreshed.expires = '2000-01-01T00:00:00Z';
    },
  ],
  [
    'account check omits the original account',
    (f: ReturnType<typeof fixture>) => {
      f.responses.info.accounts = {};
    },
  ],
  [
    'account check returns a foreign user',
    (f: ReturnType<typeof fixture>) => {
      f.responses.info.user.id = 'foreign-user';
    },
  ],
  [
    'neither response confirms the original user',
    (f: ReturnType<typeof fixture>) => {
      delete f.responses.refreshed.user;
      delete f.responses.info.user;
    },
  ],
] as const) {
  test(name + ' rolls back credentials and prevents accepting the refresh', async () => {
    const f = fixture();
    const cookies = structuredClone(f.context.environment.cookies);
    change(f);
    await assert.rejects(refreshExpiredAccessToken(f.context, f.chat, accountPath));
    assert.equal(f.context.session, f.session);
    assert.equal(f.context.accountId, 'original');
    assert.equal(f.context.userId, 'user');
    assert.deepEqual(f.context.environment.cookies, cookies);
  });
}

test('an incomplete original identity or missing login cookie cannot start a refresh', async () => {
  for (const missing of ['account', 'cookies']) {
    const f = fixture();
    if (missing === 'account') {
      delete f.context.accountId;
      delete (f.session as any).account;
    } else f.context.environment.cookies = [];
    await assert.rejects(refreshExpiredAccessToken(f.context, f.chat, accountPath), /accessToken 已过期/);
    assert.deepEqual(f.paths, []);
  }
});

test('cancellation after refreshing cannot commit credentials or query the account', async () => {
  const f = fixture();
  const abort = new AbortController();
  await assert.rejects(
    refreshExpiredAccessToken(
      f.context,
      async (...args) => {
        const result = await f.chat(...args);
        if (args[1].includes('refresh=true')) abort.abort();
        return result;
      },
      accountPath,
      abort.signal,
    ),
    (error: any) => error.code === 'EXECUTION_ABORTED',
  );
  assert.equal(f.context.session, f.session);
  assert.equal(f.context.environment.cookies[0].value, 'login');
  assert.ok(!f.paths.includes(accountPath));
});

async function execute(
  options: {
    browser?: boolean;
    repeated401?: boolean;
    generic401?: boolean;
    foreign?: boolean;
  } = {},
) {
  const f = fixture();
  f.context.proxyVerified = true;
  const assignment: Assignment = {
    context: f.context,
    mode: 'execute',
    demo: false,
    paymentEnabled: false,
    run: {
      id: 'original-run',
      workerLease: 'original-lease',
      paymentSubmitted: false,
      dispatches: {},
      order: {},
      workflow: {
        plan: 'gpt_plus',
        cleanup: { refresh: false, cancel: false, invoices: false },
      },
    },
  };
  const native: HttpInput[] = [],
    commands: { action: string; body: any }[] = [];
  const initializedCookies: string[][] = [];
  const transport: Transport = {
    initialize: async (environment) => {
      initializedCookies.push(environment.cookies.map((cookie) => cookie.value));
    },
    close() {},
    request: async (input) => {
      if (new URL(input.url).hostname === 'ipapi.co')
        return { status: 200, headers: {}, body: '', data: { ip: '192.0.2.4', country_code: 'PH' } };
      native.push(structuredClone(input));
      const path = new URL(input.url).pathname + new URL(input.url).search;
      let data: any;
      if (path.startsWith('/api/auth/session')) {
        assert.equal(
          input.headers?.authorization,
          undefined,
          'Session refresh must not send the expired bearer',
        );
        data = await f.chat('session', path, undefined, input.headers);
      } else {
        assert.equal(path, accountPath);
        if (input.headers?.authorization === 'Bearer ' + expired || options.repeated401) {
          data = {
            error: {
              message: options.generic401
                ? 'Unauthorized'
                : 'Your authentication token has expired. Please try refreshing it.',
              code: options.generic401 ? 'unauthorized' : 'token_expired',
            },
          };
          return { status: 401, headers: {}, body: JSON.stringify(data), data };
        }
        assert.equal(input.headers?.authorization, 'Bearer ' + fresh);
        data = accountInfo();
      }
      return { status: 200, headers: {}, body: JSON.stringify(data), data };
    },
  };
  if (options.foreign) f.responses.refreshed.account = { id: 'foreign' };
  const control: Control = {
    request: async (action, body) => {
      commands.push({ action, body: structuredClone(body) });
      return {};
    },
  };
  await new ProtocolEngine(
    assignment,
    control,
    transport,
    async () => {
      throw new Error('disabled payments must not request Sentinel');
    },
    undefined,
    options.browser ? f.chat : undefined,
  ).execute();
  return {
    ...f,
    native,
    commands,
    initializedCookies,
    finish: commands.find((entry) => entry.action === 'finish')?.body,
  };
}

for (const browser of [true, false]) {
  test(`ProtocolEngine refreshes through ${browser ? 'the browser' : 'native Session cookies'}, verifies identity and retries with the fresh bearer`, async () => {
    const f = await execute({ browser });
    assert.match(f.finish.error, /真实付款未启用/);
    assert.equal(f.context.session?.accessToken, fresh);
    assert.equal(f.paths.filter((path) => path.includes('refresh=true')).length, 1);
    assert.equal(f.native.filter((input) => input.url.includes('/accounts/check/')).length, browser ? 2 : 3);
    assert.deepEqual(f.initializedCookies, [['login'], ['rotated']]);
    assert.ok(!f.native.some((input) => input.method !== 'GET'));
    assert.ok(!f.commands.some((entry) => ['card', 'authorize'].includes(entry.action)));
  });
}

test('a second expired-token rejection stops without another refresh or payment action', async () => {
  const f = await execute({ browser: true, repeated401: true });
  assert.match(f.finish.error, /authentication token has expired/);
  assert.equal(f.paths.filter((path) => path.includes('refresh=true')).length, 1);
  assert.equal(f.native.length, 2);
  assert.ok(!f.commands.some((entry) => ['card', 'authorize'].includes(entry.action)));
});

test('generic 401s and a foreign refreshed account never retry the original request', async () => {
  const generic = await execute({ browser: true, generic401: true });
  assert.deepEqual(generic.paths, []);
  assert.equal(generic.native.length, 1);
  const foreign = await execute({ browser: true, foreign: true });
  assert.match(foreign.finish.error, /原订单不一致/);
  assert.equal(foreign.native.length, 1);
  assert.equal(foreign.context.session?.accessToken, expired);
});
