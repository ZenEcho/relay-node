import { UpstreamError } from './http-utils.js';

// gpt 官方建单接口自己决定这个账号能开哪种结账：只能 custom、只能 hosted，
// 或者两种都行。我们请求的 checkout_ui_mode 只是偏好，响应里的 checkout_ui_mode
// 和返回的会话前缀才是本单真实模式。强行按我们的偏好收单，官方那条链路可能不认。
export type CheckoutMode = 'custom' | 'hosted';

export function isCheckoutMode(value: unknown): value is CheckoutMode {
  return value === 'custom' || value === 'hosted';
}

/** 会话前缀是官方真实模式的旁证：oaics_ 一定是 custom，cs_ 一定是 hosted。 */
export function checkoutModeFromId(id: unknown): CheckoutMode | undefined {
  return typeof id === 'string' && /^oaics_[a-zA-Z0-9_-]+$/.test(id)
    ? 'custom'
    : typeof id === 'string' && /^cs_(?:live_|test_)?[a-zA-Z0-9_-]+$/.test(id)
      ? 'hosted'
      : undefined;
}

/**
 * 采纳官方返回的模式。会话前缀优先：hosted 建单的回包里 checkout_ui_mode 与 tag
 * 仍可能写 custom（官方模板回显旧值），而 Stripe 的确认接口只认会话本身
 * （oaics_ → custom，cs_ → hosted），信标签就会在 hosted 分支上误判"类型不匹配"。
 * 前缀读不出来才用声明字段，再读不出来保留请求值。
 * 返回值永远可以被信任来挑选前缀校验规则。
 */
export function adoptCheckoutMode(
  requested: CheckoutMode,
  returned: unknown,
  id?: unknown,
): { mode: CheckoutMode; official: boolean } {
  const mode = checkoutModeFromId(id) ?? (isCheckoutMode(returned) ? returned : undefined) ?? requested;
  return { mode, official: mode !== requested };
}

/**
 * 零元结账必须落在 custom（oaics_）支付页上。官方 hosted 页面按正常价收单，
 * 零元优惠不会生效，所以 0 元单出现在 hosted 上就是走错了路，应当停止而不是提交。
 */
export function zeroAmountRequiresCustom(mode: CheckoutMode, amount: number): boolean {
  return amount === 0 && mode !== 'custom';
}

/**
 * 建单被官方以“模式不支持”为由拒绝时，值得换另一种模式再试一次。
 * 其它 4xx/5xx（地区不可用、会话过期、网络错误）不属于模式问题，不能掩盖。
 */
export function isCheckoutModeRejection(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  if (![400, 403, 409, 422].includes(error.status)) return false;
  const data = error.data;
  const text = [
    typeof data?.detail === 'string' ? data.detail : '',
    typeof data?.error?.message === 'string' ? data.error.message : '',
    typeof data?.message === 'string' ? data.message : '',
    error.message,
  ]
    .join(' ')
    .toLowerCase();
  return /checkout_ui_mode|ui[_ ]mode|unsupported (checkout|ui)|checkout (ui )?mode/.test(text);
}

/**
 * 本单已经在上一种模式拒付过，官方这次又把模式钉回那个模式时，不要再开卡：
 * 模式互备已经没有可用分支，直接以清晰原因结束。
 */
export function modeFallbackBlocked(adopted: CheckoutMode, fallbackFrom: unknown): boolean {
  return isCheckoutMode(fallbackFrom) && adopted === fallbackFrom;
}
