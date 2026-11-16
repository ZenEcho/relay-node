import { access, constants } from 'node:fs/promises';
import type { Cookie } from '../../../../packages/contracts/src/execution.js';
import { assertReferenceSentinelReady } from './reference-sentinel.js';
import type { OnDemandSdkOptions, SentinelRuntimeOptions } from './runtime.js';
export async function checkPaymentRuntime(
  options: OnDemandSdkOptions = {},
  sentinel?: SentinelRuntimeOptions,
) {
  await findSdkBrowser(options.executablePath);
  if (sentinel?.mode === 'reference') await assertReferenceSentinelReady(sentinel);
  else if (sentinel && sentinel.mode !== 'official') throw new Error('不支持的 Sentinel 运行模式');
}
export function sdkLoginCookies(cookies: Cookie[]) {
  // Import identity, not another browser's caches, tracking or temporary site
  // protection state. The official page establishes its own fresh site state.
  return cookies.filter(
    (c) =>
      c.domain.replace(/^\./, '') === 'chatgpt.com' &&
      /^(?:oai-did|__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?|(?:__Host-)?(?:next-auth|authjs)\.csrf-token)$/.test(
        c.name,
      ),
  );
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
  throw new Error('按需官方 SDK 环境需要 Chrome/Chromium，请安装或配置 officialSdk.executablePath');
}
