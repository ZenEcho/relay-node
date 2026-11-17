export type CleanupPageRequest = {
  path: string;
  accountId: string;
  accessToken?: string;
  body?: Record<string, any>;
  headers?: Record<string, string>;
};

// Self-contained MAIN-world action. Only the original account's post-payment
// endpoints are available; redirects must never carry credentials off-origin.
export async function requestCleanupInPage(request: CleanupPageRequest) {
  const page = (globalThis as any).window;
  const target = new URL(request.path, 'https://chatgpt.com');
  const session = target.pathname === '/api/auth/session';
  const allowed = [
    '/api/auth/session',
    '/backend-api/accounts/check/v4-2023-04-27',
    '/backend-api/subscriptions',
    '/backend-api/subscriptions/cancel',
    '/backend-api/invoices',
    '/backend-api/payments/checkout_session',
  ];
  if (
    page?.location?.origin !== 'https://chatgpt.com' ||
    target.origin !== page.location.origin ||
    !allowed.includes(target.pathname) ||
    !request.accountId ||
    (!session && !request.accessToken) ||
    (target.searchParams.has('account_id') && target.searchParams.get('account_id') !== request.accountId) ||
    (request.body?.account_id && request.body.account_id !== request.accountId) ||
    (request.body &&
      !['/backend-api/subscriptions/cancel', '/backend-api/payments/checkout_session'].includes(
        target.pathname,
      ))
  )
    throw new Error('浏览器收尾请求与原账号或官方路径不一致');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-openai-target-path': target.pathname,
    'x-openai-target-route': target.pathname,
  };
  for (const name of ['x-openai-failed-access-token-iat'])
    if (request.headers?.[name]) headers[name] = request.headers[name];
  if (!session) {
    headers.authorization = 'Bearer ' + request.accessToken;
    headers['chatgpt-account-id'] = request.accountId;
  }
  if (request.body) headers['content-type'] = 'application/json';
  const response = await page.fetch(target.href, {
    method: request.body ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal: page.AbortSignal.timeout(20000),
    headers,
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('浏览器收尾接口未返回 JSON（HTTP ' + response.status + '）');
  }
  return { status: response.status, data };
}
