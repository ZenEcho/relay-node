import { SystemMonitor } from '../../../../packages/runtime/src/system-metrics.js';
import { pollBatch } from './poll-batch.js';
import { readManifest } from './manifest.js';
import { updateActive } from '../../../../packages/rules/src/node-control.js';
import { createServer } from 'node:net';
import { createEnvironment } from '../../../../packages/runtime/src/environment.js';
import {
  NODE_PROTOCOL_VERSION,
  type NodeAction,
  type WorkerMetadata,
} from '../../../../packages/contracts/src/node-control.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, mkdir, rm, realpath, writeFile, symlink, rename, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpController } from './controller.js';
import { ExecutionCancellations } from './cancellation.js';
import {
  executeWithOnDemandSdk,
  checkPaymentRuntime,
  type OnDemandSdkOptions,
  type SentinelRuntimeOptions,
} from '../browser/runtime.js';
import { NativeTransport } from '../transport/native.js';
import { DemoTransport } from '../testing/demo-transport.js';
import {
  jsonFile,
  saveJson,
  newerVersion,
  latestRelease,
  downloadRelease,
  switchCurrent,
  managementSocket,
} from './release.js';
export type InstanceConfig = {
  consoleUrl: string;
  token: string;
  instance: string;
  environment?: Record<string, string>;
  officialSdk?: OnDemandSdkOptions;
  sentinel?: SentinelRuntimeOptions;
};
type State = { commands: { id: string; action: NodeAction }[] };
const exec = promisify(execFile);
async function checkNativeTransport(releaseRoot: string) {
  const transport = new NativeTransport(join(releaseRoot, 'bin/relay-transport'));
  try {
    await transport.initialize(createEnvironment('US', ''));
  } finally {
    transport.close();
  }
}
export async function selfTest(releaseRoot: string) {
  const manifest = await readManifest(releaseRoot);
  await checkNativeTransport(releaseRoot);
  return manifest;
}
export async function runManager(root: string) {
  root = resolve(root);
  const releaseRoot = await realpath(join(root, 'current'));
  const manifest = await readManifest(releaseRoot);
  let initialReady = false;
  try {
    await checkNativeTransport(releaseRoot);
    initialReady = true;
  } catch {
    console.error('原生传输组件未就绪，管理与更新功能保持可用');
  }
  let config = await jsonFile<InstanceConfig>(join(root, 'config.json'));
  let sdkReady = await checkPaymentRuntime(config.officialSdk, config.sentinel).then(
    () => true,
    () => false,
  );
  Object.assign(process.env, config.environment || {});
  process.env.WORKER_LOG_DIR = join(root, 'audit');
  let controller = new HttpController(config.consoleUrl, config.token);
  await controller.initializeLogs();
  const state = await jsonFile<State>(join(root, 'state.json'), {
    commands: [],
  });
  const pending = new Set<Promise<unknown>>();
  const cancellations = new ExecutionCancellations();
  let stopping = false,
    ready = initialReady,
    lastProbe = Date.now(),
    status: any = { blockers: [] },
    upgrading: Promise<void> | undefined,
    authenticated = false;
  const persist = () => saveJson(join(root, 'state.json'), state);
  const metadata = (): WorkerMetadata => ({
    version: manifest.version,
    protocolVersion: NODE_PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    transportReady: ready,
    paymentRuntime: sdkReady ? 'on_demand' : 'unavailable',
    inFlightCount: pending.size,
    runtimeState: upgrading ? 'updating' : status.control?.desiredState || 'running',
  });
  let monitor: SystemMonitor | undefined;
  let metricsTask: Promise<unknown> | undefined;
  let metricsController: AbortController | undefined;
  const stopMetrics = () => {
    monitor = undefined;
    metricsController?.abort();
  };
  const heartbeat = async () => {
    const value = await controller.request('heartbeat', metadata());
    cancellations.apply(value.cancelledRuns);
    if (value.metricsRequested === true) {
      // Optional monitoring must not hold up heartbeat, cancellation or order polling.
      if (!metricsTask) {
        const target = controller;
        const signal = (metricsController = new AbortController()).signal;
        metricsTask = (monitor ??= new SystemMonitor(root))
          .sample()
          .then((metrics) =>
            target.request('metrics', metrics, AbortSignal.any([signal, AbortSignal.timeout(3000)])),
          )
          .catch(() => {})
          .finally(() => {
            metricsTask = undefined;
          });
      }
    } else stopMetrics();
    return value;
  };
  async function update(id: string) {
    const report = (phase: string, extra: object = {}) =>
      controller.request(`updates/${id}/report`, { phase, ...extra });
    try {
      try {
        await controller.request(`updates/${id}/prepare`);
      } catch (error) {
        if ((error as any).status === 409) return;
        throw error;
      }
      const release = await latestRelease();
      if (!newerVersion(release.tag_name, manifest.version)) {
        await report('current');
        return;
      }
      const version = release.tag_name.slice(1),
        directory = join(root, 'releases', version + '-' + randomUUID());
      await report('downloading', {
        version,
        previousVersion: manifest.version,
      });
      await downloadRelease(
        release,
        directory,
        process.platform,
        process.arch,
        fetch,
        status.protocolVersion,
      );
      await exec(
        join(directory, 'runtime/bin/node'),
        [join(directory, 'dist/apps/worker/src/entry.js'), '--self-test', directory],
        { timeout: 60000 },
      );
      await controller.flushLogs();
      await report('installing');
      await saveJson(join(root, 'upgrade.json'), {
        requestId: id,
        version,
        previousVersion: manifest.version,
        previous: releaseRoot,
        target: directory,
      });
      await rm(join(root, 'previous.next'), { force: true });
      await symlink(releaseRoot, join(root, 'previous.next'));
      await rename(join(root, 'previous.next'), join(root, 'previous'));
      await report('restarting');
      await switchCurrent(root, directory);
      stopping = true;
    } catch (error) {
      const result = {
        id,
        phase: 'failed',
        error: (error as Error).message.slice(0, 1000),
      };
      await saveJson(join(root, 'update-result.json'), result);
      await report('failed', { error: result.error })
        .then(() => rm(join(root, 'update-result.json'), { force: true }))
        .catch(() => {});
      console.error('节点更新失败，保留当前版本：' + (error as Error).message);
    }
  }
  const socket = await managementSocket(root);
  // A second manager cannot unlink the active instance's socket.
  const lock = join(root, 'manager.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error('节点实例已经运行；若异常退出，请由启动器清理运行锁');
  }
  const existing = await lstat(socket).catch(() => null);
  if (existing && existing.uid !== process.getuid?.()) throw new Error('管理 socket 属于其他用户');
  await rm(socket, { force: true });
  const server = createServer((client) => {
    let buffer = '';
    client.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 16384) {
        client.destroy();
        return;
      }
      if (!buffer.includes('\n')) return;
      client.pause();
      void (async () => {
        const command = JSON.parse(buffer.split('\n')[0]);
        if (command.action === 'status')
          return {
            ...status,
            ...metadata(),
            instance: config.instance,
            connected: authenticated,
          };
        if (command.action === 'rebind') {
          if (
            !authenticated ||
            status.control?.desiredState !== 'paused' ||
            pending.size ||
            status.blockers?.length ||
            upgrading ||
            updateActive(status.control?.update) ||
            state.commands.length ||
            controller.pendingLogs
          )
            throw new Error('请先暂停接单，等待原订单结束及日志同步后再更换对接');
          const candidate: InstanceConfig = {
            ...config,
            consoleUrl: String(command.consoleUrl),
            token: String(command.token),
          };
          const replacement = new HttpController(candidate.consoleUrl, candidate.token);
          await replacement.request('heartbeat', metadata());
          await replacement.initializeLogs();
          await saveJson(join(root, 'config.json'), candidate);
          config = candidate;
          stopMetrics();
          controller = replacement;
          return { ok: true };
        }
        if (!['pause', 'resume', 'check_update', 'cancel_update'].includes(command.action))
          throw new Error('不支持的节点操作');
        const item = { id: randomUUID(), action: command.action as NodeAction };
        state.commands.push(item);
        await persist();
        return { ok: true, queued: true };
      })().then(
        (result) => client.end(JSON.stringify(result) + '\n'),
        (error) => client.end(JSON.stringify({ error: error.message }) + '\n'),
      );
    });
    client.setTimeout(50000, () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      try {
        void controller.flushLogs();
        if (Date.now() - lastProbe > 60000) {
          lastProbe = Date.now();
          sdkReady = await checkPaymentRuntime(config.officialSdk, config.sentinel).then(
            () => true,
            () => false,
          );
          try {
            await selfTest(releaseRoot);
            ready = true;
          } catch {
            ready = false;
          }
        }
        status = await heartbeat();
        authenticated = true;
        const result = await jsonFile<any>(join(root, 'update-result.json'), null);
        if (result) {
          if (status.control?.update?.id === result.id && updateActive(status.control.update))
            await controller.request(`updates/${result.id}/report`, {
              phase: result.phase,
              error: result.error,
            });
          await rm(join(root, 'update-result.json'), { force: true });
          status = await heartbeat();
        }
        if (!upgrading && status.control?.update?.phase === 'installing') {
          await controller.request(`updates/${status.control.update.id}/report`, {
            phase: 'failed',
            error: '安装过程被中断，当前版本保持运行',
          });
          status = await heartbeat();
        }
        const upgrade = await jsonFile<any>(join(root, 'upgrade.json'), null);
        if (ready && !pending.size && status.control?.update?.phase === 'restarting') {
          const recovery = upgrade || {
            requestId: status.control.update.id,
            version: status.control.update.version,
          };

          const rollback = await jsonFile<any>(join(root, 'rollback.json'), null);
          if (
            status.control?.update?.id === recovery.requestId &&
            status.control.update.phase === 'restarting'
          ) {
            const phase = rollback || manifest.version !== recovery.version ? 'rolled_back' : 'completed';
            await controller.request(`updates/${recovery.requestId}/report`, {
              phase,
              ...(phase === 'rolled_back' ? { error: '新版启动检查失败，已恢复上一版本' } : {}),
            });
          }
          await rm(join(root, 'upgrade.json'), { force: true });
          await rm(join(root, 'rollback.json'), { force: true });
        }
        if (upgrade && !upgrading && !updateActive(status.control?.update)) {
          await rm(join(root, 'upgrade.json'), { force: true });
        }
        if (ready)
          await writeFile(join(root, 'healthy'), manifest.version, {
            mode: 0o600,
          });
        while (state.commands.length) {
          const command = state.commands[0];
          try {
            status = await controller.request('control', {
              action: command.action,
              requestId: command.id,
            });
          } catch (error) {
            if (![400, 404, 409, 422].includes((error as any).status)) throw error;
            console.error('节点管理操作未执行：' + (error as Error).message);
          }
          state.commands.shift();
          await persist();
        }
        await saveJson(join(root, 'status.json'), {
          ...status,
          ...metadata(),
          connected: true,
          at: new Date().toISOString(),
        });
        const updateStatus = status.control?.update;
        if (
          updateActive(updateStatus) &&
          ['queued', 'draining', 'checking', 'downloading'].includes(updateStatus.phase) &&
          !pending.size &&
          !status.blockers?.length &&
          !upgrading
        ) {
          upgrading = update(updateStatus.id).finally(() => {
            upgrading = undefined;
          });
        }
        if (
          !upgrading &&
          ready &&
          !state.commands.length &&
          !(updateActive(updateStatus) && !['queued', 'draining'].includes(updateStatus.phase))
        ) {
          await pollBatch(
            () => controller.request('poll'),
            (assignment: import('../../../../packages/contracts/src/execution.js').Assignment) => {
            const handle = cancellations.register(assignment.run.id, assignment.run.workerLease);
            if (handle && !handle.controller.signal.aborted) {
              const task = executeWithOnDemandSdk(
                assignment,
                controller.forRun(assignment, handle.controller),
                assignment.demo
                  ? new DemoTransport()
                  : new NativeTransport(join(releaseRoot, 'bin/relay-transport')),
                config.officialSdk,
                config.sentinel,
              )
                .catch(() => console.error('执行回执未确认，保留原任务等待核对'))
                .finally(() => {
                  handle.dispose();
                  pending.delete(task);
                });
              pending.add(task);
            } else handle?.dispose();
            },
            () => !stopping && !upgrading && ready && !state.commands.length,
          );
        }
      } catch {
        stopMetrics();
        authenticated = false;
        console.error('控制台暂不可用；停止领取新任务，保留原节点状态');
      }
      await delay(1500);
    }
    await Promise.allSettled(pending);
    await upgrading;
    await controller.flushLogs();
  } finally {
    stopMetrics();
    server.close();
    await rm(socket, { force: true });
    await rm(lock, { recursive: true, force: true });
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
