import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { availableParallelism } from 'node:os';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Cookie, RuntimeContext } from '../../../../packages/contracts/src/execution.js';
import type {
  SentinelAuthorizer,
  SentinelRequest,
} from '../../../../packages/contracts/src/sentinel.js';

export type ReferenceSentinelOptions = {
  // Pinned packaged runtime, or an explicitly configured trusted local bridge.
  bridgePath: string;
  version?: string;
  timeoutMs?: number;
};

const OUTPUT_LIMIT = 512 * 1024;
function failure(reason: string): Error {
  // Never include bridge output, arguments, credentials or its private path.
  return Object.assign(new Error('参考 Sentinel 授权未完成：' + reason), {
    code: 'SENTINEL_AUTH_REQUIRED',
  });
}
function validHeader(value: unknown): value is string {
  return (
    typeof value === 'string' && !!value.trim() && value.length <= 100000 && !/[\r\n\0]/.test(value)
  );
}
function header(context: RuntimeContext, name: string) {
  const entries = Object.entries(context.environment.headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (entries.some(([, value]) => value !== entries[0][1])) throw failure('PROFILE_BINDING');
  return entries[0]?.[1];
}
function platformFor(ua: string) {
  if (/Android/i.test(ua))
    return { platform: 'Linux armv8l', platformLabel: 'Android', maxTouchPoints: 1 };
  if (/iPhone|iPad|iPod/i.test(ua))
    return {
      platform: /iPad/.test(ua) ? 'iPad' : 'iPhone',
      platformLabel: 'iOS',
      maxTouchPoints: 1,
    };
  if (/Windows/i.test(ua))
    return { platform: 'Win32', platformLabel: 'Windows', maxTouchPoints: 0 };
  if (/Macintosh|Mac OS X/i.test(ua))
    return { platform: 'MacIntel', platformLabel: 'macOS', maxTouchPoints: 0 };
  if (/Linux|X11/i.test(ua))
    return { platform: 'Linux x86_64', platformLabel: 'Linux', maxTouchPoints: 0 };
  throw failure('PROFILE_BINDING');
}
function matchesPath(path: string, cookiePath: string) {
  return (
    path === cookiePath ||
    (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'))
  );
}
function cookieHeader(cookies: Cookie[], page: URL, deviceId: string) {
  const selected = cookies
    .filter((cookie) => {
      const domain = String(cookie.domain || '')
        .replace(/^\./, '')
        .toLowerCase();
      const path = cookie.path || '/';
      return (
        domain === page.hostname &&
        path.startsWith('/') &&
        matchesPath(page.pathname, path) &&
        (!cookie.secure || page.protocol === 'https:') &&
        (cookie.expires === undefined ||
          cookie.expires === 0 ||
          cookie.expires === -1 ||
          (Number.isFinite(cookie.expires) && cookie.expires > Date.now() / 1000))
      );
    })
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length);
  for (const cookie of selected) {
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) ||
      typeof cookie.value !== 'string' ||
      /[\x00-\x20\x7f;]/.test(cookie.value)
    )
      throw failure('COOKIE_BINDING');
    if (cookie.name === 'oai-did' && cookie.value !== deviceId) throw failure('COOKIE_BINDING');
  }
  if (!selected.some((cookie) => cookie.name === 'oai-did'))
    selected.push({ name: 'oai-did', value: deviceId, domain: page.hostname });
  const value = selected.map((cookie) => cookie.name + '=' + cookie.value).join('; ');
  if (Buffer.byteLength(value) > 100000) throw failure('COOKIE_BINDING');
  return value;
}
function bound(context: RuntimeContext, request: SentinelRequest) {
  const environment = context.environment;
  if (
    !request ||
    !context.accountId ||
    request.accountId !== context.accountId ||
    request.environmentId !== environment.id ||
    request.deviceId !== environment.deviceId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.deviceId) ||
    request.observerFlow !== 'chatgpt_checkout' ||
    !['chatgpt_checkout', 'checkout_session_approval'].includes(request.flow)
  )
    throw failure('IDENTITY_BINDING');
  if (
    (context.session?.account?.id && context.session.account.id !== context.accountId) ||
    (context.session?.account?.account_id &&
      context.session.account.account_id !== context.accountId)
  )
    throw failure('IDENTITY_BINDING');
  let page: URL;
  try {
    page = new URL(request.pageUrl);
  } catch {
    throw failure('PAGE_BINDING');
  }
  if (page.origin !== 'https://chatgpt.com' || page.username || page.password || page.hash)
    throw failure('PAGE_BINDING');
  return page;
}

