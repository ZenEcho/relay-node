import test from 'node:test';
import assert from 'node:assert/strict';
import { issueStripeDevice } from '../../apps/worker/src/execution/stripe-device.js';

const ISSUED = {
  muid: '9a1e85d3-07b3-457e-9b94-a363e3b27e52290126',
  guid: 'c122f4d9-c690-450e-a8bd-fa05a5f4c4563ab497',
  sid: 'ebbd1f45-1735-4d9c-a2d7-83c400a7c5b3aa408d',
};

function fixture(overrides: Record<string, any> = {}) {
  const logs: any[] = [];
  const requests: any[] = [];
  const context: any = {};
  const services = {
    context,
    assignment: { demo: false },
    log: async (event: any) => {
      logs.push(event);
    },
    request: async (name: string, input: any) => {
      requests.push({ name, input });
      return { status: 200, headers: {}, body: JSON.stringify(ISSUED), data: ISSUED };
    },
    ...overrides,
  };
  return { services: services as any, context, logs, requests };
}

test('the device identity comes from m.stripe.com and is kept on the context', async () => {
  const f = fixture();
  const device = await issueStripeDevice(f.services);
  assert.deepEqual(device, ISSUED);
  assert.deepEqual(f.context.stripeDevice, ISSUED);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].name, '取得 Stripe 设备标识');
  assert.equal(f.requests[0].input.url, 'https://m.stripe.com/6');
  assert.equal(f.requests[0].input.method, 'POST');
  assert.equal(f.requests[0].input.body, '{}');
  assert.equal(f.logs.at(-1).status, 'succeeded');
});

test('a registered device is never reissued for the same context', async () => {
  const f = fixture();
  await issueStripeDevice(f.services);
  const again = await issueStripeDevice(f.services);
  assert.deepEqual(again, ISSUED);
  assert.equal(f.requests.length, 1);
});

test('demo executions never call the upstream', async () => {
  const f = fixture({ assignment: { demo: true } });
  const device = await issueStripeDevice(f.services);
  assert.equal(device, undefined);
  assert.equal(f.requests.length, 0);
  assert.equal(f.context.stripeDevice, undefined);
});

test('an unusable payload is audited and leaves the fallback identity in place', async () => {
  const f = fixture({
    request: async () => ({ status: 200, headers: {}, body: '{}', data: { muid: 'short' } }),
  });
  const device = await issueStripeDevice(f.services);
  assert.equal(device, undefined);
  assert.equal(f.context.stripeDevice, undefined);
  assert.equal(f.logs.at(-1).status, 'failed');
  assert.match(f.logs.at(-1).error, /未返回有效的设备标识/);
});

test('a transport failure never blocks the payment path', async () => {
  const f = fixture({
    request: async () => {
      throw new Error('upstream transport failed');
    },
  });
  const device = await issueStripeDevice(f.services);
  assert.equal(device, undefined);
  assert.equal(f.context.stripeDevice, undefined);
  assert.equal(f.logs.at(-1).status, 'failed');
  assert.match(f.logs.at(-1).error, /未能向 m\.stripe\.com 登记/);
});
