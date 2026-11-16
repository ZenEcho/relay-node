import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer, connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startSdkProxy } from '../../apps/worker/src/transport/browser-proxy.js';
import {
  OnDemandSdkRuntime,
  findSdkBrowser,
  executeWithOnDemandSdk,
  sdkLoginCookies,
  withSdkLease,
  checkPaymentRuntime,
  defaultSentinelRuntime,
} from '../../apps/worker/src/browser/runtime.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import type { HttpInput } from '../../apps/worker/src/transport/native.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

test('omitted Sentinel configuration selects the packaged reference bridge', () => {
  assert.deepEqual(defaultSentinelRuntime(), {
    mode: 'reference',
    bridgePath: new URL('../../runtime/reference-sentinel/sentinel_bridge.js', import.meta.url).pathname,
  });
});

test('a null Sentinel configuration cannot silently select the official browser', async () => {
  await assert.rejects(
    checkPaymentRuntime({ executablePath: process.execPath }, null as any),
    /不支持的 Sentinel 运行模式/,
  );
});

async function listen(server: any) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
function request(port: number, authorization?: string, payload = '') {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  socket.write(
    'CONNECT stripe.fixture:443 HTTP/1.1\r\nHost: stripe.fixture:443\r\n' +
      (authorization ? 'Proxy-Authorization: ' + authorization + '\r\n' : '') +
      '\r\n' +
      payload,
  );
  return socket;
}
async function readHeaders(socket: any) {
  let text = '';
  for await (const chunk of socket) {
    text += chunk.toString();
    if (text.includes('\r\n\r\n')) {
      socket.destroy();
      return text;
    }
  }
  return text;
}

test('the temporary HTTP bridge authenticates locally and keeps upstream credentials in the CONNECT channel', async (t) => {
  let calls = 0,
    seen = '';
  const upstream = httpServer();
  const sockets = new Set<any>();
  upstream.on('connection', (s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  });
  upstream.on('connect', (req, socket, head) => {
    calls++;
    seen = req.headers['proxy-authorization'] || '';
    assert.equal(req.url, 'stripe.fixture:443');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n' + head.toString());
    socket.on('data', (data) => socket.write(data));
  });
  const port = await listen(upstream),
    proxy = await startSdkProxy(`http://user:pass@127.0.0.1:${port}`);
  t.after(async () => {
    await proxy.close();
    for (const s of sockets) s.destroy();
    upstream.close();
  });
  const localPort = Number(new URL(proxy.server).port);
  assert.match(await readHeaders(request(localPort)), /^HTTP\/1\.1 407/);
  assert.equal(calls, 0);
  const auth = 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
  assert.match(await readHeaders(request(localPort, auth, 'fixture-data')), /^HTTP\/1\.1 200/);
  assert.equal(calls, 1);
  assert.equal(seen, 'Basic ' + Buffer.from('user:pass').toString('base64'));
  assert.ok(!proxy.server.includes('user') && !proxy.server.includes('pass'));
});

test('the temporary bridge performs SOCKS5 username/password authentication without exposing it to Chrome', async (t) => {
  let authenticated = false,
    connected = false;
  const sockets = new Set<any>();
  const upstream = netServer((socket) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let state = 0,
      data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (state === 0 && data.length >= 4) {
        assert.deepEqual([...data.subarray(0, 4)], [5, 2, 0, 2]);
        data = data.subarray(4);
        state = 1;
        socket.write(Buffer.from([5, 2]));
      } else if (state === 1 && data.length >= 11) {
        assert.equal(data[0], 1);
        const length = data[1];
        assert.equal(data.subarray(2, 2 + length).toString(), 'user');
        const passLength = data[2 + length];
        assert.equal(data.subarray(3 + length, 3 + length + passLength).toString(), 'pass');
        data = data.subarray(3 + length + passLength);
        authenticated = true;
        state = 2;
        socket.write(Buffer.from([1, 0]));
      } else if (state === 2 && data.length >= 5 + data[4] + 2) {
        assert.deepEqual([...data.subarray(0, 4)], [5, 1, 0, 3]);
        assert.equal(data.subarray(5, 5 + data[4]).toString(), 'stripe.fixture');
        assert.equal(data.readUInt16BE(5 + data[4]), 443);
        connected = true;
        state = 3;
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 2]));
      } else if (state === 3) socket.write(chunk);
    });
  });
  const port = await listen(upstream),
    proxy = await startSdkProxy(`socks5://user:pass@127.0.0.1:${port}`);
  t.after(async () => {
    await proxy.close();
    for (const s of sockets) s.destroy();
    upstream.close();
  });
  const auth = 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
  assert.match(
    await readHeaders(request(Number(new URL(proxy.server).port), auth)),
    /^HTTP\/1\.1 200/,
  );
  assert.equal(authenticated, true);
  assert.equal(connected, true);
});

