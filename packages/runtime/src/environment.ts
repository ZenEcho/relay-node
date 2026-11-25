import { randomUUID } from 'node:crypto';
import type { Environment } from '../../contracts/src/execution.js';
// Wire order captured from a real Chrome 158 here (local HTTP/2 listener, XHR
// and cross-origin fetch): request-set headers first, then the browser block.
// Chrome's own sequence is not the classic alphabetical-looking one older
// fingerprint writeups describe and it shifts with the header set, so treat this
// as one plausible permutation — what actually matters is that it is never the
// lexicographic default the native helper would otherwise emit.
const CHROME_HEADER_ORDER = [
  'content-length',
  'sec-ch-ua-platform',
  'user-agent',
  'sec-ch-ua',
  'content-type',
  'sec-ch-ua-mobile',
  'accept',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'priority',
];
// Headers the caller sets (authorization, x-openai-*, oai-*) lead the batch in
// every capture. `content-length` never reaches the header map because the
// transport derives it from the body, but it still holds the first slot.
export function chromeHeaderOrder(names: string[]): string[] {
  const present = new Set(names.map((name) => name.toLowerCase()));
  present.add('content-length');
  const custom = [...present].filter((name) => !CHROME_HEADER_ORDER.includes(name)).sort();
  const ordered = CHROME_HEADER_ORDER.filter((name) => present.has(name));
  const browserBlock = ordered.indexOf('sec-ch-ua-platform');
  const head = browserBlock === -1 ? ordered.slice(0, 1) : ordered.slice(0, browserBlock);
  const tail = browserBlock === -1 ? ordered.slice(1) : ordered.slice(browserBlock);
  return [...head, ...custom, ...tail];
}
export function createEnvironment(country: string, proxyUrl: string): Environment {
  // Keep new environments on the newest profile supported by the transport.
  // Random legacy Chrome profiles can challenge the same valid credentials.
  const major = '146',
    userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return {
    id: randomUUID(),
    profile: `chrome_${major}`,
    userAgent,
    country,
    proxyUrl,
    networkMode: proxyUrl ? 'proxy' : 'direct',
    deviceId: randomUUID(),
    // Stripe.js stores its device identifiers as canonical UUIDs in
    // __stripe_mid/__stripe_sid and replays them verbatim. A bare 32-hex string
    // is not the same id, so the payment method would describe a device Stripe
    // has never seen even when the rest of the environment is unchanged.
    stripeIds: {
      guid: randomUUID(),
      muid: randomUUID(),
      sid: randomUUID(),
    },
    cookies: [],
    headers: {
      'user-agent': userAgent,
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      // Chrome 123+ always advertises zstd. Without it the claimed version and
      // the advertised codecs disagree, and the transport's own default is the
      // older "gzip, deflate, br".
      'accept-encoding': 'gzip, deflate, br, zstd',
      // Chrome sends this on every fetch/XHR; it is part of the observed batch.
      priority: 'u=1, i',
    },
  };
}
