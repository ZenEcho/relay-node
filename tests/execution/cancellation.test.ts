import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { ProtocolEngine } from '../../apps/worker/src/execution/engine.js';
import { DemoTransport } from '../../apps/worker/src/testing/demo-transport.js';
import { HttpController } from '../../apps/worker/src/runtime/controller.js';
import { ExecutionCancellations } from '../../apps/worker/src/runtime/cancellation.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import { digest } from '../../packages/runtime/src/security.js';
import type { Assignment, Control } from '../../packages/contracts/src/execution.js';
import type { HttpInput, HttpOutput } from '../../apps/worker/src/transport/native.js';
import type { SentinelAuthorizer, SentinelRequest } from '../../packages/contracts/src/sentinel.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation did not settle promptly')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function setup(pausePath?: string, authorizer?: SentinelAuthorizer) {
  const cancellation = new AbortController();
  const pending = deferred<HttpOutput>(),
    entered = deferred<void>();
  const requests: HttpInput[] = [],
    commands: { action: string; body: any }[] = [];
  let closes = 0;
  class Transport extends DemoTransport {
    constructor() {
      super(0);
    }
    override async request(input: HttpInput) {
      requests.push(structuredClone(input));
      if (pausePath && new URL(input.url).pathname === pausePath) {
        entered.resolve();
        return pending.promise;
      }
      return super.request(input);
    }
    override close() {
      closes++;
    }
  }
  const assignment = {
    mode: 'execute',
    demo: !authorizer,
    paymentEnabled: true,
    run: {
      id: 'original-run',
      workerLease: 'original-lease',
      paymentSubmitted: false,
      dispatches: {},
      order: { cdkPaymentCurrency: 'PHP' },
      workflow: { plan: 'gpt_plus', cleanup: {} },
    },
    context: {
      environment: createEnvironment('PH', ''),
      credential: JSON.stringify({
        accessToken: 'test-access',
        account: { id: 'demo-account' },
        user: { email: 'test@example.invalid' },
      }),
    },
    billing: {
      name: 'Test',
      line1: '123 Test',
      city: 'Manila',
      state: '',
      postalCode: '1000',
      country: 'PH',
    },
  } as Assignment;
  const control: Control = {
    signal: cancellation.signal,
    request: async (action, body) => {
      commands.push({ action, body: structuredClone(body) });
      if (action === 'card')
        return { number: '4242424242424242', cvc: '123', expiry: '12/30', lastFour: '4242' };
      return {};
    },
  };
  const transport = new Transport();
  return {
    cancellation,
    pending,
    entered,
    requests,
    commands,
    assignment,
    control,
    transport,
    closes: () => closes,
    engine: new ProtocolEngine(assignment, control, transport, authorizer),
  };
}

test('an already cancelled execution performs no initialization, request or completion write', async () => {
  const f = setup();
  f.cancellation.abort();
  await f.engine.execute();
  assert.equal(f.requests.length, 0);
  assert.equal(f.commands.length, 0);
  assert.ok(f.closes() >= 1);
});

test('cancelling an in-flight payment discards its late success without finishing, cleanup or another payment write', async () => {
  const f = setup('/backend-api/payments/checkout/confirm');
  const execution = f.engine.execute();
  await bounded(f.entered.promise);
  assert.equal(f.assignment.run.paymentSubmitted, true);
  f.cancellation.abort();
  await bounded(execution);
  f.pending.resolve({
    status: 200,
    headers: {},
    body: '{}',
    data: {
      status: 'success',
      client_secret: 'pi_original_secret_original',
      confirm_return_url: 'https://chatgpt.com/',
    },
  });
  await delay(20);
  assert.equal(
    f.assignment.run.paymentSubmitted,
    true,
    'cancellation cannot erase a dispatched payment fact',
  );
  assert.equal(f.assignment.context.merchantConfirmation, undefined);
  assert.equal(f.requests.filter((x) => new URL(x.url).pathname.endsWith('/checkout/confirm')).length, 1);
  assert.ok(
    !f.requests.some((x) => x.url.includes('/payment_intents/') || x.url.endsWith('/checkout_session')),
  );
  assert.ok(!f.commands.some((x) => x.action === 'finish'));
  assert.ok(f.closes() >= 1);
});

