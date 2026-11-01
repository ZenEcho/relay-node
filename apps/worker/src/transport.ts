import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Environment } from '../../../packages/core/src/domain.js';
export type HttpInput = {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
};
export type HttpOutput = { status: number; headers: Record<string, string[]>; body: string; data: any };
export interface Transport {
  initialize(environment: Environment): Promise<void>;
  request(input: HttpInput): Promise<HttpOutput>;
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
};
export class NativeTransportError extends Error {
  constructor(
    public code: string,
    public httpResponse?: {
      status: number;
      headers: Record<string, string[]>;
      body: string;
      partial?: boolean;
    },
  ) {
    super(transportErrors[code] || 'upstream transport failed');
  }
}
export class NativeTransport implements Transport {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private environment?: Environment;
  constructor(private binary: string) {}
  async initialize(environment: Environment) {
    await access(this.binary);
    this.environment = environment;
    this.process = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
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
                  message.status
                    ? {
                        status: message.status,
                        headers: message.headers,
                        body: message.body,
                        partial: message.partial,
                      }
                    : undefined,
                )
              : new Error(message.error),
          );
        else pending.resolve(message);
      } catch {
        this.close();
      }
    });
    this.process.on('error', () => this.rejectAll(new Error('原生 HTTP 组件无法启动')));
    this.process.on('exit', () => this.rejectAll(new Error('原生 HTTP 组件已退出')));
    this.process.stderr.resume();
    await this.rpc({
      method: 'initialize',
      profile: environment.profile,
      proxyUrl: environment.proxyUrl,
      cookies: environment.cookies,
    });
  }
  private rpc(payload: any): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('原生 HTTP 请求超时'));
        this.close();
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }
  async request(input: HttpInput) {
    const response = await this.rpc({
      ...input,
      headers: { ...this.environment!.headers, ...input.headers },
    });
    if (response.cookies) this.environment!.cookies = response.cookies;
    let data: any = null;
    try {
      data = JSON.parse(response.body);
    } catch {}
    return { ...response, data };
  }
  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.rejectAll(new Error('原生 HTTP 会话结束'));
    this.process?.kill();
    this.process = undefined;
  }
}
