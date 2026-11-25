import { isIP } from 'node:net';
import { AppError } from './security.js';

export type EgressRequestInput = {
  method: 'GET';
  url: string;
  headers: Record<string, string>;
};
export type EgressRequest = (
  input: EgressRequestInput,
) => Promise<{ status: number; data: any; body: string }>;

export type EgressSource = 'chatgpt.com' | 'cloudflare.com';
export type EgressObservation = { ip: string; country: string; source: EgressSource };

/**
 * Two independent Cloudflare trace endpoints. The merchant trace is preferred
 * because it proves egress to the exact host the order will talk to; the
 * second endpoint only exists so one blocked or slow trace cannot hide a
 * working exit.
 */
export const egressProbeUrls = {
  primary: 'https://chatgpt.com/cdn-cgi/trace',
  fallback: 'https://www.cloudflare.com/cdn-cgi/trace',
};
const probes: { url: string; host: string; source: EgressSource }[] = [
  { url: egressProbeUrls.primary, host: 'chatgpt.com', source: 'chatgpt.com' },
  { url: egressProbeUrls.fallback, host: 'www.cloudflare.com', source: 'cloudflare.com' },
];

function fatal(error: unknown) {
  const e = error as { code?: string; name?: string };
  return e?.code === 'EXECUTION_ABORTED' || e?.code === 'TRANSPORT_CLOSED' || e?.name === 'AbortError';
}

function parseTrace(body: string, host: string) {
  const values = new URLSearchParams(String(body || '').trim().split('\n').join('&'));
  const ip = values.get('ip') || '',
    country = values.get('loc') || '';
  if (values.get('h') !== host || !isIP(ip) || !/^[A-Z]{2}$/.test(country)) return null;
  return { ip, country };
}

async function probe(request: EgressRequest, spec: (typeof probes)[number]) {
  const response = await request({
    method: 'GET',
    url: spec.url,
    headers: { accept: 'text/plain', 'cache-control': 'no-cache' },
  });
  const parsed = response.status === 200 ? parseTrace(response.body, spec.host) : null;
  if (!parsed)
    throw Object.assign(
      new AppError(
        502,
        `出口查询失败（${spec.host}${response.status && response.status !== 200 ? ' HTTP ' + response.status : ' 返回无效数据'}）`,
        'EGRESS_PROBE_REJECTED',
      ),
      { status: response.status },
    );
  return { ...parsed, source: spec.source };
}

function unavailable(cause: unknown) {
  return Object.assign(
    new AppError(502, '无法确认网络出口：两个出口查询都没有返回有效结果', 'EGRESS_UNAVAILABLE'),
    cause === undefined ? {} : { cause },
  );
}

/** Sequential fallback for callers with a single transport (e.g. proxy tests). */
async function sequential(request: EgressRequest): Promise<EgressObservation> {
  let primaryError: unknown;
  try {
    return await probe(request, probes[0]);
  } catch (error) {
    if (fatal(error)) throw error;
    primaryError = error;
  }
  try {
    return await probe(request, probes[1]);
  } catch (error) {
    if (fatal(error)) throw error;
    // A transport error from the fallback is the most specific fact we have.
    if (!(error instanceof AppError && error.code === 'EGRESS_PROBE_REJECTED')) throw error;
    throw unavailable(primaryError);
  }
}

/**
 * Run both probes at once and take the first valid answer. A fatal transport
 * state (abort/cancel) stops immediately; otherwise the loser is ignored and
 * its own request still settles in the background.
 */
function firstObservation(primary: Promise<EgressObservation>, secondary: Promise<EgressObservation>) {
  return new Promise<EgressObservation>((resolve, reject) => {
    const errors: unknown[] = [];
    let pending = 2,
      settled = false;
    const tasks = [primary, secondary];
    tasks.forEach((task, index) => {
      task.then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          if (fatal(error)) {
            settled = true;
            reject(error);
            return;
          }
          errors[index] = error;
          if (--pending > 0) return;
          settled = true;
          reject(unavailable(errors[0]));
        },
      );
    });
  });
}

export async function observeEgress(
  request: EgressRequest,
  secondary?: EgressRequest,
): Promise<EgressObservation> {
  if (!secondary) return sequential(request);
  // Both checks use the same environment/proxy; the caller owns the transports.
  return firstObservation(probe(request, probes[0]), probe(secondary, probes[1]));
}

export async function inspectEgress(request: EgressRequest, secondary?: EgressRequest) {
  const { ip, country } = await observeEgress(request, secondary);
  return { ip, country };
}
