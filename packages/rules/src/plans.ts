export const plans = [
  { id: 'gpt_go', label: 'Go', planName: 'chatgptgoplan' },
  { id: 'gpt_plus', label: 'Plus', planName: 'chatgptplusplan' },
  { id: 'gpt_pro_5x', label: 'Pro 5x', planName: 'chatgptprolite' },
  { id: 'gpt_pro_20x', label: 'Pro 20x', planName: 'chatgptpro' },
  { id: 'gpt_pro_max', label: 'Pro 500', planName: 'chatgptpromax' },
] as const;

import { AppError } from './errors.js';
export function normalizeType(type: string) {
  return type === 'gpt_rro_5x' ? 'gpt_pro_5x' : type;
}
export function paymentPlan(id: string) {
  const plan = plans.find((p) => p.id === normalizeType(id));
  if (!plan) throw new AppError(422, '暂不支持此套餐');
  return plan;
}
