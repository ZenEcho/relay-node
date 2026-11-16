import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemMonitor, parseLinuxNetwork } from '../../packages/runtime/src/system-metrics.js';

test('network counters ignore loopback and virtual bridge traffic', () => {
  const counters = parseLinuxNetwork(`Inter-| Receive | Transmit
 eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0
 lo: 9999 0 0 0 0 0 0 0 9999 0
 veth123: 9999 0 0 0 0 0 0 0 9999 0
 br-123: 9999 0 0 0 0 0 0 0 9999 0
 eth1: 500 0 0 0 0 0 0 0 700 0`);
  assert.deepEqual(counters, { received: 1500, sent: 2700 });
});
test('system sampling returns actual resource sizes and coalesces concurrent reads', async () => {
  const monitor = new SystemMonitor();
  const [first, second] = await Promise.all([monitor.sample(), monitor.sample()]);
  assert.equal(first, second);
  assert.ok(first.cpu.cores > 0);
  assert.ok(first.memory.total > 0 && first.memory.used >= 0 && first.memory.available <= first.memory.total);
  assert.ok(first.disk && first.disk.total > 0 && first.disk.used >= 0);
  assert.equal(first.network, null, 'a rate requires two counter samples');
});
test('a missing disk path leaves other measurements available', async () => {
  const sample = await new SystemMonitor('/nonexistent-relay-metrics-path').sample();
  assert.equal(sample.disk, null);
  assert.ok(sample.memory.total > 0);
});
