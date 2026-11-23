// Read-only comparison of checkout-autofill's SDK call order. Runs only in
// the original account's real first-party document; no payment APIs are used.
export async function authorizeReferenceSentinelInPage(request) {
  let stage = 'page',
    mainPrepared = false,
    observerPrepared = false;
  const safe = () => ({ stage, mainPrepared, observerPrepared });
  const bounded = async (operation, timeout = 15000) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('TIMEOUT')), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const device = () => {
    const value = document.cookie
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('oai-did='));
    try {
      return value ? decodeURIComponent(value.slice(8)) : '';
    } catch {
      return '';
    }
  };
  const valid = (value) =>
    typeof value === 'string' && !!value.trim() && value.length <= 100000 && !/[\r\n]/.test(value);
  const session = async () => {
    const r = await fetch('/api/auth/session', {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('SESSION_HTTP_' + r.status);
    const value = await r.json();
    if (
      !(value.accessToken || value.access_token) ||
      value.account?.id !== request.accountId ||
      device() !== request.deviceId
    )
      throw new Error('SESSION_IDENTITY');
    return value;
  };
  try {
    if (
      location.origin !== 'https://chatgpt.com' ||
      location.href !== request.pageUrl ||
      !request.accountId ||
      !request.deviceId ||
      !['chatgpt_checkout', 'checkout_session_approval'].includes(request.flow)
    )
      throw new Error('PAGE_BINDING');
    stage = 'session_before';
    const before = await session();
    stage = 'sdk_load';
    if (typeof window.SentinelSDK?.token !== 'function')
      await bounded(
        () =>
          new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/backend-api/sentinel/sdk.js?no_universal_links=1';
            script.async = true;
            script.onload = () => {
              script.remove();
              resolve();
            };
            script.onerror = () => {
              script.remove();
              reject(new Error('SDK_LOAD'));
            };
            document.head.appendChild(script);
          }),
      );
    const until = Date.now() + 15000;
    const ready = () =>
      typeof window.SentinelSDK?.init === 'function' &&
      typeof window.SentinelSDK?.token === 'function' &&
      typeof window.SentinelSDK?.sessionObserverToken === 'function';
    while (!ready() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    const sdk = window.SentinelSDK;
    if (
      typeof sdk?.init !== 'function' ||
      typeof sdk?.sessionObserverToken !== 'function' ||
      typeof sdk?.token !== 'function'
    )
      throw new Error('SDK_UNAVAILABLE');
    stage = 'sdk_init';
    await bounded(() => sdk.init('chatgpt_checkout'));
    stage = 'sdk_observer';
    const observer = await bounded(() => sdk.sessionObserverToken('chatgpt_checkout'));
    observerPrepared = valid(observer);
    if (observer != null && observer !== '' && !observerPrepared) throw new Error('SDK_HEADER');
    stage = 'sdk_main';
    const token = await bounded(() => sdk.token(request.flow));
    mainPrepared = valid(token);
    if (!mainPrepared) throw new Error('SDK_HEADER');
    if (typeof sdk.timing === 'function') await bounded(() => sdk.timing(), 2000).catch(() => {});
    stage = 'session_after';
    const after = await session();
    if (before.user?.id !== after.user?.id) throw new Error('SESSION_IDENTITY');
    const now = Date.now();
    stage = 'complete';
    return {
      safe: safe(),
      authorization: {
        ...request,
        token,
        ...(observerPrepared ? { soToken: observer } : {}),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      },
    };
  } catch (error) {
    const reason = String(error?.message || '');
    return {
      safe: safe(),
      failureReason:
        /^(?:TIMEOUT|PAGE_BINDING|SESSION_HTTP_\d{3}|SESSION_IDENTITY|SDK_LOAD|SDK_UNAVAILABLE|SDK_HEADER)$/.test(
          reason,
        )
          ? reason
          : 'REFERENCE_SDK_FAILED',
    };
  }
}
