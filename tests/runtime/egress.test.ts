import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEgress } from '../../packages/runtime/src/egress.js';

const trace = {
  status: 200,
  data: null,
  body: 'h=chatgpt.com\nip=192.0.2.4\nloc=PH\n',
};

test('a primary transport failure uses the target trace through the supplied transport', async () => {
  const calls: string[] = [];
  const result = await inspectEgress(async (input) => {
    calls.push(input.url);
    if (input.url.includes('ipapi.co'))
      throw Object.assign(new Error('TLS failed'), {
        code: 'UPSTREAM_TLS_FAILED',
      });
    return trace;
  });
  assert.deepEqual(result, { ip: '192.0.2.4', country: 'PH' });
  assert.deepEqual(calls, ['https://ipapi.co/json/', 'https://chatgpt.com/cdn-cgi/trace']);
});

test('an unsuccessful fallback preserves its transport error and never accepts invalid trace data', async () => {
  const failure = Object.assign(new Error('fallback TLS failed'), {
    code: 'UPSTREAM_TLS_FAILED',
  });
  await assert.rejects(
    inspectEgress(async (input) => {
      if (input.url.includes('ipapi.co')) throw new Error('primary failed');
      throw failure;
    }),
    (error) => error === failure,
  );
  const primary = new Error('primary failed');
  await assert.rejects(
    inspectEgress(async (input) => {
      if (input.url.includes('ipapi.co')) throw primary;
      return { ...trace, body: 'h=other.invalid\nip=192.0.2.4\nloc=PH' };
    }),
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
