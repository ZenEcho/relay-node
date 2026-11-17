import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, chown } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Vault, digest } from '../../packages/runtime/src/security.js';

const exec = promisify(execFile);

test('recovery requires a stopped manager, backs up ciphertext and uploads only log receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-recovery-script-'));
  const received: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.equal(request.url, '/api/worker/logs');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer private-node-token');
    const value = JSON.parse(body);
    assert.match(
      value.step.traceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    received.push(value);
    response.end('{"ok":true}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    consoleUrl: 'http://127.0.0.1:' + (server.address() as any).port,
    token: 'private-node-token',
  };
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  await mkdir(join(root, 'audit'));
  const name = digest(config.consoleUrl + ':' + config.token).slice(0, 24) + '.sealed';
  const file = join(root, 'audit', name);
  const vault = new Vault(digest(config.token));
  const ciphertext = vault.seal([
    [
      'run-1:[CARD]a374-fb7f4267ebbf',
      {
        runId: 'run-1',
        lease: 'original-lease',
        queuedAt: new Date().toISOString(),
        step: { traceId: '[CARD]a374-fb7f4267ebbf', name: 'recovered', status: 'failed' },
      },
    ],
  ]);
  await writeFile(file, ciphertext, { mode: 0o600 });
  // Root-run maintenance must preserve a daemon-owned queue after atomic writes.
  if (process.getuid?.() === 0) await chown(file, 65534, 65534);
  const owner = await stat(file);
  await mkdir(join(root, 'manager.lock'));
  const command = () => exec(process.execPath, [resolve('scripts/recover-worker-logs.mjs'), '--root', root]);
  await assert.rejects(command(), /Stop the instance manager/);
  assert.equal(await readFile(file, 'utf8'), ciphertext);
  assert.equal(received.length, 0);
  await rm(join(root, 'manager.lock'), { recursive: true });
  const result = await command();
  assert.equal(received.length, 1);
  assert.equal(received[0].lease, 'original-lease');
  assert.deepEqual(vault.open(await readFile(file, 'utf8')), []);
  const recovered = await stat(file);
  assert.equal(recovered.uid, owner.uid);
  assert.equal(recovered.gid, owner.gid);
  assert.equal(recovered.mode & 0o777, 0o600);
  const backups = await readdir(join(root, 'audit-recovery'));
  assert.equal(backups.length, 1);
  const backup = join(root, 'audit-recovery', backups[0], name);
  assert.equal(await readFile(backup, 'utf8'), ciphertext);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal(result.stdout.includes('private-node-token'), false);
  assert.equal(result.stdout.includes('original-lease'), false);
});
