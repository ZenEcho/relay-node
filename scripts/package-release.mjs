import { access, mkdir, rm, cp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { prepareReferenceSentinel } from './prepare-reference-sentinel.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const nodeVersion = '24.22.1',
  platform = process.platform,
  arch = process.arch;
const stage = resolve('release/stage');
const nativeSettings = execFileSync(
  process.env.GO_BINARY || 'go',
  ['version', '-m', 'native/transport/relay-transport'],
  { encoding: 'utf8' },
);
if (!nativeSettings.includes('CGO_ENABLED=0'))
  throw new Error('Release transport must be built with CGO_ENABLED=0');
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'runtime/bin'), { recursive: true });
await mkdir(join(stage, 'bin'));
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
await cp('dist', join(stage, 'dist'), { recursive: true });
await prepareReferenceSentinel();
await cp('runtime/reference-sentinel', join(stage, 'runtime/reference-sentinel'), { recursive: true });
for (const file of ['runtime/manager.js', 'browser/runtime.js', 'browser/configuration.js', 'browser/host.js'])
  await access(join(stage, 'dist/apps/worker/src', file));
await cp('bin', join(stage, 'bin'), { recursive: true });
await cp('install.sh', join(stage, 'install.sh'));
await mkdir(join(stage, 'scripts'));
await cp('scripts/install-reference-sentinel.mjs', join(stage, 'scripts/install-reference-sentinel.mjs'));
await cp('scripts/probe-reference-sentinel.mjs', join(stage, 'scripts/probe-reference-sentinel.mjs'));
await cp('VERSION', join(stage, 'VERSION'));
await cp('native/transport/relay-transport', join(stage, 'bin/relay-transport'));
if (process.env.RELAY_LOCAL_NODE_BINARY)
  await cp(await realpath(process.env.RELAY_LOCAL_NODE_BINARY), join(stage, 'runtime/bin/node'));
else {
  const filename = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const checks = await fetch(base + 'SHASUMS256.txt').then((r) => {
    if (!r.ok) throw Error('Node checksums unavailable');
    return r.text();
  });
  const expected = checks
    .split('\n')
    .find((line) => line.endsWith('  ' + filename))
    ?.split(' ')[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error('Node checksum is unavailable for this platform');
  const archive = resolve('release/node.tar.gz');
  let bytes = await readFile(archive).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(base + filename);
    if (!response.ok) throw Error('Node runtime unavailable');
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw Error('Node runtime checksum mismatch');
    await writeFile(archive, bytes);
  }
  execFileSync('tar', ['-xzf', archive, '-C', 'release']);
  await cp(`release/node-v${nodeVersion}-${platform}-${arch}/bin/node`, join(stage, 'runtime/bin/node'));
  await cp(`release/node-v${nodeVersion}-${platform}-${arch}/LICENSE`, join(stage, 'runtime/LICENSE'));
}
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify({ name: '@relay/node', version, type: 'module' }),
);
await writeFile(
  join(stage, 'manifest.json'),
  JSON.stringify({ version, protocolVersion: 1, nodeVersion, platform, arch }, null, 2) + '\n',
);
execFileSync(
  join(stage, 'runtime/bin/node'),
  [join(stage, 'dist/apps/worker/src/entry.js'), '--self-test', stage],
  { stdio: 'inherit' },
);
execFileSync('tar', ['-czf', `release/relay-node-${version}-${platform}-${arch}.tar.gz`, '-C', stage, '.']);
const packs = JSON.parse(
  execFileSync('npm', ['pack', '--pack-destination', 'release', '--json'], {
    encoding: 'utf8',
  }),
);
for (const path of [
  'runtime/reference-sentinel/sentinel_bridge.js',
  'runtime/reference-sentinel/sentinel_bootstrap.js',
  'runtime/reference-sentinel/sentinel_sdk.js',
  'node_modules/undici/index.js',
]) {
  if (!packs[0].files.some((file) => file.path === path))
    throw new Error('SDK package is missing reference runtime file: ' + path);
}
await cp('release/' + packs[0].filename, `release/relay-node-sdk-${version}.tgz`);
console.log(`Packaged ${version} ${platform}/${arch}`);
