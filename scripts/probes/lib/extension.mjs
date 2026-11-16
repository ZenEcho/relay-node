import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareProbeExtension(directory, { name, official = false }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name,
      version: '0.0.1',
      permissions: ['scripting'],
      host_permissions: ['https://chatgpt.com/*'],
      background: { service_worker: 'worker.js', type: 'module' },
    }),
    { mode: 0o600 },
  );
  await copyFile(
    new URL('../reference-sentinel-probe-action.mjs', import.meta.url),
    join(directory, 'reference-sentinel.js'),
  );
  const imports = ["import { authorizeReferenceSentinelInPage } from './reference-sentinel.js';"];
  const bindings = ['globalThis.relayReferenceAuthorize = authorizeReferenceSentinelInPage;'];
  if (official) {
    await copyFile(
      new URL('../../../dist/apps/worker/src/browser/actions.js', import.meta.url),
      join(directory, 'browser-sentinel.js'),
    );
    imports.push("import { authorizeSentinelInPage } from './browser-sentinel.js';");
    bindings.push('globalThis.relaySdkAuthorize = authorizeSentinelInPage;');
  }
  await writeFile(join(directory, 'worker.js'), [...imports, ...bindings].join('\n') + '\n', { mode: 0o600 });
}
