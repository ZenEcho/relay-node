import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const sessionFile = option('--session-file');
const bridgePath = option('--bridge');
const binary = option('--transport');
if (!sessionFile || !bridgePath || !binary)
  throw new Error(
    '需要 --session-file、--bridge 和 --transport；默认只签发 Sentinel，--verify-checkout 额外创建一个未付款结账，不接收卡片或提交付款',
  );
const sdkBase = option('--sdk-root')
  ? pathToFileURL(resolve(option('--sdk-root')) + sep)
  : new URL('..', import.meta.url);
const {
  createEnvironment,
  loadCredential,
  authorizeSentinel,
  createReferenceSentinelAuthorizer,
  NativeTransport,
} = await import(new URL('dist/sdk.js', sdkBase));
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
const cookies = option('--cookie-file')
  ? JSON.parse(await readFile(option('--cookie-file'), 'utf8'))
  : session.cookies || [];
const context = {
  environment: createEnvironment(option('--country') || 'PH', option('--proxy') || ''),
  credential: JSON.stringify({ ...session, cookies }),
};
loadCredential(context);
const transport = new NativeTransport(binary);
const authorize = createReferenceSentinelAuthorizer(context, {
  bridgePath: resolve(bridgePath),
  ...(option('--version') ? { version: option('--version') } : {}),
});
const report = {
  checkedAt: new Date().toISOString(),
  mode: 'reference_sentinel',
  implementation: option('--sdk-root') ? 'installed_node' : 'development_build',
  sentinelIssued: false,
  checkoutCreated: false,
  merchantAccepted: false,
  cardDataSupplied: false,
  paymentSubmitted: false,
  browserStarted: false,
  flowResults: {},
};
const headers = (path, sentinel = false) => ({
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: 'Bearer ' + context.session.accessToken,
  'chatgpt-account-id': context.accountId,
  'oai-device-id': context.environment.deviceId,
  'oai-did': context.environment.deviceId,
  'oai-session-id': context.environment.id,
  'oai-language': 'en-US',
  origin: 'https://chatgpt.com',
  referer: 'https://chatgpt.com/',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  'x-openai-target-path': path.split('?')[0],
  'x-openai-target-route': path.startsWith('/backend-api/accounts/check/')
    ? '/backend-api/accounts/check/{version}'
    : path.startsWith('/backend-api/checkout_pricing_config/configs/')
      ? '/backend-api/checkout_pricing_config/configs/{country_code}'
      : path.split('?')[0],
  ...(context.metadata?.attestation
    ? { 'oai-web-deployment-attestation': context.metadata.attestation }
    : {}),
  ...(context.metadata?.version ? { 'oai-client-version': context.metadata.version } : {}),
  ...(context.metadata?.build ? { 'oai-client-build-number': context.metadata.build } : {}),
  ...(sentinel
    ? {
        'openai-sentinel-token': context.sentinel,
        ...(context.sentinelSo ? { 'openai-sentinel-so-token': context.sentinelSo } : {}),
      }
    : {}),
});
const get = (path) =>
  transport.request({
    method: 'GET',
    url: 'https://chatgpt.com' + path,
    headers: headers(path),
  });
