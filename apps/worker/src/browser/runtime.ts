import { cardInputValues } from './card-input.js';
import { findSdkBrowser, sdkLoginCookies } from './configuration.js';
export { checkPaymentRuntime, findSdkBrowser, sdkLoginCookies } from './configuration.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SdkCdp } from './cdp.js';
import { startSdkProxy } from '../transport/browser-proxy.js';
import { authorizeSentinelInPage } from './actions.js';
import { prepareStripeTokenInPage } from './actions.js';
import type { SentinelAuthorizer } from '../../../../packages/contracts/src/sentinel.js';
import { createReferenceSentinelAuthorizer, type ReferenceSentinelOptions } from './reference-sentinel.js';
import type { StripeTokenProvider } from '../../../../packages/contracts/src/stripe.js';
import type { Assignment, Control } from '../runtime/controller.js';
import type { Transport } from '../transport/native.js';
import { ProtocolEngine } from '../execution/engine.js';

export type OnDemandSdkOptions = {
  executablePath?: string;
  headless?: boolean;
};
export type SentinelRuntimeOptions =
  { mode: 'official' } | (ReferenceSentinelOptions & { mode: 'reference' });

export class OnDemandSdkRuntime {
  private host?: ChildProcessWithoutNullStreams;
  private cdp?: SdkCdp;
  private session = '';
  private frames = new Set<string>();
  private proxy?: Awaited<ReturnType<typeof startSdkProxy>>;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private disposed = false;
  private startedAt?: number;
  private profile?: string;
  private browserPid?: number;
  private cookieImportVerified = false;
  private documentResponse?: { url: string; status: number };
  private diagnostic?: {
    sessionStatus?: number;
    jsonResponse?: boolean;
    accountMatches?: boolean;
    importedCookies?: number;
    browserCookies?: number;
    credentialCookiesMatch?: boolean;
    pageTitle?: string;
  };
  constructor(
    private assignment: Assignment,
    private options: OnDemandSdkOptions = {},
  ) {}

  // Diagnostics expose lifecycle only, never debugger endpoints, cookies or card data.
  get lifecycle() {
    return {
      started: !!this.startedAt,
      browserPid: this.browserPid,
      profile: this.profile,
      disposed: this.disposed,
      cookieImportVerified: this.cookieImportVerified,
      diagnostic: this.diagnostic,
    };
  }

