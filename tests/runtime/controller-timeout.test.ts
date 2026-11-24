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
