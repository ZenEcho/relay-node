import { readFile, stat, writeFile } from 'node:fs/promises';
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
const environmentFile = option('--environment-file') || option('--proxy-file');
if (option('--environment-file') && option('--proxy-file'))
  throw new Error('仅指定一个 --environment-file 或 --proxy-file');
let privateEnvironment = {};
if (environmentFile) {
  const info = await stat(environmentFile);
  if (!info.isFile() || (process.platform !== 'win32' && info.mode & 0o077))
    throw new Error('环境配置必须是仅当前用户可读的私有文件（0600）');
  const content = (await readFile(environmentFile, 'utf8')).trim();
  if (content.startsWith('{')) {
    try {
      const value = JSON.parse(content);
      privateEnvironment = value.environment || value;
    } catch {
      throw new Error('环境配置文件不是可识别的 JSON');
    }
  } else if (option('--proxy-file')) privateEnvironment = { proxyUrl: content };
  else throw new Error('--environment-file 需要 JSON 配置');
  if (
    !privateEnvironment ||
    typeof privateEnvironment !== 'object' ||
    (privateEnvironment.proxyUrl !== undefined && typeof privateEnvironment.proxyUrl !== 'string') ||
    (privateEnvironment.country !== undefined && !/^[a-z]{2}$/i.test(privateEnvironment.country))
  )
    throw new Error('环境配置需要有效的 proxyUrl 和两位国家代码');
}
const context = {
  environment: createEnvironment(
    (option('--country') || privateEnvironment.country || 'PH').toUpperCase(),
    privateEnvironment.proxyUrl ?? option('--proxy') ?? '',
  ),
  credential: JSON.stringify({ ...session, cookies }),
};
loadCredential(context);
const transportAttempts = new Map();
const transport = new NativeTransport(binary, {
  onAttempt(attempt) {
    if (attempt.outcome !== 'running') {
      transportAttempts.set(attempt.attemptId, attempt);
      if (transportAttempts.size > 32) transportAttempts.delete(transportAttempts.keys().next().value);
    }
  },
});
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
  referer: context.checkout
    ? 'https://chatgpt.com/checkout/' + context.checkout.processor_entity + '/' + context.checkout.id
    : 'https://chatgpt.com/',
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
let currentStage = 'transport_initialize';
try {
  await transport.initialize(context.environment);
  currentStage = 'account_check';
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
    currentStage = 'sentinel_authorization';
    report.currentFlow = flow;
    console.log(JSON.stringify({ event: 'sentinel_flow_started', flow }));
    await authorizeSentinel(context, flow, 'https://chatgpt.com/', authorize);
    report.flowResults[flow] = { sentinelIssued: !!context.sentinel, observerIssued: !!context.sentinelSo };
  }
  report.sentinelIssued = Object.values(report.flowResults).every((value) => value.sentinelIssued);
  if (process.argv.includes('--verify-checkout')) {
    if (account.entitlement?.has_active_subscription !== false) fail('subscription_not_free');
    const country = context.environment.country;
    currentStage = 'pricing';
    const pricing = await get('/backend-api/checkout_pricing_config/configs/' + country);
    const pricingCurrency = pricing.data?.currency_config?.symbol_code;
    if (pricing.status !== 200 || typeof pricingCurrency !== 'string' || !/^[a-z]{3}$/i.test(pricingCurrency))
      fail('pricing');
    const currency = pricingCurrency.toUpperCase();
    report.pricingCurrency = currency;
    currentStage = 'sentinel_authorization';
    await authorizeSentinel(context, 'chatgpt_checkout', 'https://chatgpt.com/', authorize);
    const path = '/backend-api/payments/checkout';
    currentStage = 'merchant_checkout';
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
    if (!report.checkoutCreated) fail('merchant_checkout');
    report.checkoutId = id;
    const processor = value.processor_entity || 'openai_llc';
    if (typeof processor !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(processor))
      fail('checkout_processor');
    context.checkout = { id, processor_entity: processor };
    currentStage = 'checkout_read';
    const checkoutResponse = await get('/backend-api/payments/checkout/' + processor + '/' + id);
    report.checkoutReadHttpStatus = checkoutResponse.status;
    const snapshot = checkoutResponse.data?.checkout_session || checkoutResponse.data;
    const returnedId = snapshot?.checkout_session_id || snapshot?.id;
    const actualCurrency =
      snapshot?.currency || snapshot?.checkout_state?.currency || snapshot?.billing_details?.currency;
    if (
      checkoutResponse.status !== 200 ||
      returnedId !== id ||
      (snapshot.account_id && snapshot.account_id !== context.accountId) ||
      (snapshot.processor_entity && snapshot.processor_entity !== processor) ||
      typeof actualCurrency !== 'string' ||
      !/^[a-z]{3}$/i.test(actualCurrency) ||
      actualCurrency.toUpperCase() !== currency
    )
      fail('checkout_currency');
    report.currency = actualCurrency.toUpperCase();
    report.checkoutCurrencyVerified = true;
    const amount = snapshot.amount_total ?? snapshot.checkout_state?.total?.total?.minorUnitsAmount;
    if (amount !== undefined) {
      if (!Number.isSafeInteger(amount) || amount < 0) fail('checkout_amount');
      report.amountMinor = amount;
    }
    // Match the production engine's first-party checkout URL. Keep the full
    // link in an optional private file; never persist response client secrets.
    const checkoutUrl = 'https://chatgpt.com/checkout/' + processor + '/' + id;
    report.paymentLinkCreated = true;
    report.paymentLinkHost = 'chatgpt.com';
    if (option('--checkout-file')) {
      await writeFile(
        option('--checkout-file'),
        JSON.stringify(
          {
            checkoutId: id,
            checkoutUrl,
            currency: report.currency,
            ...(amount !== undefined ? { amountMinor: amount } : {}),
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      report.paymentLinkSaved = true;
    }
  }
} catch (error) {
  report.errorCode =
    typeof error?.code === 'string' && /^[A-Z_]{3,60}$/.test(error.code) ? error.code : 'PROBE_FAILED';
  report.failureStage = error?.stage || currentStage;
  if (error?.diagnostic) report.transportFailureDiagnostic = error.diagnostic;
  process.exitCode = 1;
} finally {
  transport.close();
  report.transportClosed = true;
  report.transportAttempts = [...transportAttempts.values()];
  report.transportRetryCount = report.transportAttempts.filter(
    (attempt) => attempt.outcome === 'retrying',
  ).length;
  if (option('--report'))
    await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
