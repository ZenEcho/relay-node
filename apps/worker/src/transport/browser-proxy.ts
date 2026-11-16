import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';

class Reader {
  private data = Buffer.alloc(0);
  private wake?: () => void;
  private error?: Error;
  private receive = (chunk: Buffer) => {
    this.data = Buffer.concat([this.data, chunk]);
    this.wake?.();
  };
  private failed = () => {
    this.error = new Error('SDK 代理连接中断');
    this.wake?.();
  };
  constructor(private socket: Socket) {
    socket.on('data', this.receive);
    socket.on('error', this.failed);
    socket.on('end', this.failed);
  }
  async take(length: number) {
    while (this.data.length < length) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const value = this.data.subarray(0, length);
    this.data = this.data.subarray(length);
    return value;
  }
  async headers() {
    while (this.data.indexOf('\r\n\r\n') < 0) {
      if (this.data.length > 32768) throw new Error('SDK 代理响应过大');
      await this.takeMore();
    }
    return this.take(this.data.indexOf('\r\n\r\n') + 4);
  }
  private async takeMore() {
    if (this.error) throw this.error;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }
  release() {
    this.socket.pause();
    this.socket.off('data', this.receive);
    this.socket.off('error', this.failed);
    this.socket.off('end', this.failed);
    if (this.data.length) this.socket.unshift(this.data);
  }
}

async function tunnel(proxy: URL, host: string, port: number, active: Set<Socket>) {
  const socket =
    proxy.protocol === 'https:'
      ? tlsConnect({
          host: proxy.hostname,
          port: Number(proxy.port || 443),
          servername: proxy.hostname,
        })
      : connect({
          host: proxy.hostname,
          port: Number(proxy.port || (proxy.protocol.startsWith('socks') ? 1080 : 80)),
        });
  active.add(socket);
  socket.on('close', () => active.delete(socket));
  socket.on('error', () => {});
  const timer = setTimeout(() => socket.destroy(new Error('SDK 代理超时')), 20000);
  const reader = new Reader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
    });
    const username = decodeURIComponent(proxy.username),
      password = decodeURIComponent(proxy.password);
    if (proxy.protocol.startsWith('socks')) {
      socket.write(Buffer.from(username ? [5, 2, 0, 2] : [5, 1, 0]));
      const method = await reader.take(2);
      if (method[0] !== 5 || ![0, 2].includes(method[1])) throw new Error('SOCKS5 握手失败');
      if (method[1] === 2) {
        const user = Buffer.from(username),
          pass = Buffer.from(password);
        if (!user.length || user.length > 255 || pass.length > 255)
          throw new Error('SOCKS5 认证配置无效');
        socket.write(
          Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
        );
        const auth = await reader.take(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS5 认证失败');
      }
      const address = Buffer.from(host),
        destination = Buffer.alloc(2);
      destination.writeUInt16BE(port);
      if (address.length > 255) throw new Error('SDK 目标主机无效');
      socket.write(
        Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, destination]),
      );
      const reply = await reader.take(4);
      if (reply[0] !== 5 || reply[1] !== 0) throw new Error('SOCKS5 目标连接被拒绝');
      if (reply[3] === 1) await reader.take(4);
      else if (reply[3] === 4) await reader.take(16);
      else if (reply[3] === 3) await reader.take((await reader.take(1))[0]);
      else throw new Error('SOCKS5 响应无效');
      await reader.take(2);
    } else {
      const destination = (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
      socket.write(
        'CONNECT ' +
          destination +
          ' HTTP/1.1\r\nHost: ' +
          destination +
          '\r\n' +
          (username
            ? 'Proxy-Authorization: Basic ' +
              Buffer.from(username + ':' + password).toString('base64') +
              '\r\n'
            : '') +
          '\r\n',
      );
      if (!/^HTTP\/1\.[01] 200\b/.test((await reader.headers()).toString()))
        throw new Error('HTTP 代理拒绝 SDK 连接');
    }
    reader.release();
    return socket;
  } catch {
    socket.destroy();
    throw new Error('本单代理无法建立官方 SDK 连接');
  } finally {
    clearTimeout(timer);
  }
}

// A short-lived authenticated loopback CONNECT bridge keeps upstream proxy
// credentials out of Chrome command arguments and supports SOCKS authentication.
// TLS stays end-to-end: the bridge never decrypts browser traffic.
export async function startSdkProxy(proxyValue: string) {
  const proxy = new URL(proxyValue);
  if (
    !['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) ||
    proxy.search ||
    proxy.hash ||
    (proxy.pathname && proxy.pathname !== '/')
  )
    throw new Error('本单 SDK 代理地址无效');
  const username = randomBytes(16).toString('hex'),
    password = randomBytes(24).toString('hex');
  const expected = Buffer.from(
    'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
  );
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => {
    const supplied = Buffer.from(request.headers['proxy-authorization'] || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Relay SDK"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    void (async () => {
      const destination = new URL('http://' + request.url);
      const port = Number(destination.port || 80),
        host = destination.hostname.replace(/^\[|\]$/g, '');
      if (
        destination.username ||
        destination.password ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        destination.pathname !== '/'
      )
        throw new Error();
      const upstream = await tunnel(proxy, host, port, sockets);
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    })().catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SDK 本机代理未启动');
  return {
    server: 'http://127.0.0.1:' + address.port,
    username,
    password,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
