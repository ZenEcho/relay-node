import { randomInt, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { RuntimeContext } from '../../../packages/core/src/domain.js';
const encode = (value: any) => Buffer.from(JSON.stringify(value)).toString('base64');
function hash(input: string) {
  let h = 2166136261;
  for (const c of input) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, '0');
}
function config(context: RuntimeContext) {
  const performance = randomInt(1000, 50000);
  return [
    '1920x1080',
    new Date().toUTCString(),
    4294705152,
    1,
    context.environment.userAgent,
    'https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js',
    null,
    null,
    'en-US',
    5,
    Math.random(),
    'permissions−undefined',
    'location',
    'Object',
    performance,
    randomUUID(),
    '',
    8,
    Date.now() - performance,
  ];
}
export async function sentinelToken(
  context: RuntimeContext,
  request: (path: string, body: any, headers?: Record<string, string>) => Promise<any>,
) {
  const data = config(context),
    requirements = 'gAAAAAC' + encode(data),
    flow = 'checkout_session_approval';
  const response = await request(
    '/backend-api/sentinel/req',
    { p: requirements, id: context.environment.deviceId, flow },
    {
      'content-type': 'text/plain;charset=UTF-8',
      referer: 'https://chatgpt.com/backend-api/sentinel/frame.html',
    },
  );
  if (!response.token) throw new Error('Sentinel 响应缺少 token');
  if (response.turnstile?.required || response.captcha?.required)
    throw new Error('当前 Sentinel 要求页面验证，HTTP 环境未取得有效认证');
  let proof = requirements;
  if (response.proofofwork?.required) {
    const { seed, difficulty = '0' } = response.proofofwork;
    const started = Date.now();
    let found = false;
    for (let i = 0; i < 500000; i++) {
      data[3] = i;
      data[9] = Date.now() - started;
      const encoded = encode(data);
      if (hash(seed + encoded).slice(0, difficulty.length) <= difficulty) {
        proof = 'gAAAAAB' + encoded + '~S';
        found = true;
        break;
      }
      if (i % 5000 === 0) await setImmediate();
    }
    if (!found) throw new Error('Sentinel proof 超出计算预算');
  }
  return JSON.stringify({ p: proof, t: '', c: response.token, id: context.environment.deviceId, flow });
}
