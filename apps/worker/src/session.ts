import type { RuntimeContext } from '../../../packages/core/src/domain.js';
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
  context.session = session;
  context.accountId = session.account?.id || session.account?.account_id;
  context.userId = session.user?.id;
  if (Array.isArray(session.cookies))
    context.environment.cookies = session.cookies
      .filter(
        (c: any) =>
          c.name &&
          c.value &&
          ['chatgpt.com', 'auth.openai.com'].includes(String(c.domain || 'chatgpt.com').replace(/^\./, '')),
      )
      .map((c: any) => ({ ...c, domain: c.domain || 'chatgpt.com' }));
  const token = session.sessionToken || session.session_token;
  if (token)
    for (const prefix of ['__Secure-next-auth.session-token', '__Secure-authjs.session-token']) {
      const chunks = Math.ceil(token.length / 3800);
      for (let i = 0; i < chunks; i++)
        context.environment.cookies.push({
          name: prefix + (chunks > 1 ? '.' + i : ''),
          value: token.slice(i * 3800, (i + 1) * 3800),
          domain: 'chatgpt.com',
          path: '/',
          secure: true,
        });
    }
  context.environment.cookies.push({
    name: 'oai-did',
    value: context.environment.deviceId,
    domain: 'chatgpt.com',
    path: '/',
    secure: true,
  });
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
