import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { OnDemandSdkRuntime } from '../../apps/worker/src/browser/runtime.js';
import { createEnvironment } from '../../packages/runtime/src/environment.js';

for (const accountMatches of [true, false]) {
  test(
    'first-party session navigation ' +
      (accountMatches
        ? 'permits a single SDK retry after matching the account'
        : 'rejects another account without retrying SDK issuance'),
    async () => {
      const runtime: any = new OnDemandSdkRuntime({
        context: { environment: createEnvironment('PH', '') },
      } as any);
      runtime.open = async () => {};
      runtime.cookieImportVerified = true;
      runtime.session = 'page';
      let calls = 0,
        path = '/',
        text = '';
      const navigations: string[] = [];
      runtime.cdp = {
        send: async (method: string, params: any) => {
          if (method === 'Page.navigate') {
            navigations.push(params.url);
            path = new URL(params.url).pathname;
            runtime.documentResponse = { url: params.url, status: 200 };
            text = JSON.stringify({
              account: { id: accountMatches ? 'original' : 'other' },
            });
          }
          return method === 'Network.getCookies' ? { cookies: [] } : {};
        },
        evaluate: async (expression: string) => {
          if (expression.includes('function authorizeSentinelInPage(')) {
            calls++;
            return calls === 1
              ? { failureReason: 'SESSION_HTTP' }
              : { accountId: 'original', token: 'fixture-official-sdk-result' };
          }
          if (expression.includes('const r=await fetch'))
            return { sessionStatus: 403, jsonResponse: false };
          return runInNewContext(expression, {
            location: { origin: 'https://chatgpt.com', pathname: path },
            document: {
              readyState: 'complete',
              querySelector: () => ({ textContent: text }),
              body: { textContent: text },
            },
          });
        },
        close() {},
      };
      try {
        const action = runtime.authorize({ accountId: 'original' });
        if (accountMatches) assert.equal((await action).accountId, 'original');
        else await assert.rejects(action, (e: any) => e.code === 'OFFICIAL_SDK_AUTH_REQUIRED');
        assert.equal(calls, accountMatches ? 2 : 1);
        assert.deepEqual(navigations, [
          'https://chatgpt.com/api/auth/session',
          'https://chatgpt.com/',
        ]);
      } finally {
        await runtime.close();
      }
    },
  );
}
