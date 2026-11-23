import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
// Verify serialization of the shipped SDK artifact, without tsx's test-only
// function-name helpers being injected into the page action's source.
import {
  authorizeSentinelInPage,
  createBrowserSentinelAuthorizer,
} from '../../dist/apps/worker/src/browser/actions.js';
import type { SentinelRequest } from '../../packages/contracts/src/sentinel.js';

function fixture() {
  const request: SentinelRequest = {
    flow: 'checkout_session_approval',
    observerFlow: 'chatgpt_checkout',
    pageUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_test',
    deviceId: 'test-device',
    environmentId: 'test-environment',
    accountId: 'test-account',
  };
  const calls: string[] = [];
  let reads = 0;
  const page: any = {
    location: new URL(request.pageUrl),
    document: { cookie: 'oai-did=test-device' },
    fetch: async (path: string, options: any) => {
      calls.push('session');
      reads++;
      assert.equal(path, '/api/auth/session');
      assert.equal(options.credentials, 'include');
      return {
        ok: true,
        json: async () => ({
          accessToken: 'test-access',
          account: { id: 'test-account' },
          user: { id: 'test-user' },
        }),
      };
    },
    SentinelSDK: {
      init: async (flow: string) => {
        calls.push('init:' + flow);
      },
      sessionObserverToken: async (flow: string) => {
        calls.push('observer:' + flow);
        return 'opaque-observer-from-sdk';
      },
      token: async (flow: string) => {
        calls.push('token:' + flow);
        return 'opaque-main-from-sdk';
      },
    },
  };
  const execute = (reportFailure = false) =>
    runInNewContext('(' + authorizeSentinelInPage.toString() + ')(request, reportFailure)', {
      request,
      reportFailure,
      window: page,
      URL,
      setTimeout,
      clearTimeout,
    });
  return { request, page, calls, execute, reads: () => reads };
}

test('real-page adapter calls official SDK methods in order and preserves the returned headers', async () => {
  const f = fixture();
  const result = await f.execute();
  assert.deepEqual(f.calls, [
    'session',
    'token:checkout_session_approval',
    'observer:chatgpt_checkout',
    'session',
  ]);
  assert.equal(result.token, 'opaque-main-from-sdk');
  assert.equal(result.soToken, 'opaque-observer-from-sdk');
  assert.equal(result.environmentId, f.request.environmentId);
  assert.ok(Date.parse(result.expiresAt) > Date.parse(result.issuedAt));
});

test('token authorization does not depend on the optional SDK prefetch API', async () => {
  const f = fixture();
  f.page.SentinelSDK.init = async () => {
    throw new Error('optional prefetch must not be called');
  };
  assert.equal((await f.execute()).token, 'opaque-main-from-sdk');
  delete f.page.SentinelSDK.init;
  assert.equal((await f.execute()).token, 'opaque-main-from-sdk');
  assert.ok(!f.calls.some((name) => name.startsWith('init:')));
});

for (const state of [
  'wrong origin',
  'wrong page',
  'wrong account',
  'wrong device',
  'missing SDK',
]) {
  test(`real-page adapter rejects ${state} before invoking the SDK`, async () => {
    const f = fixture();
    if (state === 'wrong origin')
      f.page.location = new URL('https://other.example/checkout/openai_llc/oaics_test');
    if (state === 'wrong page')
      f.page.location = new URL('https://chatgpt.com/checkout/openai_llc/oaics_other');
    if (state === 'wrong account')
      f.page.fetch = async () => ({
        ok: true,
        json: async () => ({ accessToken: 'other', account: { id: 'other-account' } }),
      });
    if (state === 'wrong device') f.page.document.cookie = 'oai-did=other-device';
    if (state === 'missing SDK') delete f.page.SentinelSDK;
    await assert.rejects(f.execute(), (error: any) => error.code === 'SENTINEL_AUTH_REQUIRED');
    assert.ok(!f.calls.some((name) => name.startsWith('init:') || name.startsWith('token:')));
  });
}

