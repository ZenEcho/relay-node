import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('Stripe device identifiers are canonical UUIDs, not stripped hex', () => {
  for (let i = 0; i < 20; i++) {
    const environment = createEnvironment('PH', 'http://user:pass@127.0.0.1:8080');
    for (const [name, id] of Object.entries(environment.stripeIds)) assert.match(id, UUID, name);
    assert.notEqual(environment.stripeIds.guid, environment.stripeIds.muid);
    assert.notEqual(environment.stripeIds.muid, environment.stripeIds.sid);
  }
});

test('a rebuilt environment never reuses the previous device identity', () => {
  const first = createEnvironment('PH', '');
  const second = createEnvironment('PH', '');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.deviceId, second.deviceId);
  assert.notDeepEqual(first.stripeIds, second.stripeIds);
});
