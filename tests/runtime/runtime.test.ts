import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import {
  mkdtemp,
  mkdir,
  cp,
  writeFile,
  readFile,
  rm,
  symlink,
  readlink,
  stat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { saveJson, managementSocket } from '../../apps/worker/src/runtime/release.js';
const exec = promisify(execFile);
async function until(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Runtime condition timed out');
}
async function fixture(root: string) {
  const release = join(root, 'package');
  await mkdir(join(release, 'runtime/bin'), { recursive: true });
  await cp('dist', join(release, 'dist'), { recursive: true });
  await cp('bin', join(release, 'bin'), { recursive: true });
  await cp('install.sh', join(release, 'install.sh'));
  await writeFile(
    join(release, 'runtime/bin/node'),
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(join(release, 'VERSION'), '0.1.0\n');
  await saveJson(join(release, 'package.json'), { type: 'module' });
  await saveJson(join(release, 'manifest.json'), {
    version: '0.1.0',
    protocolVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
  });
  await writeFile(
    join(release, 'bin/relay-transport'),
    `#!/usr/bin/env node\nimport readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);console.log(JSON.stringify({id:message.id}));});\n`,
    { mode: 0o755 },
  );
  return release;
}
test('interactive entry works under sh and bash syntax', async () => {
  for (const shell of ['sh', 'bash'])
    for (const script of ['install.sh', 'bin/launcher.sh', 'bin/relay-node'])
      await exec(shell, ['-n', script]);
});
test('interactive installation hides credentials when stdin is redirected and reads from the controlling terminal', async () => {
  const root = await mkdtemp('/tmp/relay-terminal-');
  const upstream = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  try {
    const release = await fixture(root);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.1:' + (upstream.address() as any).port;
    const token = 'relaynode.test.node.terminal-secret';
    const python = String.raw`
import os, pty, select, signal, sys, time
node, cli, root, address, token = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    env = os.environ.copy()
    env.update(RELAY_NODE_HOME=root, RELAY_NODE_NO_SERVICE='1')
    env.pop('CONSOLE_URL', None)
    env.pop('NODE_TOKEN', None)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    os.execve(node, [node, cli, 'install'], env)
output = b''
prompts = [('实例名称 [main]：', 'manual'), ('控制台地址：', address), ('节点凭证（输入隐藏）：', token)]
index = 0
finished = False
try:
    deadline = time.time() + 30
    while time.time() < deadline:
        if select.select([master], [], [], .1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            if index < len(prompts) and prompts[index][0].encode() in output:
                os.write(master, (prompts[index][1] + '\n').encode())
                index += 1
    else:
        raise TimeoutError('interactive prompt timed out: ' + repr(output.replace(token.encode(), b'<hidden>')))
    _, status = os.waitpid(pid, 0)
    finished = True
    assert os.waitstatus_to_exitcode(status) == 0, 'installer did not complete'
    assert index == len(prompts), 'missing interactive prompt'
    assert token.encode() not in output, 'credential echoed to terminal'
    print('interactive installation completed without credential echo')
finally:
    if not finished:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
`;
    const base = join(root, 'instances');
    const result = await exec(
      'python3',
      [
        '-c',
        python,
        process.execPath,
        join(release, 'dist/apps/worker/src/cli.js'),
        base,
        address,
        token,
      ],
      { timeout: 45000 },
    );
    assert.match(result.stdout, /without credential echo/);
    assert.equal(JSON.parse(await readFile(join(base, 'manual/config.json'), 'utf8')).token, token);
    assert.equal((await stat(join(base, 'manual/config.json'))).mode & 0o777, 0o600);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test('install, menu commands, idle update, failed rebind and multiple instances work without source checkout', async (t) => {
  const root = await mkdtemp('/tmp/relay-runtime-');
  let launcher: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      const ended = new Promise<void>((resolve) => launcher!.once('exit', () => resolve()));
      launcher.kill('SIGTERM');
      await Promise.race([ended, delay(4000)]);
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const release = await fixture(root),
    base = join(root, 'instances with spaces');
  let control: any = { revision: 0, desiredState: 'running' },
    blockers: any[] = [];
  let heartbeats = 0,
    prepares = 0,
    reportedVersion = '';
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization?.endsWith('.invalid')) {
      response.statusCode = 401;
      response.end('{"message":"invalid credential"}');
      return;
    }
    if (request.url === '/api/worker/heartbeat') {
      heartbeats++;
      reportedVersion = body.version;
      response.end(JSON.stringify({ control, blockers, protocolVersion: 1 }));
    } else if (request.url === '/api/worker/poll') response.end('null');
    else if (request.url === '/api/worker/control') {
      control.revision++;
      if (body.action === 'pause') control.desiredState = 'paused';
      if (body.action === 'resume') control.desiredState = 'running';
      if (body.action === 'check_update')
        control.update = { id: body.requestId, phase: 'draining' };
      response.end(JSON.stringify({ control, blockers, protocolVersion: 1 }));
    } else if (request.url?.endsWith('/prepare')) {
      prepares++;
      control.update.phase = 'checking';
      response.end('{"ok":true}');
    } else if (request.url?.endsWith('/report')) {
      Object.assign(control.update, body);
      response.end('{"ok":true}');
    } else response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + (upstream.address() as any).port;
  const fetchMarker = join(root, 'release-check');
  const preload = join(root, 'fetch.cjs');
  const route = join(root, 'release-route.json');
  await saveJson(route, { release: { tag_name: 'v0.1.0', assets: [] } });
  await writeFile(
    preload,
    `const fs=require('node:fs');const original=global.fetch;global.fetch=async(url,options)=>{const value=String(url);if(value.startsWith('https://api.github.com/')){fs.writeFileSync(${JSON.stringify(fetchMarker)},'checked');return Response.json(JSON.parse(fs.readFileSync(${JSON.stringify(route)},'utf8')).release);}if(value.startsWith('https://github.com/ZenEcho/relay-node/releases/download/'))return new Response(fs.readFileSync(JSON.parse(fs.readFileSync(${JSON.stringify(route)},'utf8')).archive));return original(url,options);};`,
  );
  const env = {
    ...process.env,
    RELAY_NODE_HOME: base,
    RELAY_NODE_NO_SERVICE: '1',
    CONSOLE_URL: address,
    NODE_TOKEN: 'relaynode.tenant.node.original',
    NODE_OPTIONS: '--require=' + preload,
  };
  const cli = join(release, 'dist/apps/worker/src/cli.js');
  await exec(process.execPath, [cli, 'install', '--instance', 'one'], { env });
  await exec(process.execPath, [cli, 'install', '--instance', 'two'], {
    env: { ...env, NODE_TOKEN: 'relaynode.tenant.second.original' },
  });
  assert.equal((await stat(join(base, 'one/config.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(base, 'one/config.json'), 'utf8')).sentinel, {
    mode: 'reference',
    bridgePath: join(base, 'one/current/runtime/reference-sentinel/sentinel_bridge.js'),
  });
  launcher = spawn('sh', [join(base, 'one/launcher.sh'), join(base, 'one')], {
    env,
    stdio: 'ignore',
  });
  await until(
    async () =>
      heartbeats >= 3 &&
      (await stat(join(base, 'one/healthy')).then(
        () => true,
        () => false,
      )),
  );
  const run = (action: string) =>
    exec(process.execPath, [cli, '--instance', 'one', action], { env });
  await run('pause');
  await until(async () => control.desiredState === 'paused');
  const count = heartbeats;
  await until(async () => heartbeats > count);
  blockers = [{ id: 'original', status: 'awaiting_captcha' }];
  await run('check_update');
  await until(async () => control.update?.phase === 'draining');
  await delay(1800);
  assert.equal(prepares, 0);
  assert.equal(
    await stat(fetchMarker).then(
      () => true,
      () => false,
    ),
    false,
  );
  blockers = [];
  await until(async () => control.update?.phase === 'current');
  assert.equal(prepares, 1);
  assert.equal(control.desiredState, 'paused');
  const configBefore = await readFile(join(base, 'one/config.json'), 'utf8');
  await mkdir(join(base, 'one/audit'), { recursive: true });
  await writeFile(join(base, 'one/audit/preserved'), 'encrypted-queue-sentinel');
  async function candidate(version: string, broken = false) {
    const source = join(root, 'candidate-' + version);
    await cp(release, source, { recursive: true });
    await saveJson(join(source, 'manifest.json'), {
      version,
      protocolVersion: 1,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
    });
    await writeFile(join(source, 'VERSION'), version + '\n');
    if (broken)
      await writeFile(
        join(source, 'dist/apps/worker/src/entry.js'),
        "if(process.argv[2]==='--self-test')console.log('self test');else process.exit(2);",
      );
    const bytes = execFileSync('tar', ['-czf', '-', '-C', source, '.']);
    const archive = join(root, 'candidate-' + version + '.tar.gz');
    await writeFile(archive, bytes);
    const name = `relay-node-${version}-${process.platform}-${process.arch}.tar.gz`;
    await saveJson(route, {
      archive,
      release: {
        tag_name: 'v' + version,
        assets: [
          {
            name,
            digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            browser_download_url: `https://github.com/ZenEcho/relay-node/releases/download/v${version}/${name}`,
          },
        ],
      },
    });
  }
  await candidate('0.2.0');
  await run('check_update');
  await until(
    async () => control.update?.phase === 'completed' && reportedVersion === '0.2.0',
    25000,
  );
  assert.equal(control.desiredState, 'paused');
  assert.equal(await readFile(join(base, 'one/config.json'), 'utf8'), configBefore);
  assert.equal(
    await readFile(join(base, 'one/audit/preserved'), 'utf8'),
    'encrypted-queue-sentinel',
  );
  await candidate('0.3.0', true);
  await run('check_update');
  await until(
    async () => control.update?.phase === 'rolled_back' && reportedVersion === '0.2.0',
    25000,
  );
  assert.equal(control.desiredState, 'paused');
  assert.equal(await readFile(join(base, 'one/config.json'), 'utf8'), configBefore);
  await until(
    async () =>
      JSON.parse(await readFile(join(base, 'one/status.json'), 'utf8')).control?.update?.phase ===
      'rolled_back',
  );
  const reply = await new Promise<any>(async (resolve, reject) => {
    const socket = createConnection(await managementSocket(join(base, 'one')));
    let data = '';
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          action: 'rebind',
          consoleUrl: address,
          token: 'relaynode.tenant.other.invalid',
        }) + '\n',
      ),
    );
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(data)));
  });
  assert.match(reply.error, /invalid credential/);
  assert.equal(
    JSON.parse(await readFile(join(base, 'one/config.json'), 'utf8')).token,
    'relaynode.tenant.node.original',
  );
  assert.equal(
    await stat(join(base, 'two/healthy')).then(
      () => true,
      () => false,
    ),
    false,
  );
});
test('stable launcher automatically rolls back a candidate that exits before health confirmation', async (t) => {
  const root = await mkdtemp('/tmp/relay-rollback-');
  const old = await fixture(root),
    bad = join(root, 'bad');
  await mkdir(join(bad, 'runtime/bin'), { recursive: true });
  await writeFile(
    join(bad, 'runtime/bin/node'),
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  await mkdir(join(bad, 'dist/apps/worker/src'), { recursive: true });
  await writeFile(join(bad, 'dist/apps/worker/src/entry.js'), 'process.exit(2);');
  await writeFile(
    join(old, 'dist/apps/worker/src/entry.js'),
    `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2]+'/healthy','old');setInterval(()=>{},1000);`,
  );
  await symlink(bad, join(root, 'current'));
  await symlink(old, join(root, 'previous'));
  await saveJson(join(root, 'upgrade.json'), {
    requestId: 'upgrade',
    version: '0.2.0',
    previous: old,
    target: bad,
  });
  const launcher = spawn('sh', ['bin/launcher.sh', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  launcher.stdout?.on('data', (chunk) => (logs += chunk));
  launcher.stderr?.on('data', (chunk) => (logs += chunk));
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const ended = new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
      launcher.kill('SIGTERM');
      await Promise.race([ended, delay(4000)]);
    }
    await rm(root, { recursive: true, force: true });
  });
  try {
    await until(async () =>
      stat(join(root, 'healthy')).then(
        () => true,
        () => false,
      ),
    );
  } catch (error) {
    throw new Error((error as Error).message + '\n' + logs);
  }
  assert.equal(await readlink(join(root, 'current')), old);
  assert.ok(await stat(join(root, 'rollback.json')));
});

