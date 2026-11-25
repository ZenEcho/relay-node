import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeTransport,
  NativeTransportError,
  type HttpInput,
  type TransportAttempt,
} from '../../apps/worker/src/transport/native.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import { auditError } from '../../packages/runtime/src/audit.js';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';

async function fixture(
  t: any,
  scenario = 'recover',
  options: ConstructorParameters<typeof NativeTransport>[1] = {},
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-native-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'transport');
  const records = join(directory, 'requests.jsonl');
  await writeFile(
    binary,
    `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const scenario=${JSON.stringify(scenario)}, records=${JSON.stringify(records)};
let requests=0;
const diagnostic={phase:'tls_handshake',reason:'connection_closed',requestWritten:false,responseStarted:false,dialCompleted:true,elapsedMs:12,rawError:'private-error',proxyUrl:'http://private-user:private-password@gateway.invalid',accessToken:'private-token'};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);fs.appendFileSync(records,JSON.stringify(message)+'\\n');
 const send=value=>process.stdout.write(JSON.stringify({id:message.id,...value})+'\\n');
 if(scenario==='invalid-init'&&message.method==='initialize'){process.stdout.write(JSON.stringify({error:'invalid transport message'})+'\\n');return;}
 if(message.method==='initialize'||message.method==='reset_connections'){send({ready:true});return;}
 requests++;
 if(scenario==='budget'){setTimeout(()=>send({status:200,headers:{},body:'{}'}),1000);return;}
 if(scenario==='native-budget'){
   if(requests===1){send({error:'response read failed',code:'TRANSPORT_BUDGET_EXHAUSTED',status:202,headers:{'request-id':['req_fixture']},body:'partial',partial:true,diagnostic:{phase:'response_body',reason:'timeout',requestWritten:true,responseStarted:true}});return;}
   send({status:200,headers:{},body:'{}'});return;
 }
 if(scenario==='http403'||scenario==='http429'){send({status:scenario==='http403'?403:429,headers:{'cf-mitigated':['challenge']},body:'{}',diagnostic:{phase:'complete',elapsedMs:1}});return;}
 if(scenario==='recover'&&requests>1){send({status:200,headers:{},body:'{"ok":true}',cookies:[{name:'device',value:'updated',domain:'chatgpt.com'}],diagnostic:{phase:'complete',elapsedMs:2,rawError:'private-success-error'}});return;}
 let code='UPSTREAM_CONNECTION_CLOSED',d={...diagnostic};
 if(scenario==='certificate')d.reason='certificate';
 if(scenario==='unknown')d.phase='unknown';
 if(scenario==='written'){d.phase='response_headers';d.requestWritten=true;}
 if(scenario==='authentication'){code='PROXY_AUTH_REQUIRED';d={...d,phase:'proxy_connect',reason:'proxy_auth',proxyConnectStatus:407};}
 if(scenario==='proxy429'){code='PROXY_CONNECT_FAILED';d={...d,phase:'proxy_connect',reason:'proxy_status',proxyConnectStatus:429};}
 if(scenario==='proxy503'){code='PROXY_CONNECT_FAILED';d={...d,phase:'proxy_connect',reason:'proxy_status',proxyConnectStatus:503};}
 if(scenario==='conflicting403'){code='PROXY_FORBIDDEN';d.reason='timeout';}
 if(scenario==='conflicting407'){code='PROXY_AUTH_REQUIRED';d.reason='timeout';}
 if(scenario==='conflicting429'){code='PROXY_CONNECT_FAILED';d={...d,reason:'timeout',proxyConnectStatus:429};}
 if(scenario==='conflictingTls'){code='UPSTREAM_TLS_FAILED';d.reason='timeout';}
 if(scenario==='generic'){code='UPSTREAM_TRANSPORT_FAILED';d.reason='timeout';}
 if(scenario==='malformed'){code='private-error-code';d={phase:'private-phase',reason:'private-reason',elapsedMs:'private-time',requestWritten:'private-boolean',hostname:'private-host'};}
 send({error:'private-native-error-with-private-token',code,diagnostic:d,private:'private-extra'});
});
`,
    { mode: 0o755 },
  );
  const events: TransportAttempt[] = [];
  const transport = new NativeTransport(binary, {
    retryDelaysMs: [0, 0],
    onAttempt: (event) => {
      events.push(event);
    },
    ...options,
  });
  t.after(() => transport.close());
  const environment = createEnvironment('PH', 'http://private-user:private-password@gateway.invalid:8080');
  environment.cookies = [{ name: 'login', value: 'private-cookie', domain: 'chatgpt.com' }];
  environment.headers.authorization = 'Bearer private-access';
  await transport.initialize(environment, signal);
  return {
    transport,
    events,
    environment,
    records: async () =>
      (await readFile(records, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}
const get: HttpInput = {
  method: 'GET',
  url: 'https://chatgpt.com/backend-api/accounts/check/v4?token=private-query',
};

test('browser cookie expiry fractions are normalized before reinitializing the native helper', async (t) => {
  const f = await fixture(t);
  f.environment.cookies = [
    { name: 'rotated', value: 'session', domain: 'chatgpt.com', expires: 1794906795.273 },
    { name: 'temporary', value: 'session', domain: 'chatgpt.com', expires: -1 },
    { name: 'invalid', value: 'session', domain: 'chatgpt.com', expires: NaN },
  ];
  await f.transport.initialize(f.environment);
  const message = (await f.records()).at(-1);
  assert.equal(message.method, 'initialize');
  assert.equal(message.cookies[0].expires, 1794906795);
  assert.equal('expires' in message.cookies[1], false);
  assert.equal('expires' in message.cookies[2], false);
  assert.equal(f.environment.cookies[0].expires, 1794906795.273);
});

test('every request replays Chrome header order instead of the map order', async (t) => {
  const f = await fixture(t);
  await f.transport.request(get);
  const readOrder = async () => {
    const message = (await f.records())
      .filter((x: any) => x.method === 'GET' || x.method === 'POST')
      .at(-1);
    return { order: message.headerOrder as string[], headers: message.headers };
  };
  const first = await readOrder();
  assert.deepEqual(first.order, [
    'content-length',
    'authorization',
    'sec-ch-ua-platform',
    'user-agent',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'accept-encoding',
    'accept-language',
    'priority',
  ]);
  assert.equal(first.headers['accept-encoding'], 'gzip, deflate, br, zstd');
  assert.equal(first.headers.authorization, 'Bearer private-access');
  await f.transport.request({
    method: 'POST',
    url: 'https://api.stripe.com/v1/payment_intents/pi_fixture/confirm',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', origin: 'https://js.stripe.com' },
    body: 'client_secret=cs_fixture',
  });
  const second = await readOrder();
  assert.deepEqual(second.order, [
    'content-length',
    'authorization',
    'sec-ch-ua-platform',
    'user-agent',
    'sec-ch-ua',
    'content-type',
    'sec-ch-ua-mobile',
    'accept',
    'origin',
    'accept-encoding',
    'accept-language',
    'priority',
  ]);
});

test('an uncorrelated helper initialization rejection fails immediately', async (t) => {
  await assert.rejects(fixture(t, 'invalid-init'), (error: NativeTransportError) => error.code === 'NATIVE_TRANSPORT_FAILED');
});
function assertNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [
    'private-error',
    'private-user',
    'private-password',
    'private-cookie',
    'private-token',
    'private-query',
    'private-access',
    'private-phase',
    'private-reason',
    'private-time',
    'private-boolean',
    'private-host',
    'private-extra',
    'private-success-error',
  ])
    assert.ok(!text.includes(secret), secret);
}

