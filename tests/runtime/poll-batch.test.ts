import test from 'node:test';
import assert from 'node:assert/strict';
import { pollBatch } from '../../apps/worker/src/runtime/poll-batch.js';

test('one polling burst launches all available assignments without waiting for execution', async () => {
  let polls = 0;
  const started: number[] = [];
  await pollBatch(async () => ++polls <= 8 ? polls : null, (assignment) => { started.push(assignment); }, () => true);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(polls >= 9 && polls <= 11, 'only outstanding polls can return after the first empty response');
});
test('polling yields between bursts and stops for pause/shutdown commands', async () => {
  let polls = 0, running = true;
  await pollBatch(async () => ++polls, () => {}, () => true);
  assert.equal(polls, 20);
  await pollBatch(async () => ++polls, () => { running = false; }, () => running);
  assert.equal(polls, 23);
});

test('slow and failed polls leave other issued assignments available to launch', { timeout: 3000 }, async (t) => {
  let releaseSlow!: (assignment: number) => void;
  const slow = new Promise<number>((resolve) => { releaseSlow = resolve; });
  t.after(() => releaseSlow(1));
  let launchFast!: () => void;
  const fast = new Promise<void>((resolve) => { launchFast = resolve; });
  const started: number[] = [];
  const failure = new Error('poll failed');
  let polls = 0;
  const burst = pollBatch(async () => {
    const poll = ++polls;
    if (poll === 1) return slow;
    if (poll === 3) throw failure;
    return poll;
  }, (assignment) => {
    started.push(assignment);
    if (assignment === 2) launchFast();
  }, () => true);
  const rejected = assert.rejects(burst, failure);
  await fast;
  assert.ok(started.includes(2));
  assert.ok(!started.includes(1));
  releaseSlow(1);
  await rejected;
  assert.ok(started.includes(1), 'an issued lease is launched before the poll error is reported');
  assert.ok(polls <= 4, 'polling stops when the request error is observed');
});