test('a broken execution helper leaves management online without declaring startup healthy', async (t) => {
  const root = await mkdtemp('/tmp/relay-unready-');
  const release = await fixture(root),
    instance = join(root, 'instances/one');
  await rm(join(release, 'bin/relay-transport'));
  await mkdir(instance, { recursive: true });
  await symlink(release, join(instance, 'current'));
  let reports = 0,
    polls = 0;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const meta = JSON.parse(raw || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/worker/heartbeat') {
      assert.equal(meta.transportReady, false);
      reports++;
      res.end(
        JSON.stringify({
          control: { revision: 0, desiredState: 'paused' },
          blockers: [],
          protocolVersion: 1,
        }),
      );
    } else {
      polls++;
      res.end('null');
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await saveJson(join(instance, 'config.json'), {
    instance: 'one',
    consoleUrl: 'http://127.0.0.1:' + (upstream.address() as any).port,
    token: 'relaynode.test.one.token',
  });
  const manager = spawn(
    process.execPath,
    [join(release, 'dist/apps/worker/src/entry.js'), instance],
    { stdio: 'ignore' },
  );
  t.after(async () => {
    if (manager.exitCode === null) {
      const ended = new Promise<void>((resolve) => manager.once('exit', () => resolve()));
      manager.kill('SIGTERM');
      await Promise.race([ended, delay(4000)]);
    }
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await until(async () => reports >= 2);
  const result = await exec(
    process.execPath,
    [join(release, 'dist/apps/worker/src/cli.js'), '--instance', 'one', 'status'],
    { env: { ...process.env, RELAY_NODE_HOME: join(root, 'instances') } },
  );
  const status = JSON.parse(result.stdout);
  assert.equal(status.connected, true);
  assert.equal(status.transportReady, false);
  assert.equal(polls, 0);
  assert.equal(
    await stat(join(instance, 'healthy')).then(
      () => true,
      () => false,
    ),
    false,
  );
});
