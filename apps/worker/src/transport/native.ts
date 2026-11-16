import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Environment } from '../../../../packages/contracts/src/execution.js';
import {
  nativeTransportErrorCode,
  transportDiagnostic,
  transportAttempt,
  transportTargetHost,
  type NativeTransportErrorCode,
  type TransportDiagnostic,
  type TransportAttempt,
} from '../../../../packages/runtime/src/transport-diagnostics.js';
export type {
  TransportDiagnostic,
  TransportAttempt,
} from '../../../../packages/runtime/src/transport-diagnostics.js';
export type TransportAttemptSink = (attempt: TransportAttempt) => void | Promise<void>;
export type HttpInput = {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
};
export type TransportRequestOptions = { onAttempt?: TransportAttemptSink };
export type HttpOutput = {
  status: number;
  headers: Record<string, string[]>;
  body: string;
  data: any;
  diagnostic?: TransportDiagnostic;
  transportAttempts?: TransportAttempt[];
};
export interface Transport {
  initialize(environment: Environment): Promise<void>;
  request(input: HttpInput, options?: TransportRequestOptions): Promise<HttpOutput>;
  close(): void;
}
const transportErrors: Record<string, string> = {
  UPSTREAM_READ_FAILED: '上游响应读取中断，日志保留已收到的响应片段',
  UPSTREAM_RESPONSE_TOO_LARGE: '上游响应超过 8 MiB，日志保留响应片段并标记不完整',
  PROXY_FORBIDDEN: '代理网关拒绝连接（HTTP 403），请检查使用代理的出口 IP 白名单、地区权限或额度',
  PROXY_AUTH_REQUIRED: '代理认证失败（HTTP 407 / SOCKS5），请检查账号密码和使用代理的出口 IP 白名单',
  PROXY_SOCKS_HTTP_RESPONSE:
    'SOCKS5 握手收到 HTTP 响应，可能是网关拒绝当前出口 IP 或端口协议不匹配，请检查代理访问限制及端口',
  PROXY_PROTOCOL_MISMATCH: '代理协议不匹配，请核对供应商提供的是 HTTP、HTTPS 还是 SOCKS5',
  UPSTREAM_TIMEOUT: '代理或目标服务连接超时，请检查网关可用性和网络',
  UPSTREAM_DNS_FAILED: '代理或目标服务域名解析失败',
  UPSTREAM_CONNECTION_FAILED: '代理或目标服务连接失败，请检查地址、端口和网关可用性',
  UPSTREAM_TLS_FAILED: '代理或目标服务 TLS 握手失败，请检查代理协议和证书',
  PROXY_CONNECT_FAILED: '代理网关未能建立目标连接，诊断记录包含 CONNECT 状态',
  UPSTREAM_CONNECTION_CLOSED: '代理或目标连接提前关闭，诊断记录保留已观察到的传输阶段',
  UPSTREAM_TRANSPORT_FAILED: '代理或目标服务传输失败',
  NATIVE_TRANSPORT_FAILED: '原生 HTTP 组件无法完成请求',
  NATIVE_TRANSPORT_TIMEOUT: '原生 HTTP 组件请求超时',
  TRANSPORT_CLOSED: '原生 HTTP 会话已关闭',
  TRANSPORT_NOT_READY: '原生 HTTP 组件未初始化',
  TRANSPORT_BUDGET_EXHAUSTED: '原生 HTTP 请求的有限重试时间已耗尽',
};
export class NativeTransportError extends Error {
  readonly code: NativeTransportErrorCode;
  readonly diagnostic?: TransportDiagnostic;
  transportAttempts?: TransportAttempt[];
  constructor(
    code: string,
    public httpResponse?: {
      status: number;
      headers: Record<string, string[]>;
      body: string;
      partial?: boolean;
    },
    diagnostic?: unknown,
  ) {
    const safeCode = nativeTransportErrorCode(code);
    super(transportErrors[safeCode]);
    this.name = 'NativeTransportError';
    this.code = safeCode;
    this.diagnostic = transportDiagnostic(diagnostic);
  }
}
export type NativeTransportOptions = {
  onAttempt?: TransportAttemptSink;
  /** A caller may shorten the bounded policy, never enlarge it. */
  retryBudgetMs?: number;
  retryDelaysMs?: readonly [number, number];
};
function bounded(value: number | undefined, maximum: number, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : maximum;
}
function retryable(input: HttpInput, error: NativeTransportError) {
  if (input.method !== 'GET' || input.body !== undefined || error.httpResponse) return false;
  if (
    ![
      'UPSTREAM_TIMEOUT',
      'UPSTREAM_CONNECTION_FAILED',
      'UPSTREAM_CONNECTION_CLOSED',
      'PROXY_CONNECT_FAILED',
    ].includes(error.code)
  )
    return false;
  const d = error.diagnostic;
  if (!d || d.requestWritten !== false || d.responseStarted !== false) return false;
  if (d.phase !== 'connect' && d.phase !== 'proxy_connect' && d.phase !== 'tls_handshake') return false;
  if (d.reason === 'proxy_status')
    return d.phase === 'proxy_connect' && [502, 503, 504].includes(d.proxyConnectStatus || 0);
  if (d.proxyConnectStatus !== undefined && d.proxyConnectStatus !== 200) return false;
  return [
    'timeout',
    'connection_refused',
    'connection_reset',
    'connection_closed',
    'unexpected_eof',
  ].includes(d.reason || '');
}
export class NativeTransport implements Transport {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (r: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private environment?: Environment;
  private generation = 0;
  private cancellation = new AbortController();
  // A reset of idle connections must not race another request in this helper.
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private binary: string,
    private options: NativeTransportOptions = {},
  ) {}
  async initialize(environment: Environment) {
    await access(this.binary);
    if (this.process) this.close();
    this.generation++;
    this.cancellation = new AbortController();
    this.queue = Promise.resolve();
    this.environment = environment;
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line),
          pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error)
          pending.reject(
            message.code
              ? new NativeTransportError(
                  message.code,
                  Number.isInteger(message.status) && message.status >= 100 && message.status <= 599
                    ? {
                        status: message.status,
                        headers: message.headers,
                        body: message.body,
                        partial: message.partial,
                      }
                    : undefined,
                  message.diagnostic,
                )
              : new NativeTransportError('NATIVE_TRANSPORT_FAILED'),
          );
        else pending.resolve(message);
      } catch {
        if (this.process === child) this.close();
      }
    });
    child.on('error', () => {
      if (this.process === child) {
        this.rejectAll(new NativeTransportError('NATIVE_TRANSPORT_FAILED'));
        this.process = undefined;
      }
    });
    child.on('exit', () => {
      if (this.process === child) {
        this.rejectAll(new NativeTransportError('NATIVE_TRANSPORT_FAILED'));
        this.process = undefined;
      }
    });
    child.stderr.resume();
    await this.rpc({
      method: 'initialize',
      profile: environment.profile,
      proxyUrl: environment.proxyUrl,
      cookies: environment.cookies,
    });
  }
  private rpc(payload: any, timeoutMs = 45000, timeoutCode = 'NATIVE_TRANSPORT_TIMEOUT'): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.process || this.cancellation.signal.aborted) {
        reject(new NativeTransportError('TRANSPORT_NOT_READY'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeTransportError(timeoutCode));
        this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new NativeTransportError('NATIVE_TRANSPORT_FAILED'));
      });
    });
  }
  request(input: HttpInput, options: TransportRequestOptions = {}): Promise<HttpOutput> {
    const generation = this.generation;
    const task = this.queue.then(() => this.performRequest(input, generation, options));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private active(generation: number) {
    if (generation !== this.generation || this.cancellation.signal.aborted)
      throw new NativeTransportError('TRANSPORT_CLOSED');
    if (!this.process || !this.environment) throw new NativeTransportError('TRANSPORT_NOT_READY');
  }
  private async performRequest(
    input: HttpInput,
    generation: number,
    options: TransportRequestOptions,
  ): Promise<HttpOutput> {
    this.active(generation);
    const started = Date.now(),
      requestId = randomUUID();
    const budget = bounded(this.options.retryBudgetMs, 90000, 1);
    const deadline = started + budget;
    const history: TransportAttempt[] = [];
    const sink = options.onAttempt || this.options.onAttempt;
    const emit = async (event: TransportAttempt) => {
      const safe = transportAttempt(event)!;
      if (sink) await sink(safe);
    };
    const fail = (error: NativeTransportError): never => {
      error.transportAttempts = history.map((event) => transportAttempt(event)!);
      throw error;
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.active(generation);
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail(new NativeTransportError('TRANSPORT_BUDGET_EXHAUSTED'));
      const attemptStart = Date.now();
      const base: TransportAttempt = {
        requestId,
        attemptId: randomUUID(),
        attempt,
        method: input.method,
        targetHost: transportTargetHost(input.url),
        outcome: 'running',
        startedAt: new Date(attemptStart).toISOString(),
        elapsedMs: 0,
        totalElapsedMs: attemptStart - started,
      };
      await emit(base);
      let response: any;
      try {
        this.active(generation);
        const requestRemaining = deadline - Date.now();
        if (requestRemaining <= 0) fail(new NativeTransportError('TRANSPORT_BUDGET_EXHAUSTED'));
        response = await this.rpc(
          {
            method: input.method,
            url: input.url,
            body: input.body,
            headers: { ...this.environment!.headers, ...input.headers },
          },
          Math.min(45000, requestRemaining),
          requestRemaining <= 45000 ? 'TRANSPORT_BUDGET_EXHAUSTED' : 'NATIVE_TRANSPORT_TIMEOUT',
        );
      } catch (caught) {
        const error =
          caught instanceof NativeTransportError
            ? caught
            : new NativeTransportError('NATIVE_TRANSPORT_FAILED');
        const delayMs =
          attempt < 3 ? bounded(this.options.retryDelaysMs?.[attempt - 1], attempt === 1 ? 500 : 1500) : 0;
        let stopReason =
          error.code === 'TRANSPORT_BUDGET_EXHAUSTED' || Date.now() + delayMs >= deadline
            ? 'budget_exhausted'
            : error.code === 'TRANSPORT_CLOSED' || generation !== this.generation
              ? 'closed'
              : !retryable(input, error)
                ? 'not_safe_to_retry'
                : attempt >= 3
                  ? 'attempt_limit'
                  : undefined;
        // Reset only the existing client's idle sockets. Its jar, proxy and TLS
        // profile remain frozen for this order, and POSTs never reach this RPC.
        if (!stopReason) {
          try {
            this.active(generation);
            const resetRemaining = deadline - Date.now();
            if (resetRemaining <= 0) stopReason = 'budget_exhausted';
            else await this.rpc({ method: 'reset_connections' }, Math.min(2000, resetRemaining));
          } catch {
            stopReason = Date.now() >= deadline ? 'budget_exhausted' : 'connection_reset_failed';
          }
        }
        const event: TransportAttempt = {
          ...base,
          outcome: stopReason ? 'failed' : 'retrying',
          completedAt: new Date().toISOString(),
          elapsedMs: Date.now() - attemptStart,
          totalElapsedMs: Date.now() - started,
          errorCode: error.code,
          diagnostic: error.diagnostic,
          ...(stopReason ? { retryStopReason: stopReason } : { retryDelayMs: delayMs }),
        };
        history.push(event);
        await emit(event);
        if (stopReason) fail(error);
        try {
          this.active(generation);
          if (Date.now() + delayMs >= deadline) throw new NativeTransportError('TRANSPORT_BUDGET_EXHAUSTED');
          await delay(delayMs, undefined, { signal: this.cancellation.signal });
          this.active(generation);
        } catch (interruption) {
          const stopped =
            interruption instanceof NativeTransportError
              ? interruption
              : new NativeTransportError('TRANSPORT_CLOSED');
          const final: TransportAttempt = {
            ...event,
            outcome: 'failed',
            retryDelayMs: undefined,
            retryStopReason: stopped.code === 'TRANSPORT_BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'closed',
            completedAt: new Date().toISOString(),
            totalElapsedMs: Date.now() - started,
          };
          history[history.length - 1] = final;
          await emit(final);
          fail(stopped);
        }
        continue;
      }
      if (response.cookies) this.environment!.cookies = response.cookies;
      let data: any = null;
      try {
        data = JSON.parse(response.body);
      } catch {}
      const diagnostic = transportDiagnostic(response.diagnostic);
      const event: TransportAttempt = {
        ...base,
        outcome: 'succeeded',
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - attemptStart,
        totalElapsedMs: Date.now() - started,
        diagnostic,
        httpStatus: response.status,
      };
      history.push(event);
      await emit(event);
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        data,
        diagnostic,
        transportAttempts: history.map((entry) => transportAttempt(entry)!),
      };
    }
    return fail(new NativeTransportError('TRANSPORT_BUDGET_EXHAUSTED'));
  }
  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.generation++;
    this.cancellation.abort();
    this.rejectAll(new NativeTransportError('TRANSPORT_CLOSED'));
    this.process?.kill();
    this.process = undefined;
  }
}