test('a transient GET retries on fresh sockets while preserving the helper, cookies and safe attempt diagnostics', async (t) => {
  const f = await fixture(t);
  const output = await f.transport.request(get);
  assert.equal(output.status, 200);
  assert.deepEqual(
    f.events.map((x) => x.outcome),
    ['running', 'retrying', 'running', 'succeeded'],
  );
  assert.deepEqual(
    output.transportAttempts?.map((x) => x.outcome),
    ['retrying', 'succeeded'],
  );
  assert.deepEqual(
    (await f.records()).map((x) => x.method),
    ['initialize', 'GET', 'reset_connections', 'GET'],
  );
  assert.equal(f.environment.cookies[0].value, 'updated');
  const serialized = JSON.stringify(f.events);
  for (const secret of [
    'private-error',
    'private-user',
    'private-password',
    'private-cookie',
    'private-token',
    'private-query',
    'private-access',
  ])
    assert.ok(!serialized.includes(secret), secret);
});

test('the retry limit is three total attempts and final error audit retains only safe diagnostics', async (t) => {
  const f = await fixture(t, 'fail');
  await assert.rejects(f.transport.request(get), (error: NativeTransportError) => {
    assert.equal(error.code, 'UPSTREAM_CONNECTION_CLOSED');
    assert.equal(error.transportAttempts?.length, 3);
    assert.equal(error.transportAttempts?.[2].retryStopReason, 'attempt_limit');
    const detail = auditError(error);
    assert.equal(detail.transportDiagnostic.phase, 'tls_handshake');
    assert.equal(detail.transportAttempts.length, 3);
    assertNoSecrets(detail);
    return true;
  });
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 3);
  assert.equal((await f.records()).filter((x) => x.method === 'reset_connections').length, 2);
});

