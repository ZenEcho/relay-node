import { updateActive } from '../../../packages/rules/src/node-control.js';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openSync } from 'node:fs';
import { ReadStream as TerminalInput } from 'node:tty';
import { cp, mkdir, chmod, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { jsonFile, saveJson, switchCurrent, managementSocket } from './runtime/release.js';
import { selfTest, type InstanceConfig } from './runtime/manager.js';
import { HttpController } from './runtime/controller.js';
import { normalizeConsoleOrigin } from '../../../packages/rules/src/origin.js';
import { NODE_PROTOCOL_VERSION } from '../../../packages/contracts/src/node-control.js';
import { displayStatus } from './runtime/status-display.js';
const exec = promisify(execFile);
const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const base =
  process.env.RELAY_NODE_HOME ||
  (process.platform === 'darwin'
    ? join(process.env.HOME!, 'Library/Application Support/RelayNode')
    : '/var/lib/relay-node');
let muted = false,
  reader: ReturnType<typeof createInterface> | undefined,
  terminalInput: TerminalInput | undefined;
async function ask(prompt: string, secret = false) {
  if (!reader) {
    const input = process.stdin.isTTY
      ? process.stdin
      : (terminalInput = new TerminalInput(openSync('/dev/tty', 'r')));
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    reader = createInterface({ input, output, terminal: true });
  }
  const answer = reader.question(prompt);
  muted = secret;
  try {
    return (await answer).trim();
  } finally {
    muted = false;
    if (secret) console.log();
  }
}
export function instanceName(value: string) {
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(value))
    throw new Error('实例名使用小写字母开头，最多 20 位小写字母、数字或连字符');
  return value;
}
async function ipc(root: string, command: object): Promise<any> {
  const path = await managementSocket(root);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = '';
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(55000, () => socket.destroy(new Error('节点管理请求超时')));
  });
}
async function manage(root: string, instance: string, command: any) {
  try {
    return await ipc(root, command);
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    if (command.action === 'status')
      return {
        ...(await jsonFile<any>(join(root, 'status.json'), {})),
        connected: false,
        message: '节点未运行；选择开始接单可启动服务',
      };
    if (command.action !== 'resume') throw new Error('节点未运行，请先选择开始接单');
    if (process.platform === 'linux') await exec('systemctl', ['start', `relay-node-${instance}.service`]);
    else await exec('launchctl', ['kickstart', `gui/${process.getuid!()}/com.relay.node.${instance}`]);
    for (let i = 0; i < 60; i++) {
      try {
        return await ipc(root, command);
      } catch {
        await delay(500);
      }
    }
    throw new Error('节点启动失败，请查看服务日志');
  }
}
const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function credentials(instance: string): Promise<InstanceConfig> {
  const consoleUrl = normalizeConsoleOrigin(process.env.CONSOLE_URL || (await ask('控制台地址：')));
  if (!consoleUrl) throw new Error('请输入 HTTP(S) 控制台根地址');
  const token = process.env.NODE_TOKEN || (await ask('节点凭证（输入隐藏）：', true));
  if (!/^relaynode\.[^.]+\.[^.]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('节点凭证格式无效');
  const environment = Object.fromEntries(
    ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]!]),
  );
  return { instance, consoleUrl, token, environment };
}
async function install() {
  if (process.platform === 'linux' && process.getuid?.() !== 0 && !process.env.RELAY_NODE_NO_SERVICE) {
    const child = spawnSync(
      'sudo',
      [
        '--preserve-env=CONSOLE_URL,NODE_TOKEN,RELAY_NODE_INSTANCE',
        process.execPath,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' },
    );
    if (child.status !== 0) throw new Error('安装需要 sudo 权限');
    return;
  }
  const arg = process.argv.indexOf('--instance');
  const instance = instanceName(
    arg >= 0
      ? process.argv[arg + 1]
      : process.env.RELAY_NODE_INSTANCE || (await ask('实例名称 [main]：')) || 'main',
  );
  const root = join(base, instance),
    config = await credentials(instance);
  const old = await jsonFile<InstanceConfig | null>(join(root, 'config.json'), null);
  if (old) {
    if (old.consoleUrl !== config.consoleUrl || old.token !== config.token)
      throw new Error('实例已存在；请从菜单暂停并更换对接，或使用新的实例名');
    console.log('实例已存在，配置已保留。');
    return;
  }
  const manifest = await selfTest(releaseRoot);
  await new HttpController(config.consoleUrl, config.token).request('heartbeat', {
    version: manifest.version,
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    transportReady: false,
    inFlightCount: 0,
    runtimeState: 'starting',
  });
  await mkdir(base, { recursive: true, mode: 0o755 });
  await chmod(base, 0o755);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const target = join(root, 'releases', manifest.version);
  await cp(releaseRoot, target, { recursive: true });
  config.sentinel = {
    mode: 'reference',
    bridgePath: join(root, 'current/runtime/reference-sentinel/sentinel_bridge.js'),
  };
  await saveJson(join(root, 'config.json'), config);
  await switchCurrent(root, target);
  await cp(join(target, 'bin/launcher.sh'), join(root, 'launcher.sh'));
  await chmod(join(root, 'launcher.sh'), 0o755);
  await mkdir(join(root, 'logs'), { mode: 0o700 });
  if (process.env.RELAY_NODE_NO_SERVICE) {
    console.log('节点已安装（测试模式，未注册系统服务）。');
    return;
  }
  if (process.platform === 'linux') {
    const account = 'relay-' + instance;
    try {
      await exec('id', ['-u', account]);
    } catch {
      await exec('useradd', ['--system', '--home-dir', root, '--shell', '/usr/sbin/nologin', account]);
    }
    await exec('chown', ['-R', account + ':' + account, root]);
    const unit = `[Unit]\nDescription=Relay Node ${instance}\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=${account}\nExecStart=/bin/sh "${root}/launcher.sh" "${root}"\nRestart=always\nRestartSec=3\nTimeoutStopSec=infinity\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n`;
    await writeFile(`/etc/systemd/system/relay-node-${instance}.service`, unit);
    await exec('systemctl', ['daemon-reload']);
    await exec('systemctl', ['enable', '--now', `relay-node-${instance}.service`]);
    await cp(join(target, 'bin/relay-node'), '/usr/local/bin/relay-node');
    await chmod('/usr/local/bin/relay-node', 0o755);
  } else {
    const agents = join(process.env.HOME!, 'Library/LaunchAgents');
    await mkdir(agents, { recursive: true });
    const label = 'com.relay.node.' + instance;
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(root, 'launcher.sh'))}</string><string>${xml(root)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(root, 'logs/service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'logs/service.log'))}</string></dict></plist>`;
    const path = join(agents, label + '.plist');
    await writeFile(path, plist, { mode: 0o600 });
    await exec('launchctl', ['bootstrap', `gui/${process.getuid!()}`, path]);
    const bin = join(process.env.HOME!, '.local/bin');
    await mkdir(bin, { recursive: true });
    await cp(join(target, 'bin/relay-node'), join(bin, 'relay-node'));
    await chmod(join(bin, 'relay-node'), 0o755);
  }
  console.log(
    `安装完成：${instance}，版本 ${manifest.version}。已注册自动启动服务；运行 relay-node 打开管理菜单。`,
  );
}
async function menu() {
  await mkdir(base, { recursive: true });
  const instances = (await readdir(base, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^[a-z][a-z0-9-]{0,19}$/.test(e.name))
    .map((e) => e.name);
  console.log('\nRelay 节点管理\n');
  if (!instances.length) return install();
  console.log(instances.map((name, i) => `${i + 1}. ${name}`).join('\n') + '\n0. 新增实例');
  const selection = (await ask('选择实例 [1]：')) || '1';
  if (selection === '0') return install();
  const name = instances[Number(selection) - 1];
  if (!name) throw new Error('实例不存在');
  const root = join(base, name);
  for (;;) {
    console.log(
      `\n当前实例：${name}\n1. 查看状态与版本\n2. 开始接单\n3. 暂停接单\n4. 对接/更换控制台\n5. 检查并自动更新\n6. 取消等待更新\n7. 查看最近日志\n8. 切换/新增实例\n0. 退出`,
    );
    const action = await ask('请选择：');
    if (action === '0') return;
    if (action === '8') return menu();
    try {
      if (action === '7') {
        if (process.platform === 'linux')
          console.log(
            (await exec('journalctl', ['-u', `relay-node-${name}.service`, '-n', '60', '--no-pager'])).stdout,
          );
        else
          console.log(
            (await readFile(join(root, 'logs/service.log'), 'utf8')).split('\n').slice(-60).join('\n'),
          );
      } else {
        const command = (
          {
            '1': 'status',
            '2': 'resume',
            '3': 'pause',
            '4': 'rebind',
            '5': 'check_update',
            '6': 'cancel_update',
          } as Record<string, string>
        )[action];
        if (!command) continue;
        if (command === 'rebind') {
          let current = await manage(root, name, { action: 'status' });
          if (!current.connected) {
            console.log('请先启动节点并恢复控制台连接，再更换对接。');
            continue;
          }
          if (current.control?.desiredState !== 'paused') {
            await manage(root, name, { action: 'pause' });
            console.log('已提交暂停接新单请求，正在确认原订单状态…');
            for (let attempt = 0; attempt < 25; attempt++) {
              await delay(200);
              current = await manage(root, name, { action: 'status' });
              if (current.control?.desiredState === 'paused') break;
            }
          }
          if (
            current.control?.desiredState !== 'paused' ||
            current.blockers?.length ||
            current.inFlightCount ||
            updateActive(current.control?.update)
          ) {
            console.log(
              `原对接配置已保留；还有 ${current.blockers?.length || 0} 单未结束或维护尚未完成。请稍后再次选择更换对接。`,
            );
            continue;
          }
        }
        const args = command === 'rebind' ? await credentials(name) : {};
        const result = await manage(root, name, { action: command, ...args });
        if (command === 'status') console.log(displayStatus(result, name));
        else console.log('请求已保存；节点按当前订单状态执行。');
      }
    } catch (error) {
      console.error((error as Error).message);
    }
  }
}
try {
  if (process.argv[2] === 'rollback') {
    const root = process.argv[3],
      upgrade = await jsonFile<any>(join(root, 'upgrade.json'));
    await saveJson(join(root, 'rollback.json'), {
      at: new Date().toISOString(),
    });
    await switchCurrent(root, upgrade.previous);
  } else if (process.argv[2] === 'install') await install();
  else if (process.argv[2] === '--instance') {
    const name = instanceName(process.argv[3]),
      action = process.argv[4] || 'status';
    console.log(JSON.stringify(await manage(join(base, name), name, { action }), null, 2));
  } else await menu();
} catch (error) {
  console.error('操作失败：' + (error as Error).message);
  process.exitCode = 1;
} finally {
  reader?.close();
  terminalInput?.destroy();
}