async function runBridge(path: string, input: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let result = '',
      outputBytes = 0,
      stopping = false,
      finished = false,
      reason: Error | undefined;
    const decoder = new StringDecoder('utf8');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, SENTINEL_CURL_DAEMON_DIR: ' ' };
    delete env.SENTINEL_DAEMON_SOCKET;
    delete env.SENTINEL_CURL_DAEMON_SOCKET;
    const child = spawn(process.execPath, [path], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env,
    });
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = (error: Error) => {
      if (finished || stopping) return;
      reason = error;
      stopping = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
    };
    const timer = setTimeout(() => stop(failure('TIMEOUT')), timeoutMs);
    const complete = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Reference transports can launch a helper; reap any remaining process
      // group members after the one-shot bridge exits as well as on timeout.
      kill('SIGKILL');
      if (error) reject(error);
      else {
        result += decoder.end();
        try {
          resolve(JSON.parse(result));
        } catch {
          reject(failure('OUTPUT_INVALID'));
        }
      }
      result = '';
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) stop(failure('OUTPUT_LIMIT'));
      else if (!stopping) result += decoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT) stop(failure('OUTPUT_LIMIT'));
    });
    child.stdin.on('error', () => stop(failure('BRIDGE_IO')));
    child.once('error', () => complete(failure('BRIDGE_START')));
    child.once('close', (code, signal) =>
      complete(reason || (code !== 0 || signal ? failure('BRIDGE_EXIT') : undefined)),
    );
    child.stdin.end(JSON.stringify(input));
  });
}

function validToken(value: unknown, request: SentinelRequest, kind: 'p' | 'so'): value is string {
  if (!validHeader(value)) return false;
  try {
    const token = JSON.parse(value);
    return (
      token &&
      typeof token === 'object' &&
      !Array.isArray(token) &&
      typeof token[kind] === 'string' &&
      !!token[kind].trim() &&
      (kind !== 'p' || !token.p.startsWith('gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D')) &&
      typeof token.c === 'string' &&
      !!token.c.trim() &&
      token.id === request.deviceId &&
      token.flow === request.flow
    );
  } catch {
    return false;
  }
}

function configuration(options: ReferenceSentinelOptions) {
  const bridgePath = options?.bridgePath;
  const version = options?.version ?? '20260810913b';
  const timeoutMs = options?.timeoutMs ?? 120000;
  if (
    typeof bridgePath !== 'string' ||
    !isAbsolute(bridgePath) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(version) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000
  )
    throw failure('CONFIGURATION');
  return { bridgePath, version, timeoutMs };
}

export async function assertReferenceSentinelReady(
  options: ReferenceSentinelOptions,
): Promise<void> {
  const { bridgePath } = configuration(options);
  try {
    await access(bridgePath, constants.R_OK);
    if (!(await stat(bridgePath)).isFile()) throw new Error();
  } catch {
    throw failure('BRIDGE_UNAVAILABLE');
  }
}

export function createReferenceSentinelAuthorizer(
  context: RuntimeContext,
  options: ReferenceSentinelOptions,
): SentinelAuthorizer {
  const { bridgePath, version, timeoutMs } = configuration(options);
  return async (request) => {
    request = Object.freeze({ ...request });
    const page = bound(context, request);
    const environment = context.environment;
    const ua = environment.userAgent;
    if (!validHeader(ua) || (header(context, 'user-agent') && header(context, 'user-agent') !== ua))
      throw failure('PROFILE_BINDING');
    const platform = platformFor(ua);
    const expectedPlatform = header(context, 'sec-ch-ua-platform')?.replace(/^"|"$/g, '');
    if (expectedPlatform && expectedPlatform !== platform.platformLabel)
      throw failure('PROFILE_BINDING');
    const language = (header(context, 'accept-language') || 'en-US')
      .split(',')[0]
      .split(';')[0]
      .trim();
    if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(language)) throw failure('PROFILE_BINDING');
    const proxy = environment.proxyUrl;
    if (environment.networkMode === 'proxy' && !proxy) throw failure('PROFILE_BINDING');
    if (proxy) {
      try {
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(proxy).protocol))
          throw new Error();
      } catch {
        throw failure('PROFILE_BINDING');
      }
    }
    const binding = {
      environmentId: environment.id,
      deviceId: environment.deviceId,
      accountId: context.accountId,
      ua,
      proxy,
      profile: environment.profile,
      headers: JSON.stringify(environment.headers),
    };
    const cookies = cookieHeader(environment.cookies, page, request.deviceId);
    const output: any = await runBridge(
      bridgePath,
      {
        ua,
        deviceId: request.deviceId,
        flow: request.flow,
        pageUrl: page.href,
        proxy,
        cookieHeader: cookies,
        version,
        language,
        ...platform,
        sentinelOrigin: page.origin,
        cores: availableParallelism(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      timeoutMs,
    );
    bound(context, request);
    if (
      context.environment !== environment ||
      environment.id !== binding.environmentId ||
      environment.deviceId !== binding.deviceId ||
      context.accountId !== binding.accountId ||
      environment.userAgent !== binding.ua ||
      environment.proxyUrl !== binding.proxy ||
      environment.profile !== binding.profile ||
      JSON.stringify(environment.headers) !== binding.headers ||
      cookieHeader(environment.cookies, page, request.deviceId) !== cookies
    )
      throw failure('IDENTITY_CHANGED');
    if (
      !output ||
      typeof output !== 'object' ||
      output.error ||
      !validToken(output.main, request, 'p')
    )
      throw failure('MAIN_INVALID');
    if (
      output.so !== undefined &&
      output.so !== null &&
      output.so !== '' &&
      !validToken(output.so, request, 'so')
    )
      throw failure('OBSERVER_INVALID');
    const issuedAt = Date.now();
    return {
      ...request,
      token: output.main,
      ...(validHeader(output.so) ? { soToken: output.so } : {}),
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 60000).toISOString(),
    };
  };
}
