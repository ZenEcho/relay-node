import { randomUUID } from 'node:crypto';
import type { Environment } from '../../contracts/src/execution.js';
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
    },
  };
}
