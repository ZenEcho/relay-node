import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerLogs } from '../../apps/worker/src/runtime/logs.js';
import { Vault, digest } from '../../packages/runtime/src/security.js';

const scope = 'https://console.invalid',
  token = 'private-node-token';
const valid = '12345678-1234-4234-a374-fb7f4267ebbf';
const broken = '[CARD]a374-fb7f4267ebbf';
function record(traceId: string, completed = true) {
  return {
    runId: 'run-1',
    lease: 'private-lease',
    queuedAt: new Date().toISOString(),
    step: {
      traceId,
      name: '检查本单代理出口',
      status: completed ? 'failed' : 'running',
      ...(completed ? { completedAt: new Date().toISOString() } : {}),
      request: { card_number: '[REDACTED]' },
    },
  };
}
async function fixture(
  t: TestContext,
  records: [string, ReturnType<typeof record>][],
  send: ConstructorParameters<typeof WorkerLogs>[3],
) {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'audit');
  await mkdir(directory);
  const file = join(directory, digest(scope + ':' + token).slice(0, 24) + '.sealed');
  const vault = new Vault(digest(token));
  await writeFile(file, vault.seal(records), { mode: 0o600 });
  const open = async () => {
    const logs = new WorkerLogs(directory, scope, token, send);
    await logs.initialize();
    return logs;
  };
  return {
    open,
    read: async () => vault.open<any[]>(await readFile(file, 'utf8')),
  };
}

test('legacy redacted trace IDs recover originals or stable UUIDs and merge late starts after restart', async (t) => {
  const sent: any[] = [];
  const f = await fixture(
    t,
    [
      ['run-1:' + valid, record(broken)],
      ['legacy-completed', record('[CARD]a111-fb7f4267ebbf')],
      ['legacy-late-start', record('[CARD]a111-fb7f4267ebbf', false)],
    ],
    async (r) => {
      sent.push(r);
    },
  );
  let logs = await f.open();
  assert.equal(logs.pending, 2);
  const repaired = await f.read();
  assert.equal(repaired[0][1].step.traceId, valid);
  assert.match(
    repaired[1][1].step.traceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.ok(repaired[1][1].step.completedAt);
  logs = await f.open();
  assert.deepEqual(await f.read(), repaired);
  await logs.flush();
  assert.equal(logs.pending, 0);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((r) => r.lease === 'private-lease' && r.step.request.card_number === '[REDACTED]'));
  assert.deepEqual(await f.read(), []);
});

test('one rejected receipt is retained without blocking later batches, and is retried after restart', async (t) => {
  let rejected = true;
  const sent: string[] = [];
  const ids = Array.from({ length: 102 }, () => randomUUID());
  const f = await fixture(
    t,
    ids.map((id) => ['run-1:' + id, record(id)]),
    async (r) => {
      if (rejected && r.step.traceId === ids[0])
        throw Object.assign(new Error('bad receipt'), { status: 400 });
      sent.push(r.step.traceId);
    },
  );
  let logs = await f.open();
  await logs.flush();
  assert.equal(logs.pending, 3);
  await logs.flush();
  assert.equal(logs.pending, 1);
  assert.equal(sent.length, 101);
  rejected = false;
  logs = await f.open();
  await logs.flush();
  assert.equal(logs.pending, 0);
  assert.equal(new Set(sent).size, 102);
});

test('network and credential failures retain all receipts and stop the batch for later retry', async (t) => {
  for (const status of [undefined, 401, 502]) {
    let attempts = 0,
      offline = true;
    const f = await fixture(
      t,
      [
        ['a', record(randomUUID())],
        ['b', record(randomUUID())],
      ],
      async () => {
        attempts++;
        if (offline) throw Object.assign(new Error('unavailable'), { status });
      },
    );
    const logs = await f.open();
    await logs.flush();
    assert.equal(attempts, 1);
    assert.equal(logs.pending, 2);
    offline = false;
    await logs.flush();
    assert.equal(logs.pending, 0);
  }
});