  private async open() {
    if (this.disposed) throw new Error('本单官方 SDK 环境已关闭');
    return (this.opening ||= this.launch().catch(async (error) => {
      await this.close();
      throw error;
    }));
  }
  private async launch() {
    const executablePath = await findSdkBrowser(this.options.executablePath);
    const context = this.assignment.context;
    if (!context.environment.cookies.some((c) => /session-token(?:\.\d+)?$/.test(c.name)))
      throw Object.assign(new Error('本单缺少可供官方 SDK 登录的 Cookie/sessionToken'), {
        code: 'OFFICIAL_SDK_AUTH_REQUIRED',
      });
    if (context.environment.proxyUrl) this.proxy = await startSdkProxy(context.environment.proxyUrl);
    const host = (this.host = spawn(
      process.execPath,
      [fileURLToPath(new URL('./host.js', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ));
    host.stderr.resume();
    const info: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('按需 SDK 浏览器启动超时')), 20000);
      const lines = createInterface({ input: host.stdout });
      lines.once('line', (line) => {
        clearTimeout(timer);
        lines.close();
        try {
          const value = JSON.parse(line);
          value.error ? reject(new Error('按需 SDK 浏览器启动失败')) : resolve(value);
        } catch {
          reject(new Error('按需 SDK 浏览器启动响应无效'));
        }
      });
      host.once('error', () => {
        clearTimeout(timer);
        reject(new Error('SDK 浏览器监护进程无法启动'));
      });
      host.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('SDK 浏览器在准备期间退出'));
      });
      host.stdin.write(
        JSON.stringify({
          executablePath,
          headless: this.options.headless ?? process.platform !== 'darwin',
          ...(this.proxy ? { proxyServer: this.proxy.server } : {}),
        }) + '\n',
      );
    });
    this.startedAt = Date.now();
    this.profile = info.profile;
    this.browserPid = info.pid;
    const cdp = (this.cdp = await SdkCdp.connect(info.endpoint));
    cdp.on((method, params, session) => {
      if (method === 'Network.responseReceived' && session === this.session && params.type === 'Document')
        this.documentResponse = {
          url: params.response?.url,
          status: params.response?.status,
        };
      if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
        this.frames.add(params.sessionId);
        void cdp
          .send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            params.sessionId,
          )
          .catch(() => {});
      }
      if (method === 'Target.detachedFromTarget') this.frames.delete(params.sessionId);
      if (method === 'Fetch.requestPaused' && session)
        void cdp.send('Fetch.continueRequest', { requestId: params.requestId }, session).catch(() => {});
      if (method === 'Fetch.authRequired' && session) {
        const ownProxy = this.proxy && params.authChallenge?.source === 'Proxy';
        void cdp
          .send(
            'Fetch.continueWithAuth',
            {
              requestId: params.requestId,
              authChallengeResponse: ownProxy
                ? {
                    response: 'ProvideCredentials',
                    username: this.proxy!.username,
                    password: this.proxy!.password,
                  }
                : { response: 'CancelAuth' },
            },
            session,
          )
          .catch(() => {});
      }
    });
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    this.session = (
      await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })
    ).sessionId;
    await cdp.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      this.session,
    );
    await cdp.send('Page.enable', {}, this.session);
    await cdp.send('Network.enable', {}, this.session);
    if (this.proxy) await cdp.send('Fetch.enable', { handleAuthRequests: true }, this.session);
    const login = sdkLoginCookies(context.environment.cookies).sort((a, b) => a.name.localeCompare(b.name));
    const cookies = login.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: /session-token/.test(c.name) || c.httpOnly === true,
      ...(Number.isFinite(c.expires) && c.expires > 0 ? { expires: c.expires } : {}),
      ...((
        {
          strict: 'Strict',
          lax: 'Lax',
          none: 'None',
          no_restriction: 'None',
        } as any
      )[String(c.sameSite).toLowerCase()]
        ? {
            sameSite: (
              {
                strict: 'Strict',
                lax: 'Lax',
                none: 'None',
                no_restriction: 'None',
              } as any
            )[String(c.sameSite).toLowerCase()],
          }
        : {}),
    }));
    await cdp.send('Network.setCookies', { cookies }, this.session);
    const imported = await cdp.send('Network.getCookies', { urls: ['https://chatgpt.com/'] }, this.session);
    this.cookieImportVerified = login
      .filter((c) => /session-token/.test(c.name))
      .every((c) =>
        imported.cookies?.some((actual: any) => actual.name === c.name && actual.value === c.value),
      );
    if (!this.cookieImportVerified)
      throw Object.assign(new Error('本单登录 Cookie 未能导入临时 SDK 环境'), {
        code: 'OFFICIAL_SDK_AUTH_REQUIRED',
      });
    const nav = await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' }, this.session);
    if (nav.errorText) throw new Error('本单官方 SDK 页面加载失败，请检查本单代理');
    for (let i = 0; i < 150; i++) {
      const ready = await cdp.evaluate('({origin:location.origin,ready:document.readyState})', this.session);
      if (ready?.origin === 'https://chatgpt.com' && ready.ready !== 'loading') return;
      await delay(100);
    }
    throw new Error('本单官方 SDK 页面未在期限内就绪');
  }
  readonly authorize: SentinelAuthorizer = async (request) => {
    await this.open();
    const expression = '(' + authorizeSentinelInPage.toString() + ')(' + JSON.stringify(request) + ',true)';
    let result = await this.cdp!.evaluate(expression, this.session, 170000);
    // A single normal first-party navigation lets the official site establish
    // its own session state when its background session request was denied.
    // Do not weaken the original account/device checks or fabricate a result.
    if (
      result?.failureReason === 'SESSION_HTTP' &&
      this.cookieImportVerified &&
      (await this.verifySessionNavigation(request.accountId))
    )
      result = await this.cdp!.evaluate(expression, this.session, 170000);
    if (!result || result.failureReason) {
      try {
        const cookies = await this.cdp!.send(
          'Network.getCookies',
          { urls: ['https://chatgpt.com/'] },
          this.session,
        );
        this.diagnostic = await this.cdp!.evaluate(
          `(async()=>{const r=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});let value;try{value=await r.json()}catch{};return {sessionStatus:r.status,jsonResponse:!!value,accountMatches:value?.account?.id===${JSON.stringify(request.accountId)},pageTitle:['ChatGPT','Just a moment...','请稍候…','Attention Required! | Cloudflare'].includes(document.title)?document.title:'other'};})()`,
          this.session,
          25000,
        );
        const imported = sdkLoginCookies(this.assignment.context.environment.cookies);
        this.diagnostic!.importedCookies = imported.length;
        this.diagnostic!.browserCookies = cookies.cookies?.length || 0;
        this.diagnostic!.credentialCookiesMatch = imported
          .filter((c) => /session-token/.test(c.name))
          .every((c) =>
            cookies.cookies?.some((actual: any) => actual.name === c.name && actual.value === c.value),
          );
      } catch {}
      throw Object.assign(
        new Error('官方 Sentinel SDK 未完成：' + String(result?.failureReason || 'RESULT_MISSING')),
        {
          code: /^(?:SESSION_|DEVICE_BINDING)/.test(result?.failureReason || '')
            ? 'OFFICIAL_SDK_AUTH_REQUIRED'
            : 'OFFICIAL_SDK_UNAVAILABLE',
        },
      );
    }
    return result;
  };
  private async verifySessionNavigation(accountId?: string) {
    if (!accountId) return false;
    const url = 'https://chatgpt.com/api/auth/session';
    this.documentResponse = undefined;
    const nav = await this.cdp!.send('Page.navigate', { url }, this.session);
    if (nav.errorText) return false;
    let matched = false;
    for (let i = 0; i < 150 && !this.disposed; i++) {
      const response = this.documentResponse as { url: string; status: number } | undefined;
      if (response?.url === url && response.status === 200) {
        const identity = await this.cdp!.evaluate(
          `(()=>{if(location.origin!=='https://chatgpt.com'||location.pathname!=='/api/auth/session')return {ready:false};try{const value=JSON.parse(document.querySelector('pre')?.textContent||document.body?.textContent||'');return {ready:true,matched:value.account?.id===${JSON.stringify(accountId)}}}catch{return {ready:false}}})()`,
          this.session,
        );
        if (identity?.ready) {
          matched = identity.matched === true;
          break;
        }
      }
      await delay(100);
    }
    await this.cdp!.send('Page.navigate', { url: 'https://chatgpt.com/' }, this.session);
    for (let i = 0; i < 100 && !this.disposed; i++) {
      const ready = await this.cdp!.evaluate(
        `location.origin==='https://chatgpt.com'&&document.readyState!=='loading'`,
        this.session,
      );
      if (ready) break;
      await delay(100);
    }
    return matched;
  }
  readonly prepareStripeToken: StripeTokenProvider = async (request, card) => {
    const values = cardInputValues(card, request.cardLastFour);
    await this.open();
    const cdp = this.cdp!;
    const result = cdp.evaluate(
      '(' + prepareStripeTokenInPage.toString() + ')(' + JSON.stringify(request) + ')',
      this.session,
      320000,
    );
    // Attach the rejection handler immediately while the native field work runs.
    void result.catch(() => {});
    const abort = new AbortController();
    try {
      const frame = await Promise.race([
        this.cardFrame(abort.signal),
        result.then((value) => {
          throw Object.assign(
            new Error('官方 Stripe SDK 未准备好安全输入框：' + String(value?.reason || 'UNEXPECTED_RESULT')),
            {
              code: /^(SESSION_|IDENTITY_MISMATCH)/.test(value?.reason || '')
                ? 'OFFICIAL_SDK_AUTH_REQUIRED'
                : 'OFFICIAL_SDK_UNAVAILABLE',
            },
          );
        }),
      ]);
      for (const [name, text] of [
        ['number', values.number],
        ['expiry', values.expiry],
        ['cvc', values.cvc],
      ]) {
        const focused = await cdp.evaluate(
          `(() => { if(location.hostname!=='js.stripe.com')return false;const el=document.querySelector('input[name=${name}]');if(!el||el.value)return false;el.focus();return document.activeElement===el;})()`,
          frame,
        );
        if (!focused) throw new Error('官方 Stripe 卡片输入框不可用或已有内容');
        await cdp.send('Input.insertText', { text }, frame);
      }
      const facts = await cdp.evaluate(
        `(() => {const number=document.querySelector('input[name=number]')?.value.replace(/\\D/g,'')||'';return {digits:number.length,lastFour:number.slice(-4),expiry:document.querySelector('input[name=expiry]')?.value.replace(/\\D/g,''),cvcLength:document.querySelector('input[name=cvc]')?.value.length};})()`,
        frame,
      );
      if (
        facts?.digits !== values.number.length ||
        facts.lastFour !== request.cardLastFour ||
        facts.expiry !== values.expiry ||
        facts.cvcLength !== values.cvc.length
      )
        throw new Error('官方 Stripe 输入框未确认原卡资料');
      let submitted = false;
      for (let i = 0; i < 50; i++) {
        submitted = await cdp.evaluate(
          `(() => {const form=document.querySelector('#relay-stripe-preparation form');const button=form?.querySelector('button[type=submit]');if(!button||button.disabled||button.textContent!=='生成一次性卡片令牌')return false;button.click();return true;})()`,
          this.session,
        );
        if (submitted) break;
        await delay(100);
      }
      if (!submitted) throw new Error('官方 Stripe 组件尚未接受原卡输入');
      const value = await result;
      if (!value?.ok)
        throw new Error('官方 Stripe SDK 未生成令牌：' + String(value?.reason || 'RESULT_MISSING'));
      return { id: value.id, lastFour: value.lastFour };
    } finally {
      abort.abort();
      values.number = '';
      values.expiry = '';
      values.cvc = '';
    }
  };
  private async cardFrame(signal?: AbortSignal) {
    const deadline = Date.now() + 20000;
    while (!this.disposed && !signal?.aborted && Date.now() < deadline) {
      const foundFrames: string[] = [];
      for (const session of [...this.frames]) {
        try {
          const found = await this.cdp!.evaluate(
            `location.hostname==='js.stripe.com'&&!!document.querySelector('input[name=number]')&&!!document.querySelector('input[name=expiry]')&&!!document.querySelector('input[name=cvc]')`,
            session,
            3000,
          );
          if (found) foundFrames.push(session);
        } catch {}
      }
      if (foundFrames.length > 1) throw new Error('检测到多个 Stripe 卡片框架，无法唯一绑定原卡输入');
      if (foundFrames.length === 1) return foundFrames[0];
      await delay(100);
    }
    throw new Error('官方 Stripe 安全收卡框架未就绪');
  }
  async close() {
    return (this.closing ||= (async () => {
      this.disposed = true;
      try {
        await this.cdp?.send('Browser.close', {}, undefined, 2000);
      } catch {}
      this.cdp?.close();
      this.host?.stdin.end();
      if (this.host && this.host.exitCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => this.host!.once('exit', () => resolve())),
          delay(6000),
        ]);
        if (this.host.exitCode === null) this.host.kill('SIGTERM');
      }
      await this.proxy?.close();
    })());
  }
}

