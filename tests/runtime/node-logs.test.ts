import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpController } from '../../apps/worker/src/runtime/controller.js';
import type { Assignment } from '../../packages/contracts/src/execution.js';

test('runtime and order events share an encrypted outbox, survive restart and replay through their own endpoints', async (t) => {
  const directory = await mkdtemp('/tmp/relay-node-logs-');
  const previousDirectory = process.env.WORKER_LOG_DIR;
  process.env.WORKER_LOG_DIR = directory;
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.WORKER_LOG_DIR;
    else process.env.WORKER_LOG_DIR = previousDirectory;
  });
  let online = false;
  const received: { path: string; body: any }[] = [];
  const upstream = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    response.setHeader('content-type', 'application/json');
    if (!online) {
      response.statusCode = 503;
      response.end('{"message":"temporarily offline"}');
      return;
    }
    received.push({ path: request.url!, body: JSON.parse(text) });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + (upstream.address() as any).port;
  const controller = new HttpController(origin, 'relaynode.owner.node.private-token');
  await controller.initializeLogs();
  await controller.logEvent('节点 · 控制台通信异常', {
    request: { authorization: 'Bearer credential-canary' },
    error: new Error('connection failed', {
      cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    }),
  });
  const assignment = { run: { id: 'order-run', workerLease: 'private-lease' } } as Assignment;
  await controller.logEvent('执行节点任务已中断', { status: 'skipped' }, assignment);
  await controller.flushLogs();
  assert.equal(controller.pendingLogs, 2);
  for (const file of await readdir(directory)) {
    const bytes = await readFile(join(directory, file), 'utf8');
    assert.doesNotMatch(bytes, /credential-canary|private-lease|ETIMEDOUT|节点/);
  }
  const restarted = new HttpController(origin, 'relaynode.owner.node.private-token');
  await restarted.initializeLogs();
  assert.equal(restarted.pendingLogs, 2);
  online = true;
  await restarted.flushLogs();
  assert.equal(restarted.pendingLogs, 0);
  assert.deepEqual(
    received.map((entry) => entry.path),
    ['/api/worker/node-logs', '/api/worker/logs'],
  );
  assert.equal(received[0].body.runId, undefined);
  assert.equal(received[0].body.step.errorDetail.cause.code, 'ETIMEDOUT');
  assert.ok(!JSON.stringify(received).includes('credential-canary'));
  assert.equal(received[1].body.runId, 'order-run');
  assert.equal(received[1].body.lease, 'private-lease');
  assert.equal(received[1].body.step.status, 'skipped');
});

test('a console without runtime logging does not block order log delivery', async (t) => {
  const directory = await mkdtemp('/tmp/relay-node-old-console-');
  const previousDirectory = process.env.WORKER_LOG_DIR;
  process.env.WORKER_LOG_DIR = directory;
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.WORKER_LOG_DIR;
    else process.env.WORKER_LOG_DIR = previousDirectory;
  });
  const received: string[] = [];
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume the request before acknowledging */
    }
    received.push(request.url!);
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/api/worker/node-logs' ? 404 : 200;
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const controller = new HttpController(
    'http://127.0.0.1:' + (upstream.address() as any).port,
    'relaynode.owner.node.token',
  );
  await controller.initializeLogs();
  await controller.logEvent('节点 · 启动');
  await controller.flushLogs();
  await controller.logEvent('执行节点接收订单', {}, {
    run: { id: 'order-run', workerLease: 'lease' },
  } as Assignment);
  await controller.flushLogs();
  assert.deepEqual(received, ['/api/worker/node-logs', '/api/worker/logs']);
  assert.equal(controller.pendingLogs, 0);
});
