import type { StripeLocalCard } from '../../../../packages/contracts/src/stripe.js';
export function cardInputValues(card: StripeLocalCard | undefined, lastFour: string) {
  const number = String(card?.number || '').replace(/[ -]/g, ''),
    cvc = String(card?.cvc || '');
  const expiry = String(card?.expiry || '').match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (
    !/^\d{13,19}$/.test(number) ||
    !number.endsWith(lastFour) ||
    !/^\d{3,4}$/.test(cvc) ||
    !expiry ||
    Number(expiry[1]) < 1 ||
    Number(expiry[1]) > 12
  )
    throw new Error('本单官方 SDK 卡片资料不完整');
  return {
    number,
    cvc,
    expiry: expiry[1].padStart(2, '0') + expiry[2].slice(-2),
  };
}
