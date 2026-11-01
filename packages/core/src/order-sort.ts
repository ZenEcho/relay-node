import type { CdkOrder } from './domain.js';

export type OrderSort = 'newest' | 'oldest';

export function normalizeOrderTime(value: string, timezoneOffset = '+08:00') {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + timezoneOffset
    : value;
}

export function orderTime(order: CdkOrder, fallback = '') {
  for (const value of [order.submittedAt, order.createdAt, fallback])
    if (typeof value === 'string' && Number.isFinite(Date.parse(normalizeOrderTime(value))))
      return normalizeOrderTime(value);
  return '';
}

export function compareTimes(a: string, b: string, sort: OrderSort) {
  const timestamp = (value: string) => Date.parse(normalizeOrderTime(value)) || 0;
  return (sort === 'oldest' ? 1 : -1) * (timestamp(a) - timestamp(b));
}

export function compareOrders(a: CdkOrder, b: CdkOrder, sort: OrderSort, fallbackA = '', fallbackB = '') {
  return compareTimes(orderTime(a, fallbackA), orderTime(b, fallbackB), sort) || a.id.localeCompare(b.id);
}