test('an upstream proxy rejection closes the attempted SDK connection without a direct fallback', async (t) => {
  const upstream = httpServer();
  upstream.on('connect', (_req, socket) =>
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'),
  );
  const port = await listen(upstream),
    proxy = await startSdkProxy(`http://127.0.0.1:${port}`);
  t.after(async () => {
    await proxy.close();
    upstream.close();
  });
  const auth = 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
  assert.match(
    await readHeaders(request(Number(new URL(proxy.server).port), auth)),
    /^HTTP\/1\.1 502/,
  );
});

test('the browser watchdog removes its owned profile and closes the browser when its parent pipe disappears', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-sdk-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'browser-fixture');
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const d=process.argv.find(x=>x.startsWith('--user-data-dir=')).slice(16);fs.writeFileSync(p.join(d,'DevToolsActivePort'),'1\\n/devtools/browser/fixture\\n');setInterval(()=>{},1000);`,
  );
  await chmod(executable, 0o700);
  const host = spawn(
    process.execPath,
    [new URL('../../dist/apps/worker/src/browser/host.js', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  host.stderr.resume();
  t.after(() => host.kill('SIGTERM'));
  const lines = createInterface({ input: host.stdout });
  host.stdin.write(JSON.stringify({ executablePath: executable, headless: true }) + '\n');
  const [line] = await once(lines, 'line');
  const info = JSON.parse(line);
  assert.ok(info.profile.startsWith(join(tmpdir(), 'relay-sdk-')));
  const exited = once(host, 'exit');
  host.stdin.end();
  await exited;
  await assert.rejects(access(info.profile));
  assert.throws(() => process.kill(info.pid, 0));
});

test('read-only recovery finishes despite missing Chrome and invalid reference configuration', async () => {
  await assert.rejects(findSdkBrowser('/does-not-exist/Chrome'), /需要 Chrome/);
  const assignment: any = {
    run: {
      id: 'original',
      paymentSubmitted: true,
      dispatches: {},
      workflow: { cleanup: {} },
      order: {},
    },
    context: {
      environment: createEnvironment('PH', ''),
      session: { accessToken: 'fixture' },
      checkout: { id: 'oaics_original', processor_entity: 'openai_llc' },
    },
    mode: 'reconcile',
    demo: false,
  };
  const sdk = new OnDemandSdkRuntime(assignment, {
    executablePath: '/does-not-exist/Chrome',
  });
  assert.equal(sdk.lifecycle.started, false);
  await sdk.close();
  assert.equal(sdk.lifecycle.disposed, true);
  const finishes: any[] = [];
  await executeWithOnDemandSdk(
    assignment,
    {
      request: async (action, body) => {
        if (action === 'finish') finishes.push(body);
        return {};
      },
    },
    {
      initialize: async () => {},
      close() {},
      request: async (input) => {
        assert.equal(input.method, 'GET');
        return {
          status: 200,
          headers: {},
          body: '{}',
          data: {
            checkout_session: {
              id: 'oaics_original',
              status: 'open',
              payment_status: 'unpaid',
            },
          },
        };
      },
    },
    { executablePath: '/does-not-exist/Chrome' },
    { mode: 'reference', bridgePath: 'invalid-relative-path', timeoutMs: 0 },
  );
  assert.equal(finishes.at(-1).status, 'pending_confirmation');
});

test('isolated SDK profiles receive only the original login family and device cookies', () => {
  const entries = [
    'oai-did',
    '__Secure-next-auth.session-token.0',
    '__Secure-next-auth.session-token.1',
    '__Host-next-auth.csrf-token',
    'cf_clearance',
    '__cf_bm',
    'preferences',
  ].map((name) => ({ name, value: 'fixture', domain: '.chatgpt.com' }));
  entries.push({
    name: '__Secure-next-auth.session-token',
    value: 'foreign',
    domain: '.other.example',
  });
  assert.deepEqual(
    sdkLoginCookies(entries).map((c) => c.name),
    entries.slice(0, 4).map((c) => c.name),
  );
});

test('SDK work renews its original lease and stops the pulse when the SDK action finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let finish!: (value: string) => void,
    pulses = 0;
  const assignment: any = { context: { phase: 'sentinel_ready' } };
  const pending = withSdkLease(
    assignment,
    {
      request: async (action, body) => {
        assert.equal(action, 'checkpoint');
        assert.equal(body.stage, 'sentinel_ready');
        pulses++;
        return {};
      },
    },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  t.mock.timers.tick(30000);
  await Promise.resolve();
  finish('prepared');
  assert.equal(await pending, 'prepared');
  assert.equal(pulses, 1);
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(pulses, 1);
});

test('lost execution ownership prevents a prepared SDK result from reaching the payment phase', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let finish!: () => void;
  const pending = withSdkLease(
    { context: {} } as any,
    {
      request: async () => {
        throw new Error('lease revoked');
      },
    },
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = assert.rejects(pending, /lease revoked/);
  t.mock.timers.tick(30000);
  await Promise.resolve();
  finish();
  await rejected;
});

test('a card that does not match the assigned last four is rejected before starting a browser', async () => {
  const runtime = new OnDemandSdkRuntime(
    { context: { environment: createEnvironment('PH', '') } } as any,
    { executablePath: '/does-not-exist/Chrome' },
  );
  await assert.rejects(
    runtime.prepareStripeToken({ cardLastFour: '6741' } as any, {
      number: '4242424242424242',
      expiry: '12/30',
      cvc: '123',
    }),
    /卡片资料不完整/,
  );
  assert.equal(runtime.lifecycle.started, false);
  await runtime.close();
});

test('configured reference Sentinel completes preflight without starting the official browser', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reference-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridgePath = join(directory, 'bridge.cjs');
  await writeFile(
    bridgePath,
    `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const p=JSON.parse(input);process.stdout.write(JSON.stringify({main:JSON.stringify({p:'reference-proof',c:'reference-challenge',id:p.deviceId,flow:p.flow})}));});`,
  );
  const assignment: any = {
    run: {
      id: 'reference-preflight',
      order: {},
      workflow: { plan: 'gpt_plus', cleanup: {} },
      dispatches: {},
    },
    context: {
      environment: createEnvironment('PH', ''),
      credential: JSON.stringify({ accessToken: 'test-access', account: { id: 'demo-account' } }),
    },
    demo: false,
    paymentEnabled: false,
    mode: 'execute',
  };
  const events: any[] = [];
  await executeWithOnDemandSdk(
    assignment,
    {
      request: async (action, body) => {
        events.push({ action, body });
        return {};
      },
    },
    new DemoTransport(0),
    { executablePath: '/does-not-exist/Chrome' },
    { mode: 'reference', bridgePath },
  );
  assert.equal(JSON.parse(assignment.context.sentinel).p, 'reference-proof');
  assert.ok(events.some((e) => e.action === 'checkpoint' && e.body.stage === 'sentinel_ready'));
  assert.match(events.findLast((e) => e.action === 'finish').body.error, /真实付款未启用/);
  assert.ok(!events.some((e) => e.action === 'card' || e.action === 'authorize'));
});

test('reference readiness requires its bridge without requiring Chrome', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reference-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridgePath = join(directory, 'bridge.cjs');
  await writeFile(bridgePath, '');
  await checkPaymentRuntime(
    { executablePath: '/does-not-exist/Chrome' },
    { mode: 'reference', bridgePath },
  );
  await assert.rejects(
    checkPaymentRuntime(
      { executablePath: '/does-not-exist/Chrome' },
      { mode: 'reference', bridgePath: join(directory, 'missing') },
    ),
    /BRIDGE_UNAVAILABLE/,
  );
});

test('official Sentinel readiness still requires Chrome', async () => {
  await checkPaymentRuntime({ executablePath: process.execPath }, { mode: 'official' });
  await assert.rejects(
    checkPaymentRuntime({ executablePath: '/does-not-exist/Chrome' }, { mode: 'official' }),
    /需要 Chrome/,
  );
});

test('reference execution prepares the original card through the API without Chrome', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reference-payment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bridgePath = join(directory, 'bridge.cjs');
  await writeFile(
    bridgePath,
    `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const p=JSON.parse(input);process.stdout.write(JSON.stringify({main:JSON.stringify({p:'reference-proof',c:'reference-challenge',id:p.deviceId,flow:p.flow})}));});`,
  );
  const assignment: any = {
    run: {
      id: 'reference-payment',
      order: { cdkRedeemType: 'gpt_plus', cdkPaymentCurrency: 'PHP' },
      workflow: { plan: 'gpt_plus', cleanup: {} },
      paymentSubmitted: false,
      dispatches: {},
    },
    context: {
      environment: createEnvironment('PH', ''),
      credential: JSON.stringify({
        accessToken: 'test-access',
        account: { id: 'demo-account' },
        user: { email: 'test@example.invalid' },
      }),
    },
    demo: false,
    paymentEnabled: true,
    mode: 'execute',
    billing: { name: 'Test', line1: '123 Test St', city: 'Manila', postalCode: '1000', country: 'PH' },
  };
  const events: any[] = [],
    requests: HttpInput[] = [];
  class Transport extends DemoTransport {
    override async request(input: HttpInput) {
      requests.push(input);
      return super.request(input);
    }
  }
  await executeWithOnDemandSdk(
    assignment,
    {
      request: async (action, body) => {
        events.push({ action, body });
        if (action === 'card') return { number: '4242424242424242', expiry: '12/30', cvc: '123' };
        return {};
      },
    },
    new Transport(0),
    { executablePath: '/does-not-exist/Chrome' },
    { mode: 'reference', bridgePath },
  );
  const finish = events.findLast((event) => event.action === 'finish').body;
  assert.equal(finish.status, 'completed', finish.error);
  const tokenIndex = requests.findIndex((request) => request.url.endsWith('/v1/confirmation_tokens'));
  assert.ok(tokenIndex >= 0);
  const fields = new URLSearchParams(requests[tokenIndex].body);
  assert.equal(fields.get('payment_method_data[card][number]'), '4242424242424242');
  assert.equal(fields.get('payment_method_data[billing_details][email]'), 'test@example.invalid');
  assert.ok(requests.findIndex((request) => request.url.endsWith('/checkout/confirm')) > tokenIndex);
  assert.equal(JSON.parse(assignment.context.sentinel).p, 'reference-proof');
});

test('a missing reference bridge stops execution before assigning a card or authorizing payment', async () => {
  const events: any[] = [];
  await executeWithOnDemandSdk(
    {
      run: { id: 'missing-reference', order: {}, workflow: { plan: 'gpt_plus', cleanup: {} }, dispatches: {} },
      context: {
        environment: createEnvironment('PH', ''),
        credential: JSON.stringify({ accessToken: 'test-access', account: { id: 'demo-account' } }),
      },
      demo: false,
      paymentEnabled: true,
      mode: 'execute',
    } as any,
    {
      request: async (action, body) => {
        events.push({ action, body });
        return {};
      },
    },
    new DemoTransport(0),
    { executablePath: '/does-not-exist/Chrome' },
    { mode: 'reference', bridgePath: '/does-not-exist/sentinel-bridge.js' },
  );
  const finish = events.findLast((event) => event.action === 'finish').body;
  assert.equal(finish.status, 'failed');
  assert.match(finish.error, /参考 Sentinel 授权未完成/);
  assert.ok(!events.some((event) => event.action === 'card' || event.action === 'authorize'));
});