for (const scenario of [
  'certificate',
  'unknown',
  'written',
  'authentication',
  'proxy429',
  'malformed',
  'conflicting403',
  'conflicting407',
  'conflicting429',
  'conflictingTls',
  'generic',
])
  test(`${scenario} transport failures are not retried`, async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.transport.request(get), (error: NativeTransportError) => {
      assert.equal(error.transportAttempts?.length, 1);
      assert.equal(error.transportAttempts?.[0].retryStopReason, 'not_safe_to_retry');
      assertNoSecrets(auditError(error));
      return true;
    });
    assert.deepEqual(
      (await f.records()).map((x) => x.method),
      ['initialize', 'GET'],
    );
  });

for (const scenario of ['http403', 'http429'])
  test(`${scenario} responses and challenge pages are returned once without replay`, async (t) => {
    const f = await fixture(t, scenario);
    const output = await f.transport.request(get);
    assert.equal(output.status, scenario === 'http403' ? 403 : 429);
    assert.equal(output.transportAttempts?.length, 1);
    assert.deepEqual(
      (await f.records()).map((x) => x.method),
      ['initialize', 'GET'],
    );
  });

test('temporary CONNECT 503 failures have a bounded GET retry', async (t) => {
  const f = await fixture(t, 'proxy503');
  await assert.rejects(f.transport.request(get), (error: NativeTransportError) => {
    assert.equal(error.transportAttempts?.length, 3);
    assert.equal(error.diagnostic?.proxyConnectStatus, 503);
    return true;
  });
});

test('POST checkout and confirmation requests are never replayed even before an observed write', async (t) => {
  const f = await fixture(t, 'fail');
  for (const path of ['/backend-api/payments/checkout', '/backend-api/payments/checkout/confirm']) {
    await assert.rejects(
      f.transport.request({
        method: 'POST',
        url: 'https://chatgpt.com' + path,
        body: '{}',
      }),
    );
  }
  assert.deepEqual(
    (await f.records()).map((x) => x.method),
    ['initialize', 'POST', 'POST'],
  );
});

test('close interrupts a retry wait and queued requests without starting another helper request', async (t) => {
  const f = await fixture(t, 'fail', { retryDelaysMs: [500, 1500] });
  let signal!: () => void;
  const scheduled = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const first = f.transport.request(get, {
    onAttempt: (event) => {
      f.events.push(event);
      if (event.outcome === 'retrying') signal();
    },
  });
  const second = f.transport.request(get);
  const settled = Promise.allSettled([first, second]);
  await scheduled;
  f.transport.close();
  const results = await settled;
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason.code, 'TRANSPORT_CLOSED');
  }
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 1);
  assert.equal(f.events.at(-1)?.retryStopReason, 'closed');
});

test('an execution signal immediately cancels a native retry backoff without another wire attempt', async (t) => {
  const cancellation = new AbortController();
  const f = await fixture(t, 'fail', { retryDelaysMs: [500, 1500] }, cancellation.signal);
  let scheduled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  const request = f.transport.request(get, {
    onAttempt: (event) => {
      f.events.push(event);
      if (event.outcome === 'retrying') scheduled();
    },
  });
  const rejected = assert.rejects(request, { code: 'TRANSPORT_CLOSED' });
  await waiting;
  cancellation.abort();
  await rejected;
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 1);
  assert.equal(f.events.at(-1)?.retryStopReason, 'closed');
});

test('the overall retry budget terminates a hanging helper and records budget exhaustion', async (t) => {
  const f = await fixture(t, 'budget', { retryBudgetMs: 40 });
  const started = Date.now();
  await assert.rejects(f.transport.request(get), (error: NativeTransportError) => {
    assert.equal(error.code, 'TRANSPORT_BUDGET_EXHAUSTED');
    assert.equal(error.transportAttempts?.[0].retryStopReason, 'budget_exhausted');
    return true;
  });
  assert.ok(Date.now() - started < 1500);
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 1);
});

test('a budget-aware helper can return incomplete evidence without being killed or replaying the request', async (t) => {
  const f = await fixture(t, 'native-budget', { retryBudgetMs: 1000 });
  await assert.rejects(f.transport.request({ ...get, method: 'POST', body: '{}' }), (error: NativeTransportError) => {
    assert.equal(error.code, 'TRANSPORT_BUDGET_EXHAUSTED');
    assert.equal(error.diagnostic?.phase, 'response_body');
    assert.equal(error.diagnostic?.reason, 'timeout');
    assert.equal(error.transportAttempts?.[0].retryStopReason, 'budget_exhausted');
    assert.deepEqual(error.httpResponse, {
      status: 202,
      headers: { 'request-id': ['req_fixture'] },
      body: 'partial',
      partial: true,
    });
    return true;
  });
  assert.equal((await f.transport.request(get)).status, 200);
  const [initialize, post, read] = await f.records();
  assert.deepEqual([initialize.method, post.method, read.method], ['initialize', 'POST', 'GET']);
  assert.equal(initialize.timeoutMs, undefined);
  for (const message of [post, read]) {
    assert.ok(Number.isInteger(message.timeoutMs) && message.timeoutMs > 0 && message.timeoutMs <= 900);
  }
});