test('a completion queued during the start acknowledgement is delivered in the same flush', async (t) => {
  const sent: string[] = [];
  let logs: WorkerLogs;
  const f = await fixture(t, [['run-1:' + valid, record(valid, false)]], async (r) => {
    sent.push(r.step.status);
    if (r.step.status === 'running') await logs.enqueue(r.runId, r.lease, record(valid).step);
  });
  logs = await f.open();
  await logs.flush();
  assert.deepEqual(sent, ['running', 'failed']);
  assert.equal(logs.pending, 0);
});

test('a completed lease uploads in the background while another lease for the same run stays local', async (t) => {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const sent: string[] = [];
  const f = await fixture(t, [], async (r) => {
    assert.equal(r.deferred, true);
    sent.push(r.lease);
    if (r.lease === 'first-lease') {
      started.resolve();
      await resume.promise;
    }
  });
  const logs = await f.open();
  logs.hold('run-1', 'first-lease');
  logs.hold('run-1', 'second-lease');
  logs.enqueueDeferred('run-1', 'first-lease', record(valid).step);
  logs.enqueueDeferred('run-1', 'second-lease', record(randomUUID()).step);
  await logs.flush();
  assert.equal(sent.length, 0);
  assert.equal((await f.read()).length, 2);

  logs.release('run-1', 'first-lease');
  assert.equal(sent.length, 0);
  await started.promise;
  assert.deepEqual(sent, ['first-lease']);
  logs.enqueueDeferred('run-1', 'second-lease', record(randomUUID()).step);
  await logs.persistPending();
  assert.equal((await f.read()).length, 3);
  assert.deepEqual(sent, ['first-lease']);
  resume.resolve();
  await logs.flush();
  assert.deepEqual(sent, ['first-lease']);
  assert.equal(logs.pending, 2);

  logs.release('run-1', 'second-lease');
  await logs.flush();
  assert.deepEqual(sent, ['first-lease', 'second-lease', 'second-lease']);
  assert.equal(logs.pending, 0);
});

test('held receipts survive a restart, retain the stable completion, and retry failed uploads', async (t) => {
  let offline = true;
  let attempts = 0;
  const sent: string[] = [];
  const f = await fixture(t, [], async (r) => {
    attempts++;
    assert.equal(r.deferred, true);
    assert.equal(r.step.traceId, valid);
    if (offline) throw Object.assign(new Error('unavailable'), { status: 503 });
    sent.push(r.step.status);
  });
  let logs = await f.open();
  logs.hold('run-1', 'private-lease');
  logs.enqueueDeferred('run-1', 'private-lease', record(valid, false).step);
  logs.enqueueDeferred('run-1', 'private-lease', record(valid).step);
  logs.enqueueDeferred('run-1', 'private-lease', record(valid, false).step);
  await logs.persistPending();
  assert.equal(attempts, 0);

  logs = await f.open();
  await logs.flush();
  assert.equal(attempts, 1);
  assert.equal(logs.pending, 1);
  offline = false;
  await logs.flush();
  assert.deepEqual(sent, ['failed']);
  assert.equal(logs.pending, 0);
});

test('active log bursts share one background snapshot without starting an upload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, [], async () => { assert.fail('active lease attempted an upload'); });
  const logs = await f.open();
  const persisted = Promise.withResolvers<void>();
  const persist = (logs as any).persist.bind(logs);
  const writes = t.mock.method(logs as any, 'persist', async () => {
    await persist();
    persisted.resolve();
  });
  logs.hold('run-1', 'private-lease');
  for (let index = 0; index < 10; index++)
    logs.enqueueDeferred('run-1', 'private-lease', record(randomUUID()).step);
  assert.equal(writes.mock.callCount(), 0);
  t.mock.timers.tick(1000);
  await persisted.promise;
  assert.equal(writes.mock.callCount(), 1);
  assert.equal((await f.read()).length, 10);
});
