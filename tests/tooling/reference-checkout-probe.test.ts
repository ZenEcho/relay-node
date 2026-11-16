import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function fixture(
  t: TestContext,
  changes: Record<string, unknown> = {},
  privateEnvironment?: { option: '--proxy-file' | '--environment-file'; content: string },
) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-checkout-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'session.json'), JSON.stringify({ account: { id: 'acct_fixture' }, accessToken: 'fixture' }));
  const snapshot = {
    id: 'oaics_fixture',
    account_id: 'acct_fixture',
    processor_entity: 'openai_llc',
    currency: 'php',
    amount_total: 120000,
    status: 'open',
    payment_status: 'unpaid',
    client_secret: 'never-persist-this',
    ...changes,
  };
  await writeFile(join(directory, 'dist/sdk.js'), `
    import {writeFileSync} from 'node:fs';
    const requests = [];
    export const createEnvironment = (country, proxy) => ({country, proxy, deviceId:'fixture', id:'fixture'});
    export function loadCredential(context) {
      const session = JSON.parse(context.credential);
      context.session = session;
      context.accountId = session.account.id;
    }
    export const createReferenceSentinelAuthorizer = () => async () => ({});
    export async function authorizeSentinel(context) {context.sentinel='fixture';}
    export class NativeTransport {
      async initialize(environment) {writeFileSync(${JSON.stringify(join(directory, 'environment.json'))},JSON.stringify(environment));}
      async request(request) {
        requests.push({method:request.method, path:new URL(request.url).pathname, referer:request.headers.referer});
        const path=new URL(request.url).pathname;
        let data;
        if(path.startsWith('/backend-api/accounts/check/')) data={accounts:{fixture:{account:{account_id:'acct_fixture',plan_type:'free'},entitlement:{has_active_subscription:false}}}};
        else if(path.startsWith('/backend-api/checkout_pricing_config/')) data={currency_config:{symbol_code:'PHP'}};
        else if(path==='/backend-api/payments/checkout') data={internal_checkout_session_id:'oaics_fixture',processor_entity:'openai_llc'};
        else if(path==='/backend-api/payments/checkout/openai_llc/oaics_fixture') data={checkout_session:${JSON.stringify(snapshot)}};
        else throw Error('Unexpected request');
        return {status:200,headers:{'content-type':['application/json']},data};
      }
      close() {writeFileSync(${JSON.stringify(join(directory, 'requests.json'))},JSON.stringify(requests));}
    }
  `);
  const args = [
    resolve('scripts/probe-reference-sentinel.mjs'), '--session-file', join(directory, 'session.json'),
    '--bridge', join(directory, 'bridge.js'), '--transport', join(directory, 'transport'),
    '--sdk-root', directory, '--verify-checkout', '--report', join(directory, 'report.json'),
    '--checkout-file', join(directory, 'checkout.json'),
  ];
  if (privateEnvironment) {
    const path = join(directory, 'private-environment');
    await writeFile(path, privateEnvironment.content, { mode: 0o600 });
    args.push(privateEnvironment.option, path);
  }
  let output: string;
  let exitCode = 0;
  try {
    output = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    exitCode = failure.status;
    output = failure.stdout;
  }
  return {
    directory, exitCode, output,
    report: JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')),
    requests: JSON.parse(await readFile(join(directory, 'requests.json'), 'utf8')),
  };
}

test('checkout probe reads the original checkout currency and writes only its private payment link', async (t) => {
  const result = await fixture(t);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.currency, 'PHP');
  assert.equal(result.report.checkoutCurrencyVerified, true);
  assert.equal(result.report.paymentLinkCreated, true);
  assert.equal(result.report.paymentLinkSaved, true);
  assert.equal(result.report.amountMinor, 120000);
  assert.deepEqual(result.requests.map((request: {method:string;path:string}) => [request.method, request.path]), [
    ['GET', '/backend-api/accounts/check/v4-2023-04-27'],
    ['GET', '/backend-api/checkout_pricing_config/configs/PH'],
    ['POST', '/backend-api/payments/checkout'],
    ['GET', '/backend-api/payments/checkout/openai_llc/oaics_fixture'],
  ]);
  assert.equal(result.requests.at(-1).referer, 'https://chatgpt.com/checkout/openai_llc/oaics_fixture');
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'checkout.json'), 'utf8')), {
    checkoutId: 'oaics_fixture',
    checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/oaics_fixture',
    currency: 'PHP',
    amountMinor: 120000,
  });
  assert.equal((await stat(join(result.directory, 'checkout.json'))).mode & 0o777, 0o600);
  assert.ok(!result.output.includes('never-persist-this'));
  assert.ok(!result.output.includes('https://chatgpt.com/checkout/'));
  assert.equal(result.report.cardDataSupplied, false);
  assert.equal(result.report.paymentSubmitted, false);
  assert.equal(result.report.transportClosed, true);
});

test('checkout probe rejects missing or mismatched original-checkout evidence', async (t) => {
  for (const changes of [
    { currency: 'USD' }, { currency: undefined }, { id: 'oaics_other' },
    { account_id: 'acct_other' }, { processor_entity: 'other' },
  ]) {
    const result = await fixture(t, changes);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.failureStage, 'checkout_currency');
    assert.equal(result.report.checkoutCurrencyVerified, undefined);
    assert.equal(result.report.paymentLinkCreated, undefined);
    assert.equal(result.report.transportClosed, true);
    await assert.rejects(readFile(join(result.directory, 'checkout.json')), { code: 'ENOENT' });
  }
});

test('checkout probe reads proxy credentials from private files without printing them', async (t) => {
  for (const environment of [
    { option: '--proxy-file' as const, content: 'http://fixture:private-password@proxy.example:8080' },
    { option: '--environment-file' as const, content: JSON.stringify({ environment: { country: 'ph', proxyUrl: 'http://fixture:private-password@proxy.example:8080' } }) },
  ]) {
    const result = await fixture(t, {}, environment);
    assert.equal(result.exitCode, 0);
    const initialized = JSON.parse(await readFile(join(result.directory, 'environment.json'), 'utf8'));
    assert.equal(initialized.country, 'PH');
    assert.equal(initialized.proxy, 'http://fixture:private-password@proxy.example:8080');
    assert.ok(!result.output.includes('private-password'));
    assert.ok(!JSON.stringify(result.report).includes('private-password'));
  }
});
