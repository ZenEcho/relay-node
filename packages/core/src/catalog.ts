import type { CdkOrder, Workflow } from './domain.js';
import { plans } from './domain.js';
export function normalizeType(type: string) {
  return type === 'gpt_rro_5x' ? 'gpt_pro_5x' : type;
}
export function effectivePlan(order: CdkOrder): string {
  if (Object.hasOwn(order, 'cdkPaymentRedeemType') && order.cdkPaymentRedeemType === null) return '';
  const descriptor = order.cdkPaymentPlan as any;
  if (descriptor?.provider && descriptor.provider !== 'chatgpt') return '';
  const id = normalizeType(String(order.cdkPaymentRedeemType || order.cdkRedeemType));
  if (plans.some((p) => p.id === id)) return id;
  return descriptor?.provider === 'chatgpt'
    ? (
        {
          go: 'gpt_go',
          plus: 'gpt_plus',
          pro_5x: 'gpt_pro_5x',
          pro_20x: 'gpt_pro_20x',
          pro_max: 'gpt_pro_max',
        } as Record<string, string>
      )[descriptor.plan] || ''
    : '';
}
export function orderCountry(order: CdkOrder) {
  const explicit = String(order.cdkPaymentCountry || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(explicit) ? explicit : '';
}
export function matches(workflow: Workflow, order: CdkOrder) {
  return (
    effectivePlan(order) === workflow.plan &&
    (!workflow.redeemTypes.length ||
      workflow.redeemTypes.some((x) => normalizeType(x) === normalizeType(order.cdkRedeemType))) &&
    !!orderCountry(order) &&
    (!workflow.countries.length || workflow.countries.includes(orderCountry(order))) &&
    (!workflow.ownerIds.length ||
      workflow.ownerIds.includes(String(order.cdkOwnerAdminId || order.ownerAdminId || '')))
  );
}
