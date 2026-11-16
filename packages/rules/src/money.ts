import { AppError } from './errors.js';
export function money(value: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))
    throw new AppError(400, '金额须为最多两位小数的正数字符串');
  const [a, b = ''] = value.split('.');
  return BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
}

export function providerMoney(value: string) {
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw new AppError(422, '卡台余额格式无法确认');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

// Round prices/minimums up; truncating a remote amount could underfund a card.
export function amountCents(value: string): bigint {
  if (!/^\d{1,9}(?:\.\d{1,12})?$/.test(value)) throw new Error('金额格式无效');
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * 100n +
    BigInt((fraction + '00').slice(0, 2)) +
    (/[1-9]/.test(fraction.slice(2)) ? 1n : 0n)
  );
}
export function centsAmount(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
