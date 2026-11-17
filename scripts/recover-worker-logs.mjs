import { constants } from 'node:fs';
import { mkdir, readFile, copyFile, chmod, chown, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkerLogs } from '../dist/apps/worker/src/runtime/logs.js';
import { digest, Vault } from '../dist/packages/runtime/src/security.js';

const index = process.argv.indexOf('--root');
if (index < 0 || !process.argv[index + 1])
  throw new Error('Usage: node scripts/recover-worker-logs.mjs --root <stopped-instance>');
const root = resolve(process.argv[index + 1]);
if (
  await stat(join(root, 'manager.lock')).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  })
)
  throw new Error('Stop the instance manager before recovering its outbox');

const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const directory = join(root, 'audit');
const name = digest(config.consoleUrl + ':' + config.token).slice(0, 24) + '.sealed';
const file = join(directory, name);
const owner = await stat(file);
const original = await readFile(file, 'utf8');
const records = new Vault(digest(config.token)).open(original);
const backup = join(root, 'audit-recovery', new Date().toISOString().replaceAll(':', '-'));
await mkdir(backup, { recursive: true, mode: 0o700 });
await copyFile(file, join(backup, name), constants.COPYFILE_EXCL);
await chmod(join(backup, name), 0o600);

let accepted = 0;
const rejected = new Map();
const deadline = Date.now() + 8 * 60 * 1000;
const logs = new WorkerLogs(directory, config.consoleUrl, config.token, async (record) => {
  if (Date.now() >= deadline) throw new Error('Recovery time budget exhausted');
  // These are the only endpoints recovery can call. It never polls or runs orders.
  const response = await fetch(
    config.consoleUrl.replace(/\/$/, '') + '/api/worker/' + (record.runId ? 'logs' : 'node-logs'),
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
      body: JSON.stringify(record.runId ? record : { step: record.step }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(15000, Math.max(1, deadline - Date.now()))),
    },
  );
  await response.arrayBuffer();
  if (!response.ok) {
    rejected.set(response.status, (rejected.get(response.status) || 0) + 1);
    throw Object.assign(new Error('Log receipt rejected'), { status: response.status });
  }
  accepted++;
});
try {
  await logs.initialize();
  const restored = logs.pending;
  console.log(JSON.stringify({ backup, queuedBefore: records.length, queuedAfterRepair: restored }));
  for (
    let batch = 0;
    logs.pending && batch < Math.ceil(restored / 100) * 2 + 1 && Date.now() < deadline;
    batch++
  ) {
    const before = accepted;
    await logs.flush();
    console.log(
      JSON.stringify({
        batch: batch + 1,
        accepted,
        pending: logs.pending,
        rejected: Object.fromEntries(rejected),
      }),
    );
    if (accepted === before && rejected.size === 0) break;
  }
  console.log(JSON.stringify({ accepted, pending: logs.pending, backup }));
  if (logs.pending) process.exitCode = 1;
} finally {
  // Atomic replacement creates files as the maintenance user. Restore the
  // daemon's ownership even when recovery stops early or a receipt is rejected.
  await chown(file, owner.uid, owner.gid);
  await chmod(file, 0o600);
}
