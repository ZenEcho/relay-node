import { readFile, access, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
// Select the installed release explicitly to verify its real runtime rather
// than assuming the development build matches the running node.
const sdkBase = option('--sdk-root')
  ? pathToFileURL(resolve(option('--sdk-root')) + sep)
  : new URL('../..', import.meta.url);
const { createEnvironment, loadCredential, authorizeSentinel, OnDemandSdkRuntime, NativeTransport } =
  await import(new URL('dist/sdk.js', sdkBase).href);
const sessionFile = option('--session-file'),
  cookieFile = option('--cookie-file');
if (!sessionFile) throw new Error('需要 Session 文件路径；此检查不接收银行卡或执行付款');
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
const cookies = cookieFile ? JSON.parse(await readFile(cookieFile, 'utf8')) : session.cookies || [];
const source = option('--credential-source') || (cookieFile ? 'cookie' : 'session');
if (!Array.isArray(cookies) || !['cookie', 'session'].includes(source))
  throw new Error('Cookie 文件或登录版本选项无效');
if (source === 'session' && !(session.sessionToken || session.session_token))
  throw new Error('Session 文件缺少完整 sessionToken');
const selectedCookies =
  source === 'session'
    ? cookies.filter((c) => !/^__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(c.name || ''))
    : cookies;
const context = {
  environment: createEnvironment(option('--country') || 'PH', option('--proxy') || ''),
  credential: JSON.stringify({ ...session, cookies: selectedCookies }),
};
loadCredential(context);
const sdk = new OnDemandSdkRuntime(
  { context, demo: false },
  { headless: process.argv.includes('--headless') ? true : undefined },
);
const result = {
  checkedAt: new Date().toISOString(),
  mode: 'on_demand_official_sdk',
  sentinelIssued: false,
  implementation: option('--sdk-root') ? 'installed_node' : 'development_build',
  credentialSource: source,
  checkoutCreated: false,
  cardDataSupplied: false,
  paymentSubmitted: false,
};
let manualAuthRequested = false;
const authorizer = async (request) => {
  try {
    return await sdk.authorize(request);
  } catch (error) {
    if (
      !process.argv.includes('--manual-auth') ||
      manualAuthRequested ||
      error?.code !== 'OFFICIAL_SDK_AUTH_REQUIRED'
    )
      throw error;
    manualAuthRequested = true;
    const input = createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      JSON.stringify({
        event: 'official_auth_needs_manual_action',
        timeoutSeconds: 180,
        instruction:
          '在本次临时 Chrome 中正常打开 https://chatgpt.com/api/auth/session，手动完成官方验证，然后回到 https://chatgpt.com/；完成后按回车。此进程不处理付款。',
      }),
    );
    try {
      await input.question('', { signal: AbortSignal.timeout(180000) });
    } catch {
      throw new Error('官方手动授权等待已结束，未继续 SDK 或付款');
    } finally {
      input.close();
    }
    return await sdk.authorize(request);
  }
};
try {
  if (option('--transport')) {
    const transport = new NativeTransport(option('--transport'));
    try {
      await transport.initialize(context.environment);
      const response = await transport.request({
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-480',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + context.session.accessToken,
          'chatgpt-account-id': context.accountId,
          'oai-device-id': context.environment.deviceId,
        },
      });
      const account = Object.values(response.data?.accounts || {}).find(
        (a) => (a.account?.account_id || a.account?.id) === context.accountId,
      );
      result.bearerAccountCheck = {
        httpStatus: response.status,
        originalAccountMatches: !!account,
        ...(account
          ? {
              planType: account.account?.plan_type,
              subscriptionActive: account.entitlement?.has_active_subscription,
            }
          : {}),
      };
      if (response.status !== 200 || !account)
        throw new Error('原账号只读身份核对未通过（HTTP ' + response.status + '）');
    } finally {
      transport.close();
    }
  }
  result.flowResults = {};
  for (const flow of ['chatgpt_checkout', 'checkout_session_approval']) {
    result.currentFlow = flow;
    console.log(JSON.stringify({ event: 'sentinel_flow_started', flow }));
    await authorizeSentinel(context, flow, 'https://chatgpt.com/', authorizer);
    result.flowResults[flow] = {
      sentinelIssued: !!context.sentinel,
      observerIssued: !!context.sentinelSo,
    };
  }
  result.sentinelIssued = Object.values(result.flowResults).every((x) => x.sentinelIssued);
  result.observerIssued = Object.values(result.flowResults).every((x) => x.observerIssued);
} catch (error) {
  result.error = String(error?.message || 'SDK probe failed').slice(0, 200);
  process.exitCode = 1;
} finally {
  await sdk.close();
  const lifecycle = sdk.lifecycle;
  result.browserStarted = lifecycle.started;
  result.runtimeDisposed = lifecycle.disposed;
  result.cookieImportVerified = lifecycle.cookieImportVerified;
  if (lifecycle.diagnostic) result.diagnostic = lifecycle.diagnostic;
  result.profileRemoved = lifecycle.profile
    ? await access(lifecycle.profile).then(
        () => false,
        () => true,
      )
    : true;
  result.browserExited = !lifecycle.browserPid;
  if (lifecycle.browserPid)
    try {
      process.kill(lifecycle.browserPid, 0);
    } catch {
      result.browserExited = true;
    }
  if (option('--report'))
    await writeFile(option('--report'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
