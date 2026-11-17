import { isIP } from 'node:net';
import { AppError } from './security.js';

type EgressRequest = (input: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; data: any; body: string }>;

export async function inspectEgress(request: EgressRequest) {
  // Both checks use the same transport/session, so an explicit workflow proxy stays pinned.
  let primary: Awaited<ReturnType<EgressRequest>> | undefined;
  let primaryError: unknown;
  try {
    primary = await request({
      method: 'GET',
      url: 'https://ipapi.co/json/',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    const e = error as { code?: string; name?: string };
    if (e?.code === 'EXECUTION_ABORTED' || e?.code === 'TRANSPORT_CLOSED' || e?.name === 'AbortError')
      throw error;
    primaryError = error;
  }
  if (
    primary?.status === 200 &&
    isIP(primary.data?.ip || '') &&
    /^[A-Z]{2}$/.test(primary.data?.country_code || '')
  )
    return {
      ip: primary.data.ip as string,
      country: primary.data.country_code as string,
    };
  const fallback = await request({
    method: 'GET',
    url: 'https://chatgpt.com/cdn-cgi/trace',
    headers: { accept: 'text/plain' },
  });
  const values = new URLSearchParams(fallback.body.trim().split('\n').join('&'));
  const ip = values.get('ip') || '',
    country = values.get('loc') || '';
  if (
    fallback.status !== 200 ||
    values.get('h') !== 'chatgpt.com' ||
    !isIP(ip) ||
    !/^[A-Z]{2}$/.test(country)
  )
    throw Object.assign(
      new AppError(
        502,
        `无法确认网络出口（主查询${primary ? ' HTTP ' + primary.status : '未收到响应'}，备用查询 HTTP ${fallback.status}）`,
        'EGRESS_UNAVAILABLE',
      ),
      primaryError ? { cause: primaryError } : {},
    );
  return { ip, country };
}
