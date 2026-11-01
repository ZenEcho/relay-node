import type { FundingQuote, Node, Workflow } from './domain.js';

export const orbitCardPlanIds: Record<string, string> = {
  gpt_go: 'go',
  gpt_plus: 'plus',
  gpt_pro_5x: 'pro',
  gpt_pro_20x: 'pro_20x',
  gpt_pro_max: 'pro_max',
};
export type OrbitCardProduct = {
  productCode: string;
  currency: string;
  bin: string;
  network: string;
  minInitialAmount: string;
  minRetainedBalance: string;
  remaining: number | null;
  inventoryMode: string;
  prices: Record<string, { amount: string; source: string; observedAt?: string }>;
};
// Round prices/minimums up; truncating a remote amount could underfund a card.
export function amountCents(value: string): bigint {
  if (!/^\d{1,9}(?:\.\d{1,12})?$/.test(value)) throw new Error('金额格式无效');
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) + (/[1-9]/.test(fraction.slice(2)) ? 1n : 0n)
  );
}
export function centsAmount(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
export function orbitCardProducts(payload: any): OrbitCardProduct[] {
  return (Array.isArray(payload?.list) ? payload.list : []).flatMap((item: any) => {
    const productCode = String(item.product_code || '').trim();
    if (!productCode) return [];
    const prices: OrbitCardProduct['prices'] = {};
    for (const [plan, id] of Object.entries(orbitCardPlanIds)) {
      const matches = (Array.isArray(item.gpt_plan_prices) ? item.gpt_plan_prices : []).filter(
        (price: any) => price.id === id && price.currency === 'USD',
      );
      if (matches.length !== 1) continue;
      const price = matches[0];
      try {
        const amount = amountCents(String(price.price));
        if (amount > 0n)
          prices[plan] = {
            amount: centsAmount(amount),
            source: String(price.source || 'remote'),
            observedAt: price.observed_at || price.updated_at || undefined,
          };
      } catch {
        /* Invalid quotes must never become guessed funding amounts. */
      }
    }
    const minimum = (value: unknown) => {
      try {
        return centsAmount(amountCents(String(value ?? '0')));
      } catch {
        return '';
      }
    };
    return [
      {
        productCode,
        currency: String(item.currency || 'USD').toUpperCase(),
        bin: String(item.bin || ''),
        network: String(item.network || ''),
        minInitialAmount: minimum(item.min_initial_amount),
        minRetainedBalance: minimum(item.min_retained_balance),
        remaining: item.remaining_open_card_num == null ? null : Number(item.remaining_open_card_num),
        inventoryMode: String(item.open_card_inventory_mode || ''),
        prices,
      },
    ];
  });
}
export function calculateFunding(
  workflow: Pick<Workflow, 'plan' | 'funding'>,
  products: OrbitCardProduct[],
  productCode: string,
): FundingQuote {
  const funding = workflow.funding;
  const mode = funding.mode || 'fixed';
  const product = products.find((item) => item.productCode === productCode);
  const count = funding.paymentCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('支付次数须为 1–100 的整数');
  if (product && product.currency !== 'USD') throw new Error('当前资金策略仅支持 USD 卡产品');
  const price = product?.prices[workflow.plan];
  if (mode === 'remote' && !price)
    throw new Error(
      `卡产品 ${productCode || '未选择'} 未返回此套餐的有效 USD 远程金额，请刷新产品或明确选择手动金额`,
    );
  const unit = amountCents(mode === 'remote' ? price!.amount : funding.amount);
  if (unit <= 0n) throw new Error('单次付款金额必须大于 0');
  const surplus = amountCents(funding.surplus || '0');
  const minimum = product ? amountCents(product.minInitialAmount) : 0n;
  const calculated = unit * BigInt(count) + surplus;
  return {
    mode,
    plan: workflow.plan,
    productCode,
    currency: 'USD',
    unitAmount: centsAmount(unit),
    paymentCount: count,
    surplus: centsAmount(surplus),
    requiredAmount: centsAmount(unit),
    calculatedAmount: centsAmount(calculated),
    openingAmount: centsAmount(calculated > minimum ? calculated : minimum),
    minInitialAmount: centsAmount(minimum),
    ...(mode === 'remote' ? { source: price!.source, observedAt: price!.observedAt } : {}),
  };
}
// A remote quote is an explicit import into the editable local amount.
export function importFundingAmount(
  workflow: Pick<Workflow, 'plan' | 'funding'>,
  products: OrbitCardProduct[],
  productCode: string,
  importedAt = new Date().toISOString(),
): Workflow['funding'] {
  const product = products.find((item) => item.productCode === productCode && item.currency === 'USD');
  const price = product?.prices[workflow.plan];
  if (!price)
    throw new Error(`卡产品 ${productCode || '未选择'} 未返回此套餐的有效 USD 金额，可直接填写本地金额`);
  return {
    ...workflow.funding,
    mode: 'fixed',
    amount: price.amount,
    reference: {
      plan: workflow.plan,
      productCode,
      currency: 'USD',
      amount: price.amount,
      source: price.source,
      observedAt: price.observedAt,
      importedAt,
    },
  };
}
export function nodeSupportsPlan(node: Pick<Node, 'allowedPlans'>, plan: string) {
  return !node.allowedPlans?.length || node.allowedPlans.includes(plan);
}
export function nodeSelectedForWorkflow(node: Pick<Node, 'id'>, workflow: Pick<Workflow, 'nodeIds'>) {
  return !workflow.nodeIds?.length || workflow.nodeIds.includes(node.id);
}
export function nodeSupportsWorkflow(
  node: Pick<Node, 'id' | 'allowedPlans'>,
  workflow: Pick<Workflow, 'nodeIds' | 'plan'>,
) {
  return nodeSelectedForWorkflow(node, workflow) && nodeSupportsPlan(node, workflow.plan);
}
