import { prepareProbeExtension } from './lib/extension.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createEnvironment,
  loadCredential,
  sdkLoginCookies,
  findSdkBrowser,
  authorizeSentinel,
} from '../../dist/sdk.js';
import { SdkCdp } from '../../dist/apps/worker/src/browser/cdp.js';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const manualSeconds = Number(option('--manual-timeout-seconds') || 360);
if (!Number.isInteger(manualSeconds) || manualSeconds < 60 || manualSeconds > 420)
  throw new Error('手动等待期限需要为 60–420 秒');
if (!option('--session-file')) throw new Error('需要本次 Session 文件');
const session = JSON.parse(await readFile(option('--session-file'), 'utf8'));
const context = {
  environment: createEnvironment('PH', option('--proxy') || ''),
  credential: JSON.stringify(session),
};
loadCredential(context);
if (!session.sessionToken || !session.statsigContext?.deviceId) throw new Error('需要完整 Session 与原设备');
const extension = await mkdtemp(join(tmpdir(), 'relay-sdk-extension-'));
await prepareProbeExtension(extension, { name: 'Relay 原生 SDK 隔离预检' });
const report = {
  checkedAt: new Date().toISOString(),
  mode: 'native_chrome_extension_MAIN',
  pageRuntimeEnabled: false,
  pageRuntimeEvaluated: false,
  sentinelIssued: false,
  checkoutCreated: false,
  cardDataSupplied: false,
  paymentSubmitted: false,
  sessionResponses: [],
};
let host, cdp, lifecycle;
try {
  host = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/apps/worker/src/browser/host.js', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  host.stderr.resume();
  lifecycle = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: host.stdout });
    const timer = setTimeout(() => reject(new Error('BROWSER_START_TIMEOUT')), 30000);
    host.once('error', () => {
      clearTimeout(timer);
      reject(new Error('BROWSER_START_FAILED'));
    });
    host.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('BROWSER_START_FAILED'));
    });
    lines.once('line', (line) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(line);
        if (value.error) throw new Error();
        resolve(value);
      } catch {
        reject(new Error('BROWSER_START_FAILED'));
      } finally {
        lines.close();
      }
    });
    void findSdkBrowser().then(
      (executablePath) =>
        host.stdin.write(
          JSON.stringify({
            executablePath,
            proxyServer: context.environment.proxyUrl,
            normalBrowserDefaults: true,
            sdkProbeExtension: true,
          }) + '\n',
        ),
      () => reject(new Error('BROWSER_START_FAILED')),
    );
  });
  report.browserStarted = true;
  cdp = await SdkCdp.connect(lifecycle.endpoint);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  report.isolatedExtensionReady = true;
  let worker, page;
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    worker = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'),
    );
    page = targetInfos.find((t) => t.type === 'page' && t.url === 'about:blank');
    if (worker && page) break;
    await delay(100);
  }
  if (!worker || !page) throw new Error('OWNED_TARGETS_UNAVAILABLE');
  const workerSession = (
    await cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    })
  ).sessionId;
  const pageSession = (
    await cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
  ).sessionId;
  await cdp.send('Page.enable', {}, pageSession);
  await cdp.send('Network.enable', {}, pageSession);
  let loaded = false,
    sessionDocument;
  cdp.on((method, params, sessionId) => {
    if (sessionId !== pageSession) return;
    if (method === 'Page.loadEventFired') loaded = true;
    if (
      method === 'Network.responseReceived' &&
      params.response?.url === 'https://chatgpt.com/api/auth/session'
    ) {
      const h = params.response.headers || {};
      const response = {
        status: params.response.status,
        resourceType: params.type,
        challengeHeader: Object.entries(h).some(
          ([k, v]) => k.toLowerCase() === 'cf-mitigated' && v === 'challenge',
        ),
      };
      report.sessionResponses.push(response);
      if (params.type === 'Document') sessionDocument = response;
    }
  });
  const login = sdkLoginCookies(context.environment.cookies);
  await cdp.send(
    'Network.setCookies',
    {
      cookies: login.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: /session-token/.test(c.name) || c.httpOnly === true,
      })),
    },
    pageSession,
  );
  const imported = await cdp.send('Network.getCookies', { urls: ['https://chatgpt.com/'] }, pageSession);
  report.cookieImportVerified = login.every((c) =>
    imported.cookies.some((a) => a.name === c.name && a.value === c.value),
  );
  if (!report.cookieImportVerified) throw new Error('COOKIE_IMPORT_FAILED');
  await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' }, pageSession);
  for (let i = 0; i < 450 && !loaded; i++) await delay(100);
  if (!loaded) throw new Error('OFFICIAL_PAGE_LOAD_TIMEOUT');
  const runSdk = (request) =>
    cdp.evaluate(
      `(async()=>{const request=${JSON.stringify(request)};const tabs=(await chrome.tabs.query({url:'https://chatgpt.com/'})).filter(t=>t.url===request.pageUrl);if(tabs.length!==1)return {failureReason:'PAGE_BINDING'};const rows=await chrome.scripting.executeScript({target:{tabId:tabs[0].id,frameIds:[0]},world:'MAIN',func:globalThis.relayReferenceAuthorize,args:[request]});return rows[0]?.result||{failureReason:'RESULT_MISSING'};})()`,
      workerSession,
      180000,
    );
  let manualAttempted = false;
  const manualHandoff = async () => {
    manualAttempted = true;
    loaded = false;
    sessionDocument = undefined;
    await cdp.send('Page.navigate', { url: 'https://chatgpt.com/api/auth/session' }, pageSession);
    for (let i = 0; i < 300 && !loaded; i++) await delay(100);
    report.manualSessionDocument = sessionDocument;
    await cdp.evaluate(
      `(async()=>{const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});if(tabs.length!==1)throw new Error('owned tab unavailable');await chrome.windows.update(tabs[0].windowId,{state:'normal',focused:true});await chrome.tabs.update(tabs[0].id,{active:true});return true;})()`,
      workerSession,
    );
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    // Only fixed booleans leave this MAIN-world DOM observation. Never capture
    // a session JSON containing account credentials in a screenshot.
    const snapshotFacts = () =>
      cdp.evaluate(
        `(async()=>{const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});if(tabs.length!==1)return {safe:false};const rows=await chrome.scripting.executeScript({target:{tabId:tabs[0].id,frameIds:[0]},world:'MAIN',func:()=>({safe:!(/accessToken|sessionToken|eyJ[A-Za-z0-9_-]{30}/.test(document.body?.innerText||'')),hasContent:!!document.body?.innerText.trim()})});return rows[0]?.result||{safe:false};})()`,
        workerSession,
      );
    let facts;
    for (let i = 0; i < 30; i++) {
      facts = await snapshotFacts();
      if (facts.hasContent || !facts.safe) break;
      await delay(500);
    }
    if (
      facts?.safe &&
      sessionDocument?.status === 403 &&
      sessionDocument.challengeHeader &&
      option('--screenshot')
    ) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageSession);
      await writeFile(option('--screenshot'), Buffer.from(data, 'base64'), {
        mode: 0o600,
      });
      report.challengeScreenshotSaved = true;
    }
    report.manualActionRequested = true;
    console.log(
      JSON.stringify({
        event: 'official_auth_needs_manual_action',
        timeoutSeconds: manualSeconds,
        windowFocused: true,
        screenshotSaved: report.challengeScreenshotSaved === true,
      }),
    );
    const prompt = createPrompt({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question('', {
        signal: AbortSignal.timeout(manualSeconds * 1000),
      });
      if (answer.trim() !== 'continue') {
        report.manualAuthCancelled = true;
        return false;
      }
    } finally {
      prompt.close();
    }
    loaded = false;
    await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' }, pageSession);
    for (let i = 0; i < 300 && !loaded; i++) await delay(100);
    return true;
  };
  report.flowResults = {};
  for (const flow of ['checkout_session_approval', 'chatgpt_checkout']) {
    report.currentFlow = flow;
    await authorizeSentinel(context, flow, 'https://chatgpt.com/', async (request) => {
      // Runtime evaluation is confined to the extension worker. The official
      // page is never evaluated/enabled through CDP or Playwright.
      let result = await runSdk(request);
      report.lastSdkResult = {
        ...result?.safe,
        failureReason: result?.failureReason,
      };
      if (
        !result?.authorization &&
        !manualAttempted &&
        process.argv.includes('--manual-auth') &&
        /^SESSION_HTTP_\d{3}$/.test(result?.failureReason || '') &&
        (await manualHandoff())
      ) {
        result = await runSdk(request);
        report.sdkResultAfterManualAction = {
          ...result?.safe,
          failureReason: result?.failureReason,
        };
      }
      if (!result?.authorization) throw new Error('SDK_' + (result?.failureReason || 'RESULT_MISSING'));
      return result.authorization;
    });
    report.flowResults[flow] = {
      sentinelIssued: !!context.sentinel,
      observerIssued: !!context.sentinelSo,
    };
  }
  report.sentinelIssued = Object.values(report.flowResults).every((x) => x.sentinelIssued);
} catch (error) {
  const message = String(error?.message || '');
  report.error =
    error?.name === 'AbortError'
      ? 'MANUAL_AUTH_WAIT_ENDED'
      : /^(?:BROWSER_START_TIMEOUT|BROWSER_START_FAILED|OWNED_TARGETS_UNAVAILABLE|COOKIE_IMPORT_FAILED|OFFICIAL_PAGE_LOAD_TIMEOUT|SDK_[A-Z_]+(?:_\d{3})?)$/.test(
            message,
          )
        ? message
        : 'NATIVE_PROBE_FAILED';
  process.exitCode = 1;
} finally {
  cdp?.close();
  host?.stdin.end();
  if (host) for (let i = 0; i < 100 && host.exitCode === null; i++) await delay(100);
  report.browserExited = !lifecycle?.pid;
  if (lifecycle?.pid)
    try {
      process.kill(lifecycle.pid, 0);
    } catch {
      report.browserExited = true;
    }
  report.profileRemoved =
    !lifecycle?.profile ||
    (await access(lifecycle.profile).then(
      () => false,
      () => true,
    ));
  await rm(extension, { recursive: true, force: true });
  if (option('--report'))
    await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
