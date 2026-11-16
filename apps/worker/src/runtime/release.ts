import { readManifest } from './manifest.js';
export type { Manifest } from './manifest.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, symlink, rm, lstat, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { NODE_PROTOCOL_VERSION, NODE_REPOSITORY } from '../../../../packages/contracts/src/node-control.js';
const exec = promisify(execFile);
export async function managementSocket(root: string) {
  const owner = (await stat(root)).uid;
  return join(
    '/tmp',
    `relay-node-${owner}-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}.sock`,
  );
}
const writers = new Map<string, Promise<void>>();
export async function jsonFile<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function saveJson(path: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const operation = (writers.get(path) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const temp = path + '.' + process.pid + '.tmp';
      await writeFile(temp, bytes, { mode: 0o600, flush: true });
      await rename(temp, path);
    });
  writers.set(path, operation);
  try {
    await operation;
  } finally {
    if (writers.get(path) === operation) writers.delete(path);
  }
}
export function newerVersion(candidate: string, current: string) {
  const parse = (v: string) => {
    if (!/^v?\d+\.\d+\.\d+$/.test(v)) throw new Error('发布版本格式无效');
    return v.replace(/^v/, '').split('.').map(Number);
  };
  const a = parse(candidate),
    b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export async function latestRelease(fetcher: typeof fetch = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${NODE_REPOSITORY}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Relay-Node-Updater',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub 版本检查失败（HTTP ${response.status}）`);
  const release = (await response.json()) as any;
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name))
    throw new Error('未找到有效正式版本');
  return release;
}
export async function verifyTree(root: string, directory = root) {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry),
      stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error('安装包包含不允许的文件类型');
    if (stat.isDirectory()) await verifyTree(root, path);
  }
}
export async function downloadRelease(
  release: any,
  destination: string,
  platform = process.platform,
  arch = process.arch,
  fetcher: typeof fetch = fetch,
  expectedProtocol = NODE_PROTOCOL_VERSION,
) {
  const version = String(release.tag_name).replace(/^v/, '');
  const name = `relay-node-${version}-${platform}-${arch}.tar.gz`;
  const asset = release.assets?.find((a: any) => a.name === name);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ''))
    throw new Error('正式版本缺少平台安装包或 SHA-256 校验值');
  const url = new URL(asset.browser_download_url);
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    !url.pathname.startsWith(`/${NODE_REPOSITORY}/releases/download/${release.tag_name}/`)
  )
    throw new Error('安装包地址不属于节点仓库');
  const response = await fetcher(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`安装包下载失败（HTTP ${response.status}）`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.digest)
    throw new Error('安装包 SHA-256 校验失败');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = join(destination, 'package.tar.gz');
  await writeFile(archive, bytes, { mode: 0o600 });
  const listing = await exec('tar', ['-tzf', archive], {
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const entry of listing.stdout.split('\n').filter(Boolean)) {
    const path = relative(destination, resolve(destination, entry));
    if (isAbsolute(entry) || path === '..' || path.startsWith('../') || entry.includes('\\'))
      throw new Error('安装包包含无效路径');
  }
  const verbose = await exec('tar', ['-tvzf', archive], {
    maxBuffer: 8 * 1024 * 1024,
  });
  if (
    verbose.stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => !['-', 'd'].includes(line[0]))
  )
    throw new Error('安装包包含不允许的链接或特殊文件');
  await exec('tar', ['-xzf', archive, '-C', destination, '--no-same-owner']);
  await rm(archive);
  await verifyTree(destination);
  return readManifest(destination, {
    version,
    protocolVersion: expectedProtocol,
    platform,
    arch,
  });
}
export async function switchCurrent(root: string, releasePath: string) {
  const temp = join(root, 'current.next');
  await rm(temp, { force: true });
  await symlink(releasePath, temp);
  await rename(temp, join(root, 'current'));
}