test('a custom Sentinel provider that ignores cancellation cannot block the execution or commit a late token', async () => {
  const entered = deferred<SentinelRequest>(),
    token = deferred<any>();
  const f = setup(undefined, (request) => {
    entered.resolve(request);
    return token.promise;
  });
  const execution = f.engine.execute();
  const request = await bounded(entered.promise);
  f.cancellation.abort();
  await bounded(execution);
  token.resolve({
    ...request,
    token: 'late-private-token',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await delay(20);
  assert.equal(f.assignment.context.sentinel, undefined);
  assert.ok(!f.requests.some((x) => new URL(x.url).pathname === '/backend-api/payments/checkout'));
  assert.ok(!f.commands.some((x) => x.action === 'finish' || x.action === 'card'));
});

test('a custom Stripe provider cannot commit a late token after manual cancellation', async () => {
  const f = setup();
  const entered = deferred<any>(),
    prepared = deferred<any>();
  const engine = new ProtocolEngine(
    f.assignment,
    f.control,
    f.transport,
    undefined,
    async (_request, card) => {
      entered.resolve(card);
      return prepared.promise;
    },
  );
  const execution = engine.execute();
  const card = await bounded(entered.promise);
  f.cancellation.abort();
  await bounded(execution);
  prepared.resolve({ id: 'ctoken_late', lastFour: '4242' });
  await delay(20);
  assert.equal(card.number, '');
  assert.equal(card.cvc, '');
  assert.equal(f.assignment.context.confirmationToken, undefined);
  assert.ok(!f.commands.some((x) => x.action === 'finish'));
  assert.ok(!f.requests.some((x) => x.url.endsWith('/checkout/confirm')));
});

test('the fresh execution guard prevents a request after its running audit has already been written', async () => {
  const f = setup();
  f.control.assertActive = async () => {
    f.cancellation.abort();
    throw new Error('manual takeover');
  };
  await f.engine.execute();
  assert.equal(f.requests.length, 0);
  assert.ok(f.commands.some((x) => x.action === 'step'));
  assert.ok(!f.commands.some((x) => x.action === 'finish'));
});

test('a takeover after payment authorization prevents the payment HTTP request from starting', async () => {
  const f = setup();
  let takenOver = false;
  const original = f.control.request;
  f.control.request = async (action, body) => {
    const result = await original(action, body);
    if (action === 'authorize' && body.action === 'merchant_confirm') takenOver = true;
    return result;
  };
  f.control.assertActive = async () => {
    if (takenOver) {
      f.cancellation.abort();
      throw new Error('manual takeover');
    }
  };
  await f.engine.execute();
  assert.equal(takenOver, true);
  assert.ok(!f.requests.some((x) => x.url.endsWith('/checkout/confirm')));
  assert.ok(!f.commands.some((x) => x.action === 'finish'));
});

test('heartbeat cancellation matches both the run and original lease and does not kill a newer lease', () => {
  const registry = new ExecutionCancellations();
  const old = registry.register('original-run', 'old-lease')!;
  const current = registry.register('original-run', 'new-lease')!;
  registry.apply([
    { id: 'other-run', leaseDigest: digest('old-lease') },
    { id: 'original-run', leaseDigest: 'bad' },
  ]);
  assert.equal(old.controller.signal.aborted, false);
  registry.apply([{ id: 'original-run', leaseDigest: digest('old-lease') }]);
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(current.controller.signal.aborted, false);
  old.dispose();
  assert.equal(registry.register('original-run', 'old-lease')!.controller.signal.aborted, true);
  current.dispose();
});

for (const status of [401, 403, 404, 409])
  test(`an invalid run lease response ${status} aborts the scoped control before another action`, async (t) => {
    const upstream = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      assert.equal(JSON.parse(raw).lease, 'original-lease');
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: status === 409 ? 'RUN_MANUAL_TAKEOVER' : 'FORBIDDEN',
          message: 'lease unavailable',
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const control = new HttpController(
      'http://127.0.0.1:' + (upstream.address() as any).port,
      'test-node-token',
    ).forRun({ run: { id: 'original-run', workerLease: 'original-lease' } } as Assignment);
    await assert.rejects(control.assertActive!(), { code: 'EXECUTION_ABORTED' });
    assert.equal(control.signal!.aborted, true);
    await assert.rejects(control.request('authorize', { action: 'merchant_confirm' }), {
      code: 'EXECUTION_ABORTED',
    });
  });

test('an unrelated conflict does not become a manual-cancellation signal', async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'DISPATCH_ALREADY_STARTED', message: 'original dispatch exists' }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const control = new HttpController(
    'http://127.0.0.1:' + (upstream.address() as any).port,
    'test-node-token',
  ).forRun({ run: { id: 'original-run', workerLease: 'original-lease' } } as Assignment);
  await assert.rejects(control.request('authorize'), { code: 'DISPATCH_ALREADY_STARTED' });
  assert.equal(control.signal!.aborted, false);
});
