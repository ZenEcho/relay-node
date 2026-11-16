import { runManager, selfTest } from './runtime/manager.js';
import { jsonFile } from './runtime/release.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
if (process.argv[2] === '--self-test') {
  await selfTest(process.argv[3]);
  console.log('节点安装包检查通过');
} else {
  const root = process.argv[2];
  const config = await jsonFile<any>(join(root, 'config.json'));
  if (!process.env.RELAY_NODE_CHILD && Object.keys(config.environment || {}).length) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root], {
      stdio: 'inherit',
      env: { ...process.env, ...config.environment, RELAY_NODE_CHILD: '1' },
    });
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } else await runManager(root);
}
