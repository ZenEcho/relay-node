import test from 'node:test';
import assert from 'node:assert/strict';
import { pollBatch } from '../../apps/worker/src/runtime/poll-batch.js';

test('one polling burst launches all available assignments without waiting for execution', async () => {
  let polls = 0;
  const started: number[] = [];
  await pollBatch(async () => ++polls <= 8 ? polls : null, (assignment) => { started.push(assignment); }, () => true);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(polls, 9);
});
test('polling yields between bursts and stops for pause/shutdown commands', async () => {
  let polls = 0, running = true;
  await pollBatch(async () => ++polls, () => {}, () => true);
  assert.equal(polls, 20);
  await pollBatch(async () => ++polls, () => { running = false; }, () => running);
  assert.equal(polls, 21);
});