const fail = (stage) => {
  throw Object.assign(new Error('预检未通过'), { stage });
};
try {
  await transport.initialize(context.environment);
  const accountResponse = await get('/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480');
  const account = Object.values(accountResponse.data?.accounts || {}).find(
    (a) => (a.account?.account_id || a.account?.id) === context.accountId,
  );
  report.bearerAccountCheck = {
    httpStatus: accountResponse.status,
    originalAccountMatches: !!account,
    ...(account
      ? {
          planType: account.account?.plan_type,
          subscriptionActive: account.entitlement?.has_active_subscription,
        }
      : {}),
  };
  if (accountResponse.status !== 200 || !account) fail('account_check');
  if (process.argv.includes('--reference-warmup')) {
    const homeHeaders = {
      ...headers('/'),
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'upgrade-insecure-requests': '1',
    };
    delete homeHeaders['content-type'];
    const home = await transport.request({
      method: 'GET',
      url: 'https://chatgpt.com/',
      headers: homeHeaders,
    });
    context.metadata = {
      version: home.body.match(/prod-[0-9a-f]{40}/)?.[0] || home.body.match(/data-build="([^"]+)"/)?.[1],
      build:
        home.body.match(/data-seq="([^"]+)"/)?.[1] || home.body.match(/"buildNumber"\s*:\s*"?(\d+)"?/)?.[1],
      attestation: home.body.match(/"webDeploymentAttestation"\s*:\s*"([^"]+)"/)?.[1],
    };
    report.warmup = {
      httpStatus: home.status,
      build: !!context.metadata.build,
      version: !!context.metadata.version,
      attestation: !!context.metadata.attestation,
    };
  }
  for (const flow of ['chatgpt_checkout', 'checkout_session_approval']) {
    report.currentFlow = flow;
    console.log(JSON.stringify({ event: 'sentinel_flow_started', flow }));
    await authorizeSentinel(context, flow, 'https://chatgpt.com/', authorize);
    report.flowResults[flow] = { sentinelIssued: !!context.sentinel, observerIssued: !!context.sentinelSo };
  }
  report.sentinelIssued = Object.values(report.flowResults).every((value) => value.sentinelIssued);
  if (process.argv.includes('--verify-checkout')) {
    if (account.entitlement?.has_active_subscription !== false) fail('subscription_not_free');
    const country = context.environment.country;
    const pricing = await get('/backend-api/checkout_pricing_config/configs/' + country);
    const currency = pricing.data?.currency_config?.symbol_code;
    if (pricing.status !== 200 || !currency) fail('pricing');
    await authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', authorize);
    const path = '/backend-api/payments/checkout';
    const response = await transport.request({
      method: 'POST',
      url: 'https://chatgpt.com' + path,
      headers: headers(path, true),
      body: JSON.stringify({
        plan_name: 'chatgptplusplan',
        billing_details: { country, currency },
        entry_point: 'all_plans_pricing_modal',
        checkout_ui_mode: 'custom',
        processor_entity: 'openai_llc',
        ...(process.argv.includes('--reference-warmup')
          ? {
              checkout_source: 'chatgpt_web_merged',
              supports_saved_payment_link: true,
              checkout_appearance: 'light',
              cancel_url: 'https://chatgpt.com/?cta_tab=personal',
              purchase_attempt_id: randomUUID(),
            }
          : {}),
      }),
    });
    const value = response.data;
    const id =
      value?.internal_checkout_session_id ||
      value?.internalCheckoutSessionId ||
      value?.checkout_session?.id ||
      value?.checkout_session_id;
    report.checkoutHttpStatus = response.status;
    const header = (name) =>
      Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1]?.[0];
    report.checkoutDiagnostic = {
      jsonResponse: !!value,
      cloudflareChallenge: header('cf-mitigated') === 'challenge',
      contentType: header('content-type')?.split(';')[0],
      ...(typeof value?.error?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.error.code)
        ? { errorCode: value.error.code }
        : {}),
      ...(typeof value?.detail === 'string' && /^[a-zA-Z][a-zA-Z .,:;!?()-]{0,250}$/.test(value.detail)
        ? { detail: value.detail }
        : {}),
      ...(typeof value?.error?.message === 'string' &&
      /^[a-zA-Z][a-zA-Z .,:;!?()-]{0,250}$/.test(value.error.message)
        ? { message: value.error.message }
        : {}),
    };
    report.checkoutCreated = response.status === 200 && /^(oaics_|cs_)[a-zA-Z0-9_]+$/.test(id || '');
    report.merchantAccepted = report.checkoutCreated;
    // An unpaid checkout ID is safe evidence; never save its client secrets or
    // the response body, and never continue into taxes, card access or confirm.
    if (report.checkoutCreated) report.checkoutId = id;
    else fail('merchant_checkout');
  }
} catch (error) {
  report.errorCode =
    typeof error?.code === 'string' && /^[A-Z_]{3,60}$/.test(error.code) ? error.code : 'PROBE_FAILED';
  report.failureStage =
    error?.stage || (report.sentinelIssued ? 'checkout_verification' : 'sentinel_authorization');
  process.exitCode = 1;
} finally {
  transport.close();
  report.transportClosed = true;
  if (option('--report'))
    await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
