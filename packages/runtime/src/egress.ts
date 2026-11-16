import { isIP } from 'node:net';
import { AppError } from './security.js';

type EgressRequest = (input: {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; data: any; body: string }>;

export async function inspectEgress(request: EgressRequest) {
  // Both checks use the same transport/session, so an explicit workflow proxy stays pinned.
  const primary = await request({
    method: 'GET',
    url: 'https://ipapi.co/json/',
    headers: { accept: 'application/json' },
  });
  if (
    primary.status === 200 &&
    isIP(primary.data?.ip || '') &&
    /^[A-Z]{2}$/.test(primary.data?.country_code || '')
  )
    return { ip: primary.data.ip as string, country: primary.data.country_code as string };
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
    throw new AppError(
      502,
      `无法确认网络出口（主查询 HTTP ${primary.status}，备用查询 HTTP ${fallback.status}）`,
      'EGRESS_UNAVAILABLE',
    );
  return { ip, country };
}