export async function executeWithOnDemandSdk(
  assignment: Assignment,
  control: Control,
  transport: Transport,
  options: OnDemandSdkOptions = {},
  sentinel?: SentinelRuntimeOptions,
) {
  const sdk = new OnDemandSdkRuntime(assignment, options);
  try {
    // Original-payment reconciliation/cleanup must remain available even if
    // the configured Sentinel runtime is missing or invalid.
    let reference: SentinelAuthorizer | undefined;
    const authorize: SentinelAuthorizer = async (request) => {
      if (sentinel?.mode === 'reference')
        return (reference ||= createReferenceSentinelAuthorizer(assignment.context, sentinel))(request);
      if (sentinel && sentinel.mode !== 'official') throw new Error('不支持的 Sentinel 运行模式');
      return sdk.authorize(request);
    };
    await new ProtocolEngine(
      assignment,
      control,
      transport,
      assignment.demo ? undefined : (request) => withSdkLease(assignment, control, () => authorize(request)),
      assignment.demo
        ? undefined
        : (request, card) => withSdkLease(assignment, control, () => sdk.prepareStripeToken(request, card)),
    ).execute();
  } finally {
    await sdk.close();
  }
}

export async function withSdkLease<T>(
  assignment: Assignment,
  control: Control,
  action: () => Promise<T>,
): Promise<T> {
  let pending = Promise.resolve(),
    failure: Error | undefined;
  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        await control.request('checkpoint', {
          context: assignment.context,
          stage: assignment.context.phase || 'official_sdk',
        });
      })
      .catch((error) => {
        failure = error;
      });
  }, 30000);
  timer.unref();
  try {
    const result = await action();
    await pending;
    if (failure) throw failure;
    return result;
  } finally {
    clearInterval(timer);
  }
}