test('real-page adapter discards results when identity changes during SDK authorization', async () => {
  const f = fixture();
  const token = f.page.SentinelSDK.token;
  f.page.SentinelSDK.token = async (flow: string) => {
    const result = await token(flow);
    f.page.fetch = async () => ({
      ok: true,
      json: async () => ({ accessToken: 'other', account: { id: 'other-account' } }),
    });
    return result;
  };
  await assert.rejects(f.execute(), (error: any) => error.code === 'SENTINEL_AUTH_REQUIRED');
});

test('SDK verification errors stop with a safe stage code without generating replacement credentials', async () => {
  const f = fixture();
  f.page.SentinelSDK.token = async () => {
    throw new Error('verification required');
  };
  await assert.rejects(f.execute(), /RELAY_SENTINEL_SDK_TOKEN/);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.execute(true))), {
    failureReason: 'SDK_TOKEN',
  });
});

for (const phase of ['before', 'after']) {
  test(`session HTTP diagnostics distinguish ${phase} SDK preparation without returning credentials`, async () => {
    const f = fixture();
    if (phase === 'before') f.page.fetch = async () => ({ ok: false, status: 403 });
    else {
      const token = f.page.SentinelSDK.token;
      f.page.SentinelSDK.token = async (flow: string) => {
        const result = await token(flow);
        f.page.fetch = async () => ({ ok: false, status: 403 });
        return result;
      };
    }
    assert.deepEqual(JSON.parse(JSON.stringify(await f.execute(true))), {
      failureReason: 'SESSION_HTTP',
      sessionCheckPhase: phase,
    });
    assert.equal(
      f.calls.some((call) => call.startsWith('token:')),
      phase === 'after',
    );
  });
}

test('a missing SDK is loaded from the official same-origin endpoint before normal authorization', async () => {
  const f = fixture();
  const sdk = f.page.SentinelSDK;
  delete f.page.SentinelSDK;
  let script: any;
  let removed = false;
  f.page.document.createElement = (tag: string) => {
    assert.equal(tag, 'script');
    return (script = {
      remove() {
        removed = true;
      },
    });
  };
  f.page.document.head = {
    appendChild(value: any) {
      assert.equal(value.src, 'https://chatgpt.com/backend-api/sentinel/sdk.js?no_universal_links=1');
      value.onload();
      setTimeout(() => {
        f.page.SentinelSDK = sdk;
      }, 5);
    },
  };
  assert.equal((await f.execute()).token, 'opaque-main-from-sdk');
  assert.equal(removed, true);
  assert.equal(script.onload, null);
});

test('an absent optional observer is allowed, but malformed headers are rejected', async () => {
  const f = fixture();
  f.page.SentinelSDK.sessionObserverToken = async () => null;
  const result = await f.execute();
  assert.equal(result.soToken, undefined);
  f.page.SentinelSDK.token = async () => 'invalid\r\nheader';
  await assert.rejects(f.execute(), (error: any) => error.code === 'SENTINEL_AUTH_REQUIRED');
});

test('SDK authorization has a bounded wait and never proceeds after a timeout', async () => {
  const f = fixture();
  f.page.SentinelSDK.token = async () => new Promise(() => {});
  const result = runInNewContext('(' + authorizeSentinelInPage.toString() + ')(request)', {
    request: f.request,
    window: f.page,
    URL,
    clearTimeout,
    setTimeout: (callback: () => void, timeout: number) => {
      assert.ok([15000, 45000].includes(timeout));
      return setTimeout(callback, 5);
    },
  });
  await assert.rejects(
    result,
    (error: any) => error.code === 'SENTINEL_AUTH_REQUIRED' && /超时/.test(error.message),
  );
  assert.equal(f.reads(), 1, 'no post-authorization action may proceed');
});

test('the authorizer passes the self-contained action to the existing authenticated runtime executor', async () => {
  const f = fixture();
  const authorize = createBrowserSentinelAuthorizer(async (action, request) => {
    assert.equal(action, authorizeSentinelInPage);
    assert.equal(request, f.request);
    return f.execute();
  });
  assert.equal((await authorize(f.request)).token, 'opaque-main-from-sdk');
});
