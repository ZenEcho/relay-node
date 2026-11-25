import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpController } from '../../apps/worker/src/runtime/controller.js';
import type { Assignment } from '../../packages/contracts/src/execution.js';

test('lease checks piggyback the phase without uploading a checkpoint', async (t) => {
  const requests: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, input: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(input.body)) });
    return new Response('{"ok":true}');
  });
  const controller = new HttpController('http://console.invalid', 'test-node-token');
  const control = controller.forRun({ run: { id: 'original', workerLease: 'lease' } } as Assignment);
  await control.assertActive!('checkout');
  await control.assertActive!();
  assert.deepEqual(requests, [
    { url: 'http://console.invalid/api/worker/runs/original/check', body: { lease: 'lease', stage: 'checkout' } },
    { url: 'http://console.invalid/api/worker/runs/original/check', body: { lease: 'lease' } },
  ]);
});

test('card preparation has its own deadline, remains single-dispatch and still responds to cancellation', async (t) => {
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return timeout(ms);
  });
  let calls = 0, cancel!: () => void;
  t.mock.method(globalThis, 'fetch', async (_url: any, input: RequestInit) => {
    calls++;
    if (calls < 3) return new Response('{"ok":true}');
    return new Promise<Response>((_resolve, reject) => {
      input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
      cancel();
    });
  });
  const controller = new HttpController('http://console.invalid', 'test-node-token');
  await controller.request('runs/original/card');
  await controller.request('runs/original/authorize');
  assert.deepEqual(deadlines, [180000, 45000]);
  const cancellation = new AbortController();
  const entered = new Promise<void>((resolve) => { cancel = resolve; });
  const control = controller.forRun({ run: { id: 'original', workerLease: 'lease' } } as Assignment, cancellation);
  const pending = control.request('card');
  await entered;
  cancellation.abort();
  await assert.rejects(pending, { code: 'EXECUTION_ABORTED' });
  assert.equal(calls, 3);
});

test('dispatch timing correlates parallel polls with their first accepted lease checks', async (t) => {
  const diagnosticFlag = process.env.RELAY_PERFORMANCE_DIAGNOSTICS;
  process.env.RELAY_PERFORMANCE_DIAGNOSTICS = '1';
  t.after(() => {
    if (diagnosticFlag === undefined) delete process.env.RELAY_PERFORMANCE_DIAGNOSTICS;
    else process.env.RELAY_PERFORMANCE_DIAGNOSTICS = diagnosticFlag;
  });
  const entries: any[] = [];
  t.mock.method(console, 'info', (line: string) => entries.push(JSON.parse(line)));
  const requestIds: string[] = [];
  let pollCount = 0;
  let secondChecks = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, input: RequestInit) => {
    const requestId = new Headers(input.headers).get('x-relay-worker-request-id');
    assert.match(requestId!, /^[a-f0-9-]{36}$/);
    requestIds.push(requestId!);
    if (url.endsWith('/poll')) return Response.json({
      run: { id: 'private-run-' + ++pollCount, workerLease: 'private-lease' },
    });
    if (url.endsWith('/private-run-2/check') && ++secondChecks === 1)
      return Response.json({ message: 'private upstream error' }, { status: 500 });
    return Response.json({ ok: true });
  });

  const controller = new HttpController('http://console.invalid', 'private-node-token');
  const [first, second] = await Promise.all([controller.request('poll'), controller.request('poll')]);
  const firstControl = controller.forRun(first);
  const secondControl = controller.forRun(second);
  await assert.rejects(secondControl.assertActive!(), { status: 500 });
  await firstControl.assertActive!();
  await secondControl.assertActive!();
  await secondControl.assertActive!();
  await firstControl.request('checkpoint', { private: 'private-checkpoint' });
  controller.flushDiagnostics();

  assert.equal(new Set(requestIds).size, 7);
  const failure = entries.find((entry) => entry.outcome === 'http');
  assert.equal(failure.operation, 'check');
  assert.equal(failure.requestId, requestIds[2]);
  assert.equal(failure.pollRequestId, requestIds[1]);
  assert.equal(failure.status, 500);
  assert.doesNotMatch(JSON.stringify(entries), /private-/);
  const summary = entries.find((entry) => entry.event === 'relay.worker.performance.window').operations;
  assert.equal(summary.poll.elapsed.samples, 2);
  assert.equal(summary.assignmentStart.elapsed.samples, 2);
  assert.equal(summary.assignmentReceipt.elapsed.samples, 2);
  assert.equal(summary.check.elapsed.samples, 4);
  assert.equal(summary.check.failures, 1);
  assert.equal(summary.checkpoint.body.samples, 1);
});
