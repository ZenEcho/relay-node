import { access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cookie } from '../../../../packages/contracts/src/execution.js';
import { assertReferenceSentinelReady } from './reference-sentinel.js';
import type { OnDemandSdkOptions, SentinelRuntimeOptions } from './runtime.js';
export function defaultSentinelRuntime(): SentinelRuntimeOptions {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('节点安装目录无效');
    root = parent;
  }
  return {
    mode: 'reference',
    bridgePath: join(root, 'runtime/reference-sentinel/sentinel_bridge.js'),
  };
}
export async function checkPaymentRuntime(
  options: OnDemandSdkOptions = {},
  sentinel: SentinelRuntimeOptions = defaultSentinelRuntime(),
) {
  if (sentinel?.mode === 'reference') await assertReferenceSentinelReady(sentinel);
  else if (sentinel?.mode === 'official') await findSdkBrowser(options.executablePath);
  else throw new Error('不支持的 Sentinel 运行模式');
}
export function sdkLoginCookies(cookies: Cookie[]) {
  // Import identity, not another browser's caches, tracking or temporary site
  // protection state. The official page establishes its own fresh site state.
  let login = cookies.filter(
    (c) =>
      c.domain.replace(/^\./, '') === 'chatgpt.com' &&
      /^(?:oai-did|__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?|(?:__Host-)?(?:next-auth|authjs)\.csrf-token)$/.test(
        c.name,
      ),
  );
  // Validated imports never contain both forms. A resumed native jar can keep
  // imported session-only chunks after the origin rotates to a persistent whole
  // cookie (or vice versa). Import only the provably newer complete generation.
  for (const prefix of ['__Secure-next-auth.session-token', '__Secure-authjs.session-token']) {
    const whole = login.filter((c) => c.name === prefix);
    const parts = login.filter((c) => c.name.startsWith(prefix + '.'));
    if (!whole.length || !parts.length) continue;
    const ordered = [...parts].sort(
      (a, b) => Number(a.name.slice(prefix.length + 1)) - Number(b.name.slice(prefix.length + 1)),
    );
    const complete = ordered.every((c, i) => c.name === prefix + '.' + i);
    if (whole.length !== 1 || !complete) throw new Error('登录 Cookie 轮换版本冲突，无法恢复本单浏览器');
    const same = ordered.map((c) => c.value).join('') === whole[0].value;
    const wholeExpires = whole[0].expires || 0;
    const partExpires = parts.map((c) => c.expires || 0);
    if (same || wholeExpires > Math.max(Date.now() / 1000, ...partExpires))
      login = login.filter((c) => !c.name.startsWith(prefix + '.'));
    else if (Math.min(...partExpires) > Math.max(Date.now() / 1000, wholeExpires))
      login = login.filter((c) => c.name !== prefix);
    else throw new Error('登录 Cookie 轮换版本冲突，无法恢复本单浏览器');
  }
  return login;
}
export async function findSdkBrowser(configured?: string) {
  const candidates = configured
    ? [configured]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  for (const path of candidates) {
    if (!path.startsWith('/')) continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  throw Object.assign(new Error('官方 SDK 环境需要 Chrome/Chromium，请安装或配置 officialSdk.executablePath'), {
    code: 'OFFICIAL_SDK_UNAVAILABLE',
  });
}