test('a retry reset cannot race a concurrent request in the same transport', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.transport.request(get), f.transport.request(get)]);
  assert.ok(responses.every((x) => x.status === 200));
  assert.deepEqual(
    (await f.records()).map((x) => x.method),
    ['initialize', 'GET', 'reset_connections', 'GET', 'GET'],
  );
});

test('a slow audit sink cannot start another request after the overall budget expires', async (t) => {
  const f = await fixture(t, 'fail', {
    retryBudgetMs: 80,
    onAttempt: async (event) => {
      if (event.outcome === 'retrying') await new Promise((resolve) => setTimeout(resolve, 120));
    },
  });
  await assert.rejects(f.transport.request(get), (error: NativeTransportError) => {
    assert.equal(error.code, 'TRANSPORT_BUDGET_EXHAUSTED');
    assert.equal(error.transportAttempts?.[0].retryStopReason, 'budget_exhausted');
    return true;
  });
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 1);
});

test('one request can shorten the retry budget, and never enlarge it', async (t) => {
  // The 'budget' helper answers after 1000ms, so a short request budget must
  // stop it early instead of waiting for the helper.
  const f = await fixture(t, 'budget', { retryBudgetMs: 5000 });
  const shortened = Date.now();
  await assert.rejects(
    f.transport.request(get, { retryBudgetMs: 150 }),
    (error: NativeTransportError) => {
      assert.equal(error.code, 'TRANSPORT_BUDGET_EXHAUSTED');
      return true;
    },
  );
  assert.ok(Date.now() - shortened < 1000, 'the per-request budget shortened the wait');
  assert.equal((await f.records()).filter((x: any) => x.method === 'GET').length, 1);

  // A larger per-request value cannot widen the configured policy.
  const bounded = await fixture(t, 'budget', { retryBudgetMs: 150 });
  const started = Date.now();
  await assert.rejects(bounded.transport.request(get, { retryBudgetMs: 60_000 }));
  assert.ok(Date.now() - started < 1000, 'the configured budget still bounds the request');
});

test('the fresh execution guard prevents a GET retry after its first failed attempt is taken over', async (t) => {
  const cancellation = new AbortController();
  const f = await fixture(t, 'fail', {}, cancellation.signal);
  let takenOver = false;
  const engine = new ProtocolEngine(
    { context: { environment: f.environment }, run: {} } as any,
    {
      signal: cancellation.signal,
      assertActive: async () => {
        if (takenOver) {
          cancellation.abort();
          throw new Error('manual takeover');
        }
      },
      request: async (_action, body) => {
        if (body.step.response?.outcome === 'retrying') takenOver = true;
      },
    },
    f.transport,
  );
  await assert.rejects((engine as any).request('只读请求', get), { code: 'EXECUTION_ABORTED' });
  assert.equal((await f.records()).filter((x) => x.method === 'GET').length, 1);
});

for (const scenario of ['recover', 'fail'])
  test(`the engine's durable HTTP audit includes ${scenario} attempts without raw helper secrets`, async (t) => {
    const f = await fixture(t, scenario);
    const steps: any[] = [];
    const engine = new ProtocolEngine(
      {
        context: {
          environment: f.environment,
          exitFingerprint: 'abcdef123456',
          exitCountry: 'PH',
          exitProbe: {
            observedAt: '2026-11-24T07:00:00.000Z',
            source: 'chatgpt.com',
            simulated: false,
          },
        },
        run: {},
      } as any,
      {
        request: async (action: string, body: any) => {
          if (action === 'step') steps.push(body.step);
        },
      },
      f.transport,
    );
    const operation = (engine as any).request('测试账号只读查询', get);
    if (scenario === 'recover') await operation;
    else await assert.rejects(operation);
    const parent = steps.filter((x) => x.name === '测试账号只读查询');
    const attempts = steps.filter((x) => x.name === '原生 HTTP 传输尝试');
    assert.equal(parent[0].request.exitFingerprint, 'abcdef123456');
    assert.equal(parent[0].request.exitProbe.source, 'chatgpt.com');
    assert.equal(attempts.filter((x) => x.status === 'running').length, scenario === 'recover' ? 2 : 3);
    assert.equal(new Set(attempts.map((x) => x.traceId)).size, scenario === 'recover' ? 2 : 3);
    if (scenario === 'recover') assert.equal(parent.at(-1).response.transportAttempts.length, 2);
    else assert.equal(parent.at(-1).errorDetail.transportAttempts.length, 3);
    assertNoSecrets(steps);
  });
