import type { CardFilter, CardView } from './domain.js';

// Compare provider balances without floating point or rounding at a filter boundary.
function units(value: string) {
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw new Error('余额格式无效');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, '0'));
}
export function cardFilterError(filter: CardFilter = {}): string {
  if (filter.bin && !/^\d{1,8}$/.test(filter.bin)) return '卡头须为 1–8 位数字';
  for (const value of [filter.minBalance, filter.maxBalance])
    if (value && !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return '筛选余额须为非负金额，最多两位小数';
  if (filter.minBalance && filter.maxBalance && units(filter.minBalance) >= units(filter.maxBalance))
    return '余额上限须大于下限';
  if ((filter.note?.length || 0) > 500) return '备注筛选最多 500 字';
  return '';
}
export function hasCardFilter(filter: CardFilter = {}) {
  return !!(
    filter.bin ||
    filter.minBalance ||
    filter.maxBalance ||
    filter.note ||
    filter.hasNote !== undefined
  );
}
export function matchesCardFilter(card: CardView, filter: CardFilter = {}): boolean {
  if (cardFilterError(filter)) return false;
  if (filter.bin && !card.bin.startsWith(filter.bin)) return false;
  const note = card.note.trim();
  if (filter.hasNote !== undefined && Boolean(note) !== filter.hasNote) return false;
  if (filter.note && !note.toLocaleLowerCase().includes(filter.note.trim().toLocaleLowerCase())) return false;
  try {
    if (filter.minBalance && units(card.availableBalance) <= units(filter.minBalance)) return false;
    if (filter.maxBalance && units(card.availableBalance) >= units(filter.maxBalance)) return false;
  } catch {
    return false;
  }
  return true;
}
export function cardLabel(card: CardView) {
  return `${card.bin || '未知卡头'} · •••• ${card.lastFour || '----'} · #${card.cardId} · ${card.availableBalance} ${card.currency}${card.allocatableBalance !== undefined ? ' · 可分配 ' + card.allocatableBalance : ''} · ${card.productCode}${card.note ? ' · ' + card.note : ''}${card.bindings?.length ? ' · ' + card.bindings.length + ' 单预留' : card.heldBy ? ' · 订单预留' : card.pendingOperation ? ' · 资金待确认' : ''}`;
}
