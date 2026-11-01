export const proxyProtocols = ['http', 'https', 'socks5', 'socks5h'] as const;
export type ProxyProtocol = (typeof proxyProtocols)[number];
export class ProxyImportError extends Error {}
const invalid = () => new ProxyImportError('无法识别代理，请检查地址、端口和账号格式');

function address(value: string, protocol: ProxyProtocol) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match || /[\s/@?#\\%]/.test(match[1])) throw invalid();
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  return new URL(`${protocol}://${match[1]}:${port}`);
}
function withAuth(url: URL, value: string) {
  const colon = value.indexOf(':');
  if (colon < 1) throw invalid();
  // Plain provider formats contain literal credentials; URL setters escape them.
  url.username = encodeURIComponent(value.slice(0, colon));
  url.password = encodeURIComponent(value.slice(colon + 1));
  return url;
}
function normalize(url: URL) {
  if (
    !proxyProtocols.includes(url.protocol.slice(0, -1) as ProxyProtocol) ||
    !url.hostname ||
    (url.port !== '' && Number(url.port) < 1) ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash
  )
    throw invalid();
  if (!url.port && url.protocol.startsWith('socks5')) url.port = '1080';
  const credentials = [decodeURIComponent(url.username), decodeURIComponent(url.password)];
  if (credentials.some((value) => /[\x00-\x1f\x7f]/.test(value))) throw invalid();
  if (
    url.protocol.startsWith('socks5') &&
    credentials.some((value) => new TextEncoder().encode(value).length > 255)
  )
    throw new ProxyImportError('SOCKS5 用户名和密码各不能超过 255 字节');
  url.pathname = '/';
  // Keep order templates usable by instantiateProxy after URL normalization.
  return url.href.replace(/%7B%7B(country|session)%7D%7D/gi, '{{$1}}');
}

/** Parse text only; never execute commands or fetch a pasted extraction API. */
export function parseProxyImport(input: string, protocol: ProxyProtocol = 'http'): string {
  try {
    if (typeof input !== 'string' || input.length > 2000 || !proxyProtocols.includes(protocol))
      throw invalid();
    const raw = input.trim();
    if (!raw || /[\s<>\x00-\x1f\x7f]/.test(raw)) throw invalid();
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return normalize(new URL(raw));
    const candidates: string[] = [];
    const attempt = (parse: () => URL) => {
      try {
        candidates.push(normalize(parse()));
      } catch {
        /* Try another provider layout. */
      }
    };
    const flat = /^(\[[^\]]+\]|[^:]+):(\d+):([^:]+):(.*)$/.exec(raw);
    if (flat) attempt(() => withAuth(address(`${flat[1]}:${flat[2]}`, protocol), `${flat[3]}:${flat[4]}`));
    const firstAt = raw.indexOf('@'),
      lastAt = raw.lastIndexOf('@');
    if (firstAt > 0) {
      attempt(() => withAuth(address(raw.slice(0, firstAt), protocol), raw.slice(firstAt + 1)));
      attempt(() => withAuth(address(raw.slice(lastAt + 1), protocol), raw.slice(0, lastAt)));
    }
    if (!flat && firstAt < 0) attempt(() => address(raw, protocol));
    const unique = [...new Set(candidates)];
    if (unique.length > 1)
      throw new ProxyImportError('地址和账号顺序有歧义，请改用带协议的 username:password@host:port 格式');
    if (!unique.length) throw invalid();
    return unique[0];
  } catch (error) {
    if (error instanceof ProxyImportError) throw error;
    // URL errors may contain the entire input, including credentials.
    throw invalid();
  }
}

export function parseProxyList(input: string, protocol: ProxyProtocol = 'http'): string[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 100) throw new ProxyImportError('一次最多导入 100 条代理');
  return lines.map((line, index) => {
    try {
      return parseProxyImport(line, protocol);
    } catch (error) {
      throw new ProxyImportError(`第 ${index + 1} 行：${(error as Error).message}`);
    }
  });
}
