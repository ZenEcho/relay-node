import { randomUUID, randomInt } from 'node:crypto';
import type { CdkOrder, Environment, ProxyRule, Run, Workflow } from './domain.js';
import { plans } from './domain.js';
import { normalizeType, effectivePlan, orderCountry } from './catalog.js';
export { normalizeType, effectivePlan, orderCountry, matches } from './catalog.js';
import { AppError } from './security.js';
const profiles = ['146', '133', '131', '124', '120'];
export function createEnvironment(country: string, proxyUrl: string): Environment {
  const major = profiles[randomInt(profiles.length)],
    userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return {
    id: randomUUID(),
    profile: `chrome_${major}`,
    userAgent,
    country,
    proxyUrl,
    networkMode: proxyUrl ? 'proxy' : 'direct',
    deviceId: randomUUID(),
    stripeIds: {
      guid: randomUUID().replaceAll('-', ''),
      muid: randomUUID().replaceAll('-', ''),
      sid: randomUUID().replaceAll('-', ''),
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
export function selectProxy(rules: ProxyRule[], order: CdkOrder): ProxyRule {
  const candidates = rules.filter(
    (r) =>
      r.enabled &&
      (r.country === orderCountry(order) || r.country === 'AUTO') &&
      (!r.cdkCode || r.cdkCode === order.cdkCode) &&
      (!r.redeemType || normalizeType(r.redeemType) === normalizeType(order.cdkRedeemType)) &&
      (r.mode === 'api' ? Boolean(r.apiCipher || r.api?.url) : r.urls.length),
  );
  const score = (r: ProxyRule) => (r.cdkCode ? 3 : r.redeemType ? 2 : 1);
  candidates.sort(
    (a, b) =>
      score(b) - score(a) ||
      Number(b.country !== 'AUTO') - Number(a.country !== 'AUTO') ||
      a.id.localeCompare(b.id),
  );
  if (!candidates.length) throw new AppError(422, '该地区暂不支持充值', 'REGION_UNSUPPORTED');
  return candidates[0];
}
export function instantiateProxy(rule: ProxyRule, environmentId: string, country = rule.country) {
  if (country === 'AUTO') throw new AppError(422, '自动地区代理需要提供订单国家');
  const region = proxyRegionCode(rule.regionMap, country);
  const raw = rule.urls[rule.cursor % rule.urls.length]
    .replaceAll('{{session}}', environmentId.replaceAll('-', ''))
    .replaceAll('{{country}}', region.toLowerCase())
    .replaceAll('{{cdk_country}}', country);
  const u = new URL(raw);
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol))
    throw new AppError(400, '不支持的代理协议');
  return u.href;
}
export function proxyRegionCode(mapping: ProxyRule['regionMap'], country: string) {
  if (!/^[A-Z]{2}$/.test(country)) throw new AppError(422, '订单缺少有效的 CDK 支付地区');
  return mapping?.[country] || country;
}
export function selectWorkflowProxy(
  rules: ProxyRule[],
  workflow: Workflow,
  order: CdkOrder,
): ProxyRule | null {
  if (!workflow.proxyRuleId) return null;
  const rule = rules.find((r) => r.id === workflow.proxyRuleId);
  if (rule) {
    try {
      return selectProxy([rule], order);
    } catch {
      // A workflow's explicit selection must never fall back to another rule or local network.
    }
  }
  throw new AppError(
    422,
    '工作流指定代理不可用，请检查规则状态、地区及 CDK 筛选',
    'WORKFLOW_PROXY_UNAVAILABLE',
  );
}
export function canDispatch(run: Run, action: string) {
  if (run.stopping || run.status === 'stopped' || run.status === 'paused') return false;
  if (run.dispatches[action]) return false;
  return run.paymentOutcome !== 'succeeded' && run.paymentOutcome !== 'failed';
}
export function paymentPlan(id: string) {
  const plan = plans.find((p) => p.id === normalizeType(id));
  if (!plan) throw new AppError(422, '暂不支持此套餐');
  return plan;
}
export function money(value: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) throw new AppError(400, '金额须为最多两位小数的正数字符串');
  const [a, b = ''] = value.split('.');
  return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
}

export function providerMoney(value: string) {
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw new AppError(422, '卡台余额格式无法确认');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}
