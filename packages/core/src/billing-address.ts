import type { Billing } from './domain.js';

export const usStates: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};
export const billingStateOptions = [
  { value: 'RANDOM', label: '随机美国州 · 每单随机详细地址' },
  ...Object.entries(usStates).map(([value, label]) => ({
    value,
    label: `${value} · ${label}${value === 'WY' ? '（默认）' : ''}`,
  })),
];
export const validBillingState = (state: string) => state === 'RANDOM' || Object.hasOwn(usStates, state);
export type AddressProfile = Omit<Billing, 'name' | 'email'>;
export const addressFingerprint = (address: AddressProfile) =>
  [address.country, address.state, address.city, address.line1, address.postalCode]
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Ported from checkout-autofill's country-address.ts. Missing house numbers are
// rejected here instead of synthesizing one as the older Wyoming policy did.
export function addressFromOsm(
  value: Record<string, string> | undefined,
  state: string,
): AddressProfile | null {
  if (!value || value.country_code?.toUpperCase() !== 'US') return null;
  const code =
    value['ISO3166-2-lvl4']?.replace(/^US-/, '') ||
    Object.keys(usStates).find((key) => [key, usStates[key]].includes(value.state));
  const road = value.road || value.pedestrian || value.residential;
  const city = value.city || value.town || value.municipality || value.village || value.hamlet;
  if (
    code !== state ||
    !value.house_number?.trim() ||
    !road?.trim() ||
    !city?.trim() ||
    !/^\d{5}(?:-\d{4})?$/.test(value.postcode || '')
  )
    return null;
  return {
    country: 'US',
    state,
    line1: `${value.house_number.trim()} ${road.trim()}`,
    city: city.trim(),
    postalCode: value.postcode,
    line2: '',
  };
}
