import type { RuntimeContext } from '../../../../packages/contracts/src/execution.js';
export function loadCredential(context: RuntimeContext) {
  if (context.session) return;
  const value = context.credential?.trim();
  if (!value || value === 'session验证失败') throw new Error('本单认证凭证缺失');
  let session: any;
  try {
    session = JSON.parse(value);
  } catch {
    session =
      value.includes('=') && !value.startsWith('eyJ')
        ? {
            cookies: value.split(';').map((part) => {
              const at = part.indexOf('=');
              return {
                name: part.slice(0, at).trim(),
                value: part.slice(at + 1).trim(),
                domain: 'chatgpt.com',
                path: '/',
                secure: true,
              };
            }),
          }
        : { accessToken: value.replace(/^Bearer\s+/i, '') };
  }
  if (Array.isArray(session)) session = { cookies: session };
  if (!session || typeof session !== 'object') throw new Error('本单 Session 格式无效');
  session.accessToken ||= session.access_token;
  if (Array.isArray(session.cookies))
    context.environment.cookies = session.cookies
      .filter(
        (c: any) =>
          c.name &&
          c.value &&
          ['chatgpt.com', 'auth.openai.com'].includes(
            String(c.domain || 'chatgpt.com').replace(/^\./, ''),
          ),
      )
      .map((c: any) => ({
        ...c,
        domain: c.domain || 'chatgpt.com',
        ...(Number.isFinite(c.expirationDate) ? { expires: Math.floor(c.expirationDate) } : {}),
      }));
  const chatCookies = context.environment.cookies.filter(
    (c) => c.domain.replace(/^\./, '') === 'chatgpt.com',
  );
  const deviceCookies = chatCookies.filter((c) => c.name === 'oai-did');
  const deviceIds = new Set(deviceCookies.map((c) => c.value));
  if (deviceIds.size > 1) throw new Error('Cookie 中存在冲突的设备标识，无法确认本单登录环境');
  if (deviceIds.size === 1) context.environment.deviceId = deviceCookies[0].value;
  // A Session export can carry the real browser device even without a Cookie
  // export. Keep it instead of generating a different identity for the SDK.
  // Explicit Cookie exports remain authoritative for their own generation.
  if (!deviceCookies.length && session.statsigContext?.deviceId !== undefined) {
    const deviceId = session.statsigContext.deviceId;
    if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId))
      throw new Error('Session 中的设备标识无效，无法确认本单登录环境');
    context.environment.deviceId = deviceId;
  }
  let importedSession = false;
  for (const prefix of ['__Secure-next-auth.session-token', '__Secure-authjs.session-token']) {
    const direct = chatCookies.filter((c) => c.name === prefix);
    const fragments = chatCookies.filter((c) => c.name.startsWith(prefix + '.'));
    if (direct.length > 1 || (direct.length && fragments.length))
      throw new Error('登录 Cookie 格式冲突，不能混用整段和分片凭证');
    if (fragments.length) {
      const indices = fragments.map((c) => c.name.slice(prefix.length + 1));
      if (
        indices.some((value) => !/^(0|[1-9]\d*)$/.test(value)) ||
        [...indices]
          .map(Number)
          .sort((a, b) => a - b)
          .some((value, index) => value !== index)
      )
        throw new Error('登录 Cookie 分片不完整，不能与 Session 中的其他版本混用');
    }
    importedSession ||= !!(direct.length || fragments.length);
  }
  const token = session.sessionToken || session.session_token;
  // An explicit Cookie export is one coherent credential set. Do not append
  // another generation of the login token from the accompanying Session JSON.
  if (token && !importedSession) {
    // A Session export has one login token, not two independent cookie
    // families. ChatGPT currently exports the next-auth family. Preserve an
    // explicitly supplied authjs family above, but never invent a duplicate:
    // it doubles every request's Cookie header and can conflict with refresh.
    const prefix = '__Secure-next-auth.session-token';
    const chunks = Math.ceil(token.length / 3800);
    for (let i = 0; i < chunks; i++)
      context.environment.cookies.push({
        name: prefix + (chunks > 1 ? '.' + i : ''),
        value: token.slice(i * 3800, (i + 1) * 3800),
        domain: 'chatgpt.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      });
  }
  if (!deviceCookies.length)
    context.environment.cookies.push({
      name: 'oai-did',
      value: context.environment.deviceId,
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
    });
  // Commit only after validation; a rejected import must not skip validation
  // on a later attempt through the early-return guard above.
  context.session = session;
  context.accountId = session.account?.id || session.account?.account_id;
  context.userId = session.user?.id;
}
export function verifySessionIdentity(context: RuntimeContext, session: any) {
  if (
    !session ||
    typeof session !== 'object' ||
    !String(session.accessToken || session.access_token || '').trim()
  )
    throw new Error('刷新响应缺少 accessToken，不能视为最新 Session');
  if (context.accountId && session.account?.id && context.accountId !== session.account.id)
    throw new Error('刷新后的账号与原订单不一致');
  if (context.userId && session.user?.id && context.userId !== session.user.id)
    throw new Error('刷新后的用户与原订单不一致');
}
