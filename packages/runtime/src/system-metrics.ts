import { cpus, freemem, totalmem, uptime } from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type SystemMetrics = {
  sampledAt: string;
  cpu: { usagePercent: number | null; cores: number; model: string };
  memory: { total: number; used: number; available: number };
  disk: { total: number; used: number; available: number } | null;
  network: { receivedBytesPerSecond: number; sentBytesPerSecond: number } | null;
  uptimeSeconds: number;
};
const exec = promisify(execFile);
export function cpuTotals() {
  const processors = cpus();
  return {
    idle: processors.reduce((n, cpu) => n + cpu.times.idle, 0),
    total: processors.reduce((n, cpu) => n + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0),
    cores: processors.length,
    model: processors[0]?.model || '',
  };
}
export function parseLinuxNetwork(text: string) {
  let received = 0, sent = 0;
  for (const line of text.split('\n')) {
    const [name, values] = line.split(':');
    if (!values || /^(lo|docker\d*|veth.*|br-.*)$/.test(name.trim())) continue;
    const fields = values.trim().split(/\s+/).map(Number);
    if (fields.length >= 9 && Number.isFinite(fields[0]) && Number.isFinite(fields[8])) {
      received += fields[0];
      sent += fields[8];
    }
  }
  return { received, sent };
}
async function networkTotals() {
  if (process.platform === 'linux') return parseLinuxNetwork(await readFile('/proc/net/dev', 'utf8'));
  if (process.platform !== 'darwin') return null;
  const { stdout } = await exec('netstat', ['-ibn'], { timeout: 2000, maxBuffer: 1024 * 1024 });
  const lines = stdout.trim().split('\n');
  const header = lines.shift()!.trim().split(/\s+/);
  const receivedIndex = header.indexOf('Ibytes'), sentIndex = header.indexOf('Obytes');
  if (receivedIndex < 0 || sentIndex < 0) return null;
  const seen = new Set<string>();
  let received = 0, sent = 0;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/), name = fields[0];
    if (name === 'lo0' || seen.has(name) || !fields.some((field) => /^<Link#\d+>$/.test(field))) continue;
    const input = Number(fields[receivedIndex]), output = Number(fields[sentIndex]);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    seen.add(name);
    received += input;
    sent += output;
  }
  return { received, sent };
}

export class SystemMonitor {
  private previousCpu = cpuTotals();
  private previousNetwork?: { at: number; received: number; sent: number };
  private cached?: SystemMetrics;
  private pending?: Promise<SystemMetrics>;
  constructor(private readonly diskPath = process.cwd()) {}
  sample(): Promise<SystemMetrics> {
    if (this.pending) return this.pending;
    if (this.cached && Date.now() - Date.parse(this.cached.sampledAt) < 2000) return Promise.resolve(this.cached);
    this.pending = this.read().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async read(): Promise<SystemMetrics> {
    const [filesystem, network, memoryInfo] = await Promise.all([
      statfs(this.diskPath).catch(() => null),
      networkTotals().catch(() => null),
      process.platform === 'linux' ? readFile('/proc/meminfo', 'utf8').catch(() => '')
        : process.platform === 'darwin' ? exec('vm_stat', [], { timeout: 2000 }).then(({ stdout }) => stdout).catch(() => '') : '',
    ]);
    const at = Date.now(), cpu = cpuTotals(), elapsedCpu = cpu.total - this.previousCpu.total;
    const usagePercent = elapsedCpu > 0
      ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - this.previousCpu.idle) / elapsedCpu))) : null;
    this.previousCpu = cpu;
    const memoryTotal = totalmem();
    const pageSize = Number(/page size of (\d+) bytes/.exec(memoryInfo)?.[1] || 4096);
    const reclaimablePages = ['free', 'inactive', 'speculative'].reduce((sum, name) =>
      sum + Number(new RegExp('Pages ' + name + ':\\s+(\\d+)').exec(memoryInfo)?.[1] || 0), 0);
    const memoryAvailable = Math.min(memoryTotal, process.platform === 'darwin' && reclaimablePages > 0
      ? reclaimablePages * pageSize : memoryInfo
      ? Number(/^MemAvailable:\s+(\d+)/m.exec(memoryInfo)?.[1] || freemem() / 1024) * 1024
      : freemem());
    const elapsedNetwork = this.previousNetwork ? (at - this.previousNetwork.at) / 1000 : 0;
    const rate = network && this.previousNetwork && elapsedNetwork > 0 ? {
      receivedBytesPerSecond: Math.max(0, network.received - this.previousNetwork.received) / elapsedNetwork,
      sentBytesPerSecond: Math.max(0, network.sent - this.previousNetwork.sent) / elapsedNetwork,
    } : null;
    if (network) this.previousNetwork = { ...network, at };
    else this.previousNetwork = undefined;
    this.cached = {
      sampledAt: new Date(at).toISOString(),
      cpu: { usagePercent, cores: cpu.cores, model: cpu.model },
      memory: { total: memoryTotal, used: memoryTotal - memoryAvailable, available: memoryAvailable },
      disk: filesystem ? {
        total: filesystem.blocks * filesystem.bsize,
        used: (filesystem.blocks - filesystem.bfree) * filesystem.bsize,
        available: filesystem.bavail * filesystem.bsize,
      } : null,
      network: rate,
      uptimeSeconds: uptime(),
    };
    return this.cached;
  }
}
