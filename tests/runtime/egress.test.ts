import test from 'node:test';
import assert from 'node:assert/strict';
import { egressProbeUrls, inspectEgress, observeEgress } from '../../packages/runtime/src/egress.js';

const chatgptTrace = {
  status: 200,
  data: null,
  body: 'h=chatgpt.com\nip=192.0.2.4\nloc=PH\n',
};
const cloudflareTrace = {
  status: 200,
  data: null,
  body: 'h=www.cloudflare.com\nip=192.0.2.9\nloc=PH\n',
};

function byHost(handlers: Record<string, () => any>) {
  return async (input: { url: string }) => {
    const host = new URL(input.url).hostname;
    return handlers[host] ? handlers[host]() : handlers.default?.();
  };
}

test('the merchant trace confirms the exit first and needs no second probe', async () => {
  const calls: string[] = [];
  const result = await observeEgress(async (input) => {
    calls.push(input.url);
    return chatgptTrace;
  });
  assert.deepEqual(result, { ip: '192.0.2.4', country: 'PH', source: 'chatgpt.com' });
  assert.deepEqual(calls, [egressProbeUrls.primary]);
});

test('a failed merchant trace falls through to the Cloudflare trace with the same session', async () => {
  const calls: string[] = [];
  const result = await observeEgress(
    byHost({
      'chatgpt.com': () => {
        calls.push('chatgpt');
        throw Object.assign(new Error('TLS failed'), { code: 'UPSTREAM_TLS_FAILED' });
      },
      'www.cloudflare.com': () => {
        calls.push('cloudflare');
        return cloudflareTrace;
      },
    }) as any,
  );
  assert.deepEqual(result, { ip: '192.0.2.9', country: 'PH', source: 'cloudflare.com' });
  assert.deepEqual(calls, ['chatgpt', 'cloudflare']);
  assert.equal(egressProbeUrls.fallback, 'https://www.cloudflare.com/cdn-cgi/trace');
});

test('an unsuccessful fallback preserves its transport error and never accepts invalid trace data', async () => {
  const failure = Object.assign(new Error('fallback TLS failed'), {
    code: 'UPSTREAM_TLS_FAILED',
  });
  await assert.rejects(
    inspectEgress(
      byHost({
        'chatgpt.com': () => {
          throw new Error('primary failed');
        },
        'www.cloudflare.com': () => {
          throw failure;
        },
      }) as any,
    ),
    (error) => error === failure,
  );
  const primary = new Error('primary failed');
  await assert.rejects(
    inspectEgress(
      byHost({
        'chatgpt.com': () => {
          throw primary;
        },
        'www.cloudflare.com': () => ({
          ...cloudflareTrace,
          body: 'h=other.invalid\nip=192.0.2.4\nloc=PH',
        }),
      }) as any,
    ),
    (error: any) => error.code === 'EGRESS_UNAVAILABLE' && error.cause === primary,
  );
});

test('cancellation and intentionally closed transports do not start a fallback request', async () => {
  for (const failure of [
    Object.assign(new Error('cancelled'), { code: 'EXECUTION_ABORTED' }),
    Object.assign(new Error('closed'), { code: 'TRANSPORT_CLOSED' }),
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ]) {
    let calls = 0;
    await assert.rejects(
      inspectEgress(async () => {
        calls++;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  }
});

test('the two probes run beside each other and the first valid answer wins', async () => {
  const started: string[] = [];
  const slowPrimary = new Promise((resolve) => setTimeout(() => resolve(chatgptTrace), 120));
  const result = await observeEgress(
    (input) => {
      started.push(new URL(input.url).hostname);
      return slowPrimary as any;
    },
    (input) => {
      started.push(new URL(input.url).hostname);
      return Promise.resolve(cloudflareTrace);
    },
  );
  assert.deepEqual(result, { ip: '192.0.2.9', country: 'PH', source: 'cloudflare.com' });
  assert.deepEqual(started.sort(), ['chatgpt.com', 'www.cloudflare.com']);
});

test('both probes failing reports one retryable egress failure', async () => {
  const primary = Object.assign(new Error('primary timeout'), { code: 'UPSTREAM_TIMEOUT' });
  await assert.rejects(
    observeEgress(
      async () => {
        throw primary;
      },
      async () => {
        throw new Error('secondary timeout');
      },
    ),
    (error: any) => error.code === 'EGRESS_UNAVAILABLE' && error.cause === primary,
  );
});

test('a fatal state in either probe stops the pair immediately', async () => {
  const aborted = Object.assign(new Error('cancelled'), { code: 'EXECUTION_ABORTED' });
  await assert.rejects(
    observeEgress(
      async () => {
        throw aborted;
      },
      () => new Promise(() => {}),
    ),
    (error) => error === aborted,
  );
});
