// Accept only Intent fields observed on the original checkout request. Never
// search arbitrary nested objects (which may contain another subscription).
export function paymentIntentFromResponse(payload: any, original?: Record<string, any>) {
  const containers = [payload, payload?.checkout_session, payload?.payment_page].filter(
    (value) => value && typeof value === 'object',
  );
  const intents: Record<string, any>[] = [];
  const ids = new Set<string>();
  const secrets = new Set<string>();
  for (const container of containers) {
    for (const value of [
      container.payment_intent,
      container.error?.payment_intent,
      /^pi_[a-zA-Z0-9]+$/.test(container.id || '') ? container : undefined,
    ]) {
      if (typeof value === 'string' && /^pi_[a-zA-Z0-9]+$/.test(value)) ids.add(value);
      if (!value || typeof value !== 'object') continue;
      if (!/^pi_[a-zA-Z0-9]+$/.test(value.id || '')) throw new Error('原付款响应的 Intent 标识无效');
      ids.add(value.id);
      intents.push(value);
      if (value.client_secret) secrets.add(value.client_secret);
    }
    for (const secret of [container.client_secret, container.payment_intent_client_secret])
      if (typeof secret === 'string' && secret.startsWith('pi_')) secrets.add(secret);
  }
  if (!ids.size && !secrets.size) return;
  for (const secret of secrets) {
    if (!/^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(secret))
      throw new Error('原付款响应的 client_secret 无效');
    ids.add(secret.split('_secret_')[0]);
  }
  const id = [...ids][0];
  if (
    ids.size !== 1 || secrets.size > 1 ||
    (original?.id && original.id !== id) ||
    (original?.client_secret && secrets.size && !secrets.has(original.client_secret))
  ) throw new Error('付款响应不属于原 Intent');
  const intent = Object.assign({}, original, ...intents, { id });
  const secret = [...secrets][0] || original?.client_secret;
  if (secret) intent.client_secret = secret;
  if (!intents.some((value) => value.status)) {
    const status = containers.map((value) => value.payment_intent_status || value.payment_object_status)
      .find((value) => typeof value === 'string');
    if (status) intent.status = status;
  }
  if (!intents.some((value) => value.next_action !== undefined)) {
    const page = containers.find((value) => value.next_action !== undefined);
    if (page) intent.next_action = page.next_action;
  }
  return intent;
}

export function verificationSourceUrl(checkout: Record<string, any>) {
  if (checkout.id?.startsWith('cs_')) {
    if (checkout.url) {
      const url = new URL(checkout.url);
      if (url.username || url.password ||
        !['https://checkout.stripe.com', 'https://pay.openai.com'].includes(url.origin) ||
        !['/c/pay/' + checkout.id, '/pay/' + checkout.id].includes(url.pathname))
        throw new Error('客户验证地址不属于原 Hosted 结账');
      return url.origin + url.pathname;
    }
    return 'https://checkout.stripe.com/c/pay/' + checkout.id;
  }
  return 'https://chatgpt.com/checkout/' + checkout.processor_entity + '/' + checkout.id;
}
