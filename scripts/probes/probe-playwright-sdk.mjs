import { prepareProbeExtension } from './lib/extension.mjs';
import { authorizeSentinelInPage } from '../../dist/apps/worker/src/browser/actions.js';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createEnvironment, loadCredential, sdkLoginCookies, authorizeSentinel } from '../../dist/sdk.js';
import { authorizeReferenceSentinelInPage } from './reference-sentinel-probe-action.mjs';

// Read-only comparison with standard Playwright. No personal profile, stealth
// options, payment engine, card inputs, tracing or credential/token logging.
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const sessionFile = option('--session-file'),
  modulePath = option('--playwright-module');
if (!sessionFile || !modulePath) throw new Error('需要 Session 文件及已安装的 playwright-core 模块路径');
const session = JSON.parse(await readFile(sessionFile, 'utf8'));
const context = {
  environment: createEnvironment('PH', option('--proxy') || ''),
  credential: JSON.stringify(session),
};
loadCredential(context);
if (!session.sessionToken || !session.statsigContext?.deviceId)
  throw new Error('本次对照需要完整 Session 及其原设备标识');
const { chromium } = await import(pathToFileURL(modulePath).href);
const profile = await mkdtemp(join(tmpdir(), 'relay-playwright-sdk-'));
const extensionMode = process.argv.includes('--extension-world');
const referenceSequence = process.argv.includes('--reference-sequence');
let extensionPath;
if (extensionMode) {
  if (!option('--launch-options-module')) throw new Error('扩展对照需要正常 Chrome 启动配置');
  extensionPath = join(profile, 'relay-sdk-probe-extension');
  await prepareProbeExtension(extensionPath, {
    name: 'Relay 官方 SDK 隔离预检',
    official: true,
  });
}
const report = {
  checkedAt: new Date().toISOString(),
  mode: 'playwright_official_sdk',
  browserStarted: false,
  sentinelIssued: false,
  checkoutCreated: false,
  cardDataSupplied: false,
  paymentSubmitted: false,
};
let browserContext, browser, extensionWorker;
const requestMetadataTasks = [];
let requestPhase = 'official_page';
try {
  let launchOptions = {
    channel: 'chrome',
    headless: false,
    chromiumSandbox: true,
    viewport: null,
    acceptDownloads: false,
    timeout: 30000,
    ...(context.environment.proxyUrl ? { proxy: { server: context.environment.proxyUrl } } : {}),
  };
  if (option('--launch-options-module')) {
    const { browserLaunchOptions } = await import(pathToFileURL(option('--launch-options-module')).href);
    launchOptions = browserLaunchOptions(
      {
        browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        browserProxy: context.environment.proxyUrl || 'direct',
      },
      profile,
    );
    // This comparison has no extension. Its extension-debugging permission is
    // unnecessary; otherwise retain the reference's ordinary browser defaults.
    if (!extensionMode)
      launchOptions.args = launchOptions.args.filter((arg) => arg !== '--enable-unsafe-extension-debugging');
    report.browserLaunchMode = 'checkout_autofill_normal_defaults';
  } else report.browserLaunchMode = 'playwright_defaults';
  report.pageCallMode = extensionMode
    ? 'extension_MAIN'
    : process.argv.includes('--function-call')
      ? 'function_with_arguments'
      : 'serialized_expression';
  browserContext = await chromium.launchPersistentContext(profile, launchOptions);
  browser = browserContext.browser();
  report.browserStarted = true;
  if (extensionMode) {
    const cdp = await browser.newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', {
      path: extensionPath,
    });
    extensionWorker =
      browserContext
        .serviceWorkers()
        .find((worker) => worker.url().startsWith('chrome-extension://' + id + '/')) ||
      (await browserContext.waitForEvent('serviceworker', {
        predicate: (worker) => worker.url().startsWith('chrome-extension://' + id + '/'),
        timeout: 15000,
      }));
    report.isolatedExtensionReady = true;
    await cdp.detach();
  }
  const login = sdkLoginCookies(context.environment.cookies);
  await browserContext.addCookies(
    login.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: /session-token/.test(c.name) || c.httpOnly === true,
    })),
  );
  const imported = await browserContext.cookies('https://chatgpt.com/');
  report.cookieImportVerified = login.every((c) =>
    imported.some((a) => a.name === c.name && a.value === c.value),
  );
  if (!report.cookieImportVerified) throw new Error('PLAYWRIGHT_COOKIE_IMPORT');
  const page = browserContext.pages()[0] || (await browserContext.newPage());
  page.setDefaultTimeout(20000);
  const runSdk = async (request) => {
    if (extensionWorker)
      return await extensionWorker.evaluate(
        async ({ request, referenceSequence }) => {
          const tabs = (await chrome.tabs.query({ url: 'https://chatgpt.com/' })).filter(
            (tab) => tab.url === request.pageUrl,
          );
          if (tabs.length !== 1) return { failureReason: 'PAGE_BINDING' };
          const rows = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id, frameIds: [0] },
            world: 'MAIN',
            func: referenceSequence ? globalThis.relayReferenceAuthorize : globalThis.relaySdkAuthorize,
            args: [request, true],
          });
          return rows[0]?.result || { failureReason: 'RESULT_MISSING' };
        },
        { request, referenceSequence },
      );
    if (referenceSequence) return await page.evaluate(authorizeReferenceSentinelInPage, request);
    if (!process.argv.includes('--function-call'))
      return await page.evaluate(
        '(' + authorizeSentinelInPage.toString() + ')(' + JSON.stringify(request) + ',true)',
      );
    try {
      return await page.evaluate(authorizeSentinelInPage, request);
    } catch (error) {
      return {
        failureReason:
          String(error?.message || '').match(/\[RELAY_SENTINEL_([A-Z_]{3,32})\]/)?.[1] || 'PAGE_EXECUTION',
      };
    }
  };
  const manualSessionHandoff = async () => {
    const response = await page.goto('https://chatgpt.com/api/auth/session', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    report.manualSessionNavigation = {
      status: response?.status(),
      challengeHeader: response?.headers()['cf-mitigated'] === 'challenge',
    };
    if (response?.status() !== 403 || !report.manualSessionNavigation.challengeHeader) return false;
    await page.bringToFront();
    await page
      .waitForFunction(() => !!document.body?.innerText.trim(), undefined, {
        timeout: 15000,
      })
      .catch(() => {});
    const safeToCapture = await page.evaluate(
      () => !/accessToken|sessionToken|eyJ[A-Za-z0-9_-]{30}/.test(document.body?.innerText || ''),
    );
    if (safeToCapture && option('--screenshot')) {
      await page.screenshot({ path: option('--screenshot') });
      report.challengeScreenshotSaved = true;
    }
    console.log(
      JSON.stringify({
        event: 'official_auth_needs_manual_action',
        timeoutSeconds: 180,
        screenshotSaved: report.challengeScreenshotSaved === true,
      }),
    );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await input.question('', {
        signal: AbortSignal.timeout(180000),
      });
      if (answer.trim() !== 'continue') {
        report.manualAuthCancelled = true;
        return false;
      }
    } finally {
      input.close();
    }
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    return true;
  };
  report.sessionResponses = [];
  page.on('response', (response) => {
    if (response.url() !== 'https://chatgpt.com/api/auth/session') return;
    const metadata = {
      phase: requestPhase,
      status: response.status(),
      challengeHeader: response.headers()['cf-mitigated'] === 'challenge',
      fromServiceWorker: response.fromServiceWorker(),
      resourceType: response.request().resourceType(),
    };
    report.sessionResponses.push(metadata);
    requestMetadataTasks.push(
      response
        .request()
        .allHeaders()
        .then((headers) => {
          metadata.requestHeaders = Object.fromEntries(
            [
              'accept',
              'content-type',
              'cache-control',
              'pragma',
              'sec-fetch-mode',
              'sec-fetch-site',
              'sec-fetch-dest',
            ]
              .filter((name) => headers[name] !== undefined)
              .map((name) => [name, headers[name]]),
          );
        })
        .catch(() => {}),
    );
  });
  const home = await page.goto('https://chatgpt.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  report.homepage = {
    status: home?.status(),
    challengeHeader: home?.headers()['cf-mitigated'] === 'challenge',
  };
  if (process.argv.includes('--sdk-first') || process.argv.includes('--request-comparison')) {
    await page.waitForLoadState('load', { timeout: 45000 });
    report.officialPageRendered = await page
      .waitForFunction(
        () => document.readyState === 'complete' && !!document.body?.innerText.trim(),
        undefined,
        { timeout: 30000 },
      )
      .then(
        () => true,
        () => false,
      );
  }
  const checkSession = (redirect) =>
    page.evaluate(
      async ({ expectedAccount, redirect }) => {
        const r = await fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
          ...(redirect ? { redirect } : {}),
        });
        const body = await r.text();
        let value;
        try {
          value = JSON.parse(body);
        } catch {}
        return {
          status: r.status,
          jsonResponse: !!value,
          hasAccessToken: !!(value?.accessToken || value?.access_token),
          originalAccountMatches: value?.account?.id === expectedAccount,
          challengeHeader: r.headers.get('cf-mitigated') === 'challenge',
          challengePageMarker: /cf-chl-|\/cdn-cgi\/challenge-platform\//.test(body),
        };
      },
      { expectedAccount: context.accountId, redirect },
    );
  if (process.argv.includes('--request-comparison')) {
    report.fetchComparisons = [];
    for (const redirect of ['follow', 'error', 'follow']) {
      requestPhase = 'comparison_' + redirect;
      report.fetchComparisons.push({
        redirect,
        ...(await checkSession(redirect)),
      });
    }
  }
  if (!process.argv.includes('--request-comparison') || process.argv.includes('--sdk-after-comparison')) {
    requestPhase = 'pre_sdk_probe';
    report.sessionCheck = process.argv.includes('--sdk-first')
      ? { skippedExtraProbe: true }
      : await checkSession();
    if (
      !process.argv.includes('--sdk-first') &&
      (report.sessionCheck.status !== 200 || !report.sessionCheck.originalAccountMatches)
    ) {
      const response = await page.goto('https://chatgpt.com/api/auth/session', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      report.sessionNavigation = {
        status: response?.status(),
        challengeHeader: response?.headers()['cf-mitigated'] === 'challenge',
      };
      if (response?.status() === 403 && report.sessionNavigation.challengeHeader && option('--screenshot')) {
        await page.screenshot({ path: option('--screenshot') });
        report.challengeScreenshotSaved = true;
      }
      if (
        process.argv.includes('--manual-auth') &&
        response?.status() === 403 &&
        report.sessionNavigation.challengeHeader
      ) {
        await page.bringToFront();
        console.log(
          JSON.stringify({
            event: 'official_auth_needs_manual_action',
            timeoutSeconds: 180,
            screenshotSaved: report.challengeScreenshotSaved === true,
          }),
        );
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          const answer = await input.question('', {
            signal: AbortSignal.timeout(180000),
          });
          if (answer.trim() !== 'continue') throw new Error('未收到继续授权检查的指令');
        } finally {
          input.close();
        }
      }
      report.sessionCheckAfterNavigation = await checkSession();
      if (
        report.sessionCheckAfterNavigation.status !== 200 ||
        !report.sessionCheckAfterNavigation.originalAccountMatches
      )
        throw new Error('SESSION_HTTP_OR_IDENTITY');
      await page.goto('https://chatgpt.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    }
    report.flowResults = {};
    report.sdkSequence = referenceSequence ? 'checkout_autofill_init_observer_main_timing' : 'main_observer';
    const flows = referenceSequence
      ? ['checkout_session_approval']
      : ['chatgpt_checkout', 'checkout_session_approval'];
    report.flowsChecked = flows;
    for (const flow of flows) {
      report.currentFlow = flow;
      requestPhase = 'sdk_' + flow;
      await authorizeSentinel(context, flow, 'https://chatgpt.com/', async (request) => {
        let result = await runSdk(request);
        if (referenceSequence) {
          report.referenceSdkResult = {
            ...result.safe,
            failureReason: result.failureReason,
          };
          if (
            process.argv.includes('--manual-auth') &&
            /^SESSION_HTTP_\d{3}$/.test(result.failureReason || '') &&
            (await manualSessionHandoff())
          ) {
            result = await runSdk(request);
            report.referenceSdkResultAfterManualAction = {
              ...result.safe,
              failureReason: result.failureReason,
            };
          }
          if (result.failureReason) throw new Error('SDK_' + result.failureReason);
          return result.authorization;
        }
        if (result?.failureReason)
          report.sdkFailure = {
            reason: result.failureReason,
            sessionCheckPhase: result.sessionCheckPhase,
          };
        if (result?.sessionCheckPhase === 'after') report.officialSdkPreparedBeforeIdentityFailure = true;
        if (result?.failureReason === 'SESSION_HTTP') {
          report.sessionCheckAfterSdkFailure = await checkSession();
          const response = await page.goto('https://chatgpt.com/api/auth/session', {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          report.sessionNavigationAfterSdkFailure = {
            status: response?.status(),
            challengeHeader: response?.headers()['cf-mitigated'] === 'challenge',
          };
          const matched =
            response?.status() === 200 &&
            (await page.evaluate((expectedAccount) => {
              try {
                const value = JSON.parse(
                  document.querySelector('pre')?.textContent || document.body?.textContent || '',
                );
                return !!(value.accessToken || value.access_token) && value.account?.id === expectedAccount;
              } catch {
                return false;
              }
            }, context.accountId));
          if (matched) {
            await page.goto('https://chatgpt.com/', {
              waitUntil: 'domcontentloaded',
              timeout: 45000,
            });
            result = await runSdk(request);
            if (result?.failureReason)
              report.sdkFailureAfterNavigation = {
                reason: result.failureReason,
                sessionCheckPhase: result.sessionCheckPhase,
              };
          } else if (
            response?.status() === 403 &&
            report.sessionNavigationAfterSdkFailure.challengeHeader &&
            option('--screenshot')
          ) {
            await page.screenshot({ path: option('--screenshot') });
            report.challengeScreenshotSaved = true;
          }
        }
        if (!result || result.failureReason)
          throw new Error('SDK_' + (result?.failureReason || 'RESULT_MISSING'));
        return result;
      });
      report.flowResults[flow] = {
        sentinelIssued: !!context.sentinel,
        observerIssued: !!context.sentinelSo,
      };
    }
    report.sentinelIssued = Object.values(report.flowResults).every((x) => x.sentinelIssued);
  }
} catch (error) {
  // Playwright errors can contain source snippets/URLs. Persist only local codes.
  const message = String(error?.message || '');
  report.error = /^(?:SESSION_HTTP_OR_IDENTITY|PLAYWRIGHT_COOKIE_IMPORT|SDK_[A-Z_]+(?:_\d{3})?)$/.test(
    message,
  )
    ? message
    : error?.name === 'TimeoutError'
      ? 'PLAYWRIGHT_TIMEOUT'
      : error?.name === 'AbortError'
        ? 'MANUAL_AUTH_WAIT_ENDED'
        : 'PLAYWRIGHT_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  await Promise.allSettled(requestMetadataTasks);
  await browserContext?.close().catch(() => {});
  report.browserExited = !browser?.isConnected();
  await rm(profile, { recursive: true, force: true });
  report.profileRemoved = await access(profile).then(
    () => false,
    () => true,
  );
  if (option('--report'))
    await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
