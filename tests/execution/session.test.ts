import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCredential } from '../../apps/worker/src/execution/credentials.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';
import type { RuntimeContext } from '../../packages/contracts/src/execution.js';

function load(value: any): RuntimeContext {
  const context = {
    environment: createEnvironment('PH', ''),
    credential: JSON.stringify(value),
  };
  loadCredential(context);
  return context;
}

test('Cookie export and Session JSON do not mix different login-token generations or overwrite the original device', () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const context = load({
    accessToken: 'test-access',
    sessionToken: 'other-token-generation',
    account: { id: 'test-account' },
    cookies: [
      {
        name: '__Secure-next-auth.session-token.1',
        value: 'part-one',
        domain: '.chatgpt.com',
      },
      {
        name: '__Secure-next-auth.session-token.0',
        value: 'part-zero',
        domain: '.chatgpt.com',
      },
      {
        name: 'oai-did',
        value: 'original-browser-device',
        domain: '.chatgpt.com',
        expirationDate: expires + 0.4,
      },
    ],
  });
  assert.equal(context.environment.deviceId, 'original-browser-device');
  assert.equal(context.environment.cookies.filter((c) => c.name === 'oai-did').length, 1);
  assert.equal(context.environment.cookies.find((c) => c.name === 'oai-did')?.expires, expires);
  assert.equal(context.environment.cookies.filter((c) => /session-token/.test(c.name)).length, 2);
  assert.ok(!JSON.stringify(context.environment.cookies).includes('other-token-generation'));
  assert.equal(context.session?.accessToken, 'test-access');
});

test('Session-only credentials still create complete cookie fragments and one device cookie', () => {
  const token = 'x'.repeat(8000);
  const context = load({ accessToken: 'test-access', sessionToken: token });
  const fragments = context.environment.cookies.filter((c) =>
    c.name.startsWith('__Secure-next-auth.session-token.'),
  );
  assert.equal(fragments.length, 3);
  assert.equal(fragments.map((c) => c.value).join(''), token);
  assert.equal(context.environment.cookies.filter((c) => /session-token/.test(c.name)).length, 3);
  assert.ok(fragments.every((c) => c.httpOnly === true && c.sameSite === 'lax'));
  assert.equal(context.environment.cookies.filter((c) => c.name === 'oai-did').length, 1);
});

test('a short Session token creates one secure login cookie without an invented authjs family', () => {
  const context = load({ sessionToken: 'one-session-token' });
  const login = context.environment.cookies.filter((c) => /session-token/.test(c.name));
  assert.deepEqual(
    login.map((c) => c.name),
    ['__Secure-next-auth.session-token'],
  );
  assert.equal(login[0].value, 'one-session-token');
  assert.equal(login[0].httpOnly, true);
  assert.equal(login[0].sameSite, 'lax');
});

test('an explicitly exported authjs cookie family remains authoritative', () => {
  const context = load({
    sessionToken: 'other-generation',
    cookies: [
      {
        name: '__Secure-authjs.session-token.1',
        value: 'one',
        domain: '.chatgpt.com',
      },
      {
        name: '__Secure-authjs.session-token.0',
        value: 'zero',
        domain: '.chatgpt.com',
      },
    ],
  });
  assert.deepEqual(
    context.environment.cookies.filter((c) => /session-token/.test(c.name)).map((c) => c.name),
    ['__Secure-authjs.session-token.1', '__Secure-authjs.session-token.0'],
  );
  assert.ok(!context.environment.cookies.some((c) => c.value === 'other-generation'));
});

test('Cookie-only credentials retain their actual device and filter unrelated domains', () => {
  const context = load([
    {
      name: 'oai-did',
      value: 'original-browser-device',
      domain: 'chatgpt.com',
    },
    {
      name: '__Secure-next-auth.session-token',
      value: 'cookie-session',
      domain: '.chatgpt.com',
    },
    { name: 'unrelated', value: 'omit', domain: 'other.example' },
  ]);
  assert.equal(context.environment.deviceId, 'original-browser-device');
  assert.equal(context.environment.cookies.length, 2);
});

test('Session-only exports preserve the original browser device for official SDK binding', () => {
  const context = load({
    accessToken: 'test-access',
    sessionToken: 'test-session',
    statsigContext: { deviceId: 'original-browser-device' },
  });
  assert.equal(context.environment.deviceId, 'original-browser-device');
  assert.equal(
    context.environment.cookies.find((c) => c.name === 'oai-did')?.value,
    'original-browser-device',
  );
  assert.throws(() => load({ statsigContext: { deviceId: 'bad\r\ndevice' } }), /设备标识无效/);
  const explicit = load({
    statsigContext: { deviceId: 'older-export-device' },
    cookies: [
      {
        name: 'oai-did',
        value: 'current-cookie-device',
        domain: 'chatgpt.com',
      },
    ],
  });
  assert.equal(explicit.environment.deviceId, 'current-cookie-device');
});

for (const names of [
  ['__Secure-next-auth.session-token.1'],
  ['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.2'],
  ['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.0'],
  ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'],
]) {
  test(`incomplete or conflicting Session cookies stop before transport initialization (${names.join(', ')})`, () => {
    const context: RuntimeContext = {
      environment: createEnvironment('PH', ''),
      credential: JSON.stringify({
        sessionToken: 'different-generation',
        cookies: names.map((name) => ({
          name,
          value: 'test-cookie',
          domain: 'chatgpt.com',
        })),
      }),
    };
    assert.throws(() => loadCredential(context), /分片不完整|格式冲突/);
    assert.equal(context.session, undefined);
    assert.throws(() => loadCredential(context), /分片不完整|格式冲突/);
  });
}

test('ambiguous device cookies stop instead of choosing another browser identity', () => {
  assert.throws(
    () =>
      load([
        { name: 'oai-did', value: 'device-one', domain: 'chatgpt.com' },
        { name: 'oai-did', value: 'device-two', domain: '.chatgpt.com' },
      ]),
    /冲突的设备标识/,
  );
});
