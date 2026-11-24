import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightExecution, sampleExecutionEgress } from '../../apps/worker/src/execution/preflight.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import { digest } from '../../packages/runtime/src/security.js';
import type { ExecutionServices } from '../../apps/worker/src/execution/services.js';

function fixture(verified = false) {
  const logs: unknown[] = [];
  let requests = 0;
  const context: any = {
    environment: createEnvironment('PH', 'http://private-user:private-password@proxy.invalid:8080'),
    session: {
      accessToken: 'private-access',
      user: { email: 'test@example.invalid' },
    },
    billingEmailBinding: {
      provider: 'chatgpt',
      source: 'session',
      email: 'test@example.invalid',
    },
    originalSubscription: { has_active_subscription: false },
    ...(verified ? { proxyVerified: true, exitIp: '203.0.113.42', exitCountry: 'PH' } : {}),
  };
  const services = {
    context,
    assignment: { mode: 'execute' },
    setStage: (stage: string) => { context.phase = stage; },
    checkpoint: async () => {},
    request: async () => {
      requests++;
      return {
        status: 200,
        data: { ip: '203.0.113.42', country_code: 'PH' },
        body: '',
      };
    },
    log: async (entry: unknown) => {
      logs.push(entry);
    },
    requireSentinel: async () => {},
  } as unknown as ExecutionServices;
  return { context, services, logs, requests: () => requests };
}

test('verified exits get a correlation fingerprint without new raw network or credential fields', async () => {
  const f = fixture();
  await preflightExecution(f.services);
  assert.equal(f.requests(), 1);
  assert.equal(f.context.exitFingerprint, digest('203.0.113.42').slice(0, 12));
  assert.match(f.context.exitProbe.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((f.logs[0] as any).request, {
    environmentId: f.context.environment.id,
    profile: f.context.environment.profile,
    executionMode: 'execute',
    requestedCountry: 'PH',
    networkMode: 'proxy',
  });
  assert.deepEqual((f.logs[0] as any).response, {
    observedAt: f.context.exitProbe.observedAt,
    source: 'ipapi.co',
    simulated: false,
    observed: true,
    exitFingerprint: f.context.exitFingerprint,
    country: 'PH',
    requestedCountry: 'PH',
    verified: true,
    networkMode: 'proxy',
  });
  const serialized = JSON.stringify(f.logs);
  for (const secret of [
    '203.0.113.42',
    'private-user',
    'private-password',
    'private-access',
    'proxy.invalid',
  ])
    assert.equal(serialized.includes(secret), false, secret);
});

for (const actual of ['BR', 'FR']) {
  test(`a Chile order records the ${actual} exit and stops before Sentinel or subscription requests`, async () => {
    const f = fixture();
    f.services.assignment.paymentEnabled = true;
    f.context.environment.country = 'CL';
    f.context.environment.cookies = [
      { name: '__Secure-next-auth.session-token', value: 'fixture-login-session', domain: 'chatgpt.com' },
    ];
    f.services.request = async () => ({
      status: 200,
      headers: {},
      data: { ip: '203.0.113.42', country_code: actual },
      body: '',
    });
    f.services.requireSentinel = async () => assert.fail('must stop before Sentinel');
    f.services.chat = async () => assert.fail('must stop before account or checkout requests');
    await assert.rejects(preflightExecution(f.services), (error: any) => {
      assert.equal(error.code, 'PROXY_COUNTRY_MISMATCH');
      assert.match(error.message, new RegExp(`期望 CL，实际 ${actual}`));
      return true;
    });
    assert.equal(f.context.exitCountry, actual);
    assert.equal(f.context.proxyVerified, false);
    assert.equal((f.logs[0] as any).status, 'failed');
    assert.deepEqual((f.logs[0] as any).response, {
      ...f.context.exitProbe,
      observed: true,
      exitFingerprint: digest('203.0.113.42').slice(0, 12),
      country: actual,
      requestedCountry: 'CL',
      verified: false,
      networkMode: 'proxy',
    });
    assert.equal(JSON.stringify(f.logs).includes('private-password'), false);
  });
}

test('resumed verified exits are sampled even when the fingerprint and proxy stay the same', async () => {
  const f = fixture(true),
    originalProxy = f.context.environment.proxyUrl;
  await preflightExecution(f.services);
  await preflightExecution(f.services);
  assert.equal(f.requests(), 2);
  assert.equal(f.logs.length, 2);
  assert.equal((f.logs[1] as any).response.exitChanged, false);
  assert.equal(f.context.environment.proxyUrl, originalProxy);
});

test('a fresh fallback probe reports a changed exit and failed diagnostics discard stale observations', async () => {
  const f = fixture(true);
  await sampleExecutionEgress(f.services);
  f.services.request = async (_name, input) => ({
    status: input.url.includes('ipapi.co') ? 403 : 200,
    headers: {},
    data: null,
    body: 'h=chatgpt.com\nip=203.0.113.84\nloc=PH\n',
  });
  await sampleExecutionEgress(f.services);
  assert.equal(f.context.exitFingerprint, digest('203.0.113.84').slice(0, 12));
  assert.equal((f.logs[1] as any).response.source, 'chatgpt.com');
  assert.equal((f.logs[1] as any).response.exitChanged, true);
  f.services.request = async () => { throw new Error('diagnostic unavailable'); };
  await sampleExecutionEgress(f.services);
  assert.equal(f.context.exitProbe, undefined);
  assert.equal(f.context.proxyVerified, true);
  assert.equal((f.logs[2] as any).response.observed, false);
  assert.equal((f.logs[2] as any).response.exitFingerprint, undefined);
});
