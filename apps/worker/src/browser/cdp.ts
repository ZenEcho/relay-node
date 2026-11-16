type Waiter = {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
export class SdkCdp {
  private sequence = 0;
  private pending = new Map<number, Waiter>();
  private listeners = new Set<(method: string, params: any, session?: string) => void>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      try {
        const value = JSON.parse(String(event.data));
        const waiting = this.pending.get(value.id);
        if (waiting) {
          clearTimeout(waiting.timer);
          this.pending.delete(value.id);
          if (value.error) waiting.reject(new Error('官方 SDK 浏览器操作失败'));
          else waiting.resolve(value.result);
        } else if (value.method) {
          for (const listener of this.listeners)
            listener(value.method, value.params, value.sessionId);
        }
      } catch {
        this.close();
      }
    });
    socket.addEventListener('close', () => this.fail());
    socket.addEventListener('error', () => this.fail());
  }
  static async connect(endpoint: string) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      !url.pathname.startsWith('/devtools/browser/')
    )
      throw new Error('SDK 浏览器调试端点无效');
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('SDK 浏览器连接超时'));
      }, 10000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('SDK 浏览器连接失败'));
        },
        { once: true },
      );
    });
    return new SdkCdp(socket);
  }
  on(listener: (method: string, params: any, session?: string) => void) {
    this.listeners.add(listener);
  }
  send(method: string, params: any = {}, sessionId?: string, timeout = 30000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN)
        return reject(new Error('SDK 浏览器连接已关闭'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SDK 浏览器操作超时'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async evaluate(expression: string, session: string, timeout = 30000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
      timeout,
    );
    // Never echo exception messages, expressions, arguments or remote objects:
    // the Input channel and local SDK arguments can contain card credentials.
    if (result.exceptionDetails) throw new Error('官方 SDK 页面执行失败');
    return result.result?.value;
  }
  private fail() {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('SDK 浏览器已退出'));
    }
    this.pending.clear();
  }
  close() {
    this.fail();
    this.socket.close();
  }
}
