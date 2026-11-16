#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_COMMIT = 'adccdfc993e368f2c09bad7081885c6daff2d320';
export const UNDICI_VERSION = '8.12.3';
export const REFERENCE_ASSETS = Object.freeze({
  'sentinel_bridge.js': '79ada14fcdf254f6be6b158e7dc991dd5d77224d83fe73af25a81043e6514e17',
  'sentinel_bootstrap.js': 'f9cc2fc730441873762f6b1bc6808975690d4bc028b12a86b9bcd8096467e6d6',
  'sentinel_sdk.js': 'f21fa2a6859b320ef3157e3cf17d9a8da7fbf824aba55502b5fc3f421c03ef11',
  'sentinel_curl_fetch.py': '28ddb3dc73f9113acfc9003e65e14d54751f8f0d6669977e1940e1a51a861a87',
});
const REPOSITORY = 'crhywun/gpt-subscribe-studio-1';
const ASSET_PATH = 'packages/core/src/gss_core/sentinel_assets';
const NPM_ARGS = Object.freeze(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Buffer only a bounded, verified response. No downloaded code is executed here.
export async function downloadVerifiedAsset({
  url, sha256, fetchImpl = globalThis.fetch, timeoutMs = 30000, maxFileBytes = 2 * 1024 * 1024,
}) {
  const controller = new AbortController();
  let timer;
  const download = async () => {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Reference asset download failed (HTTP ' + response.status + ')');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxFileBytes))
      throw new Error('Reference asset exceeds the download limit');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxFileBytes) {
        controller.abort();
        throw new Error('Reference asset exceeds the download limit');
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Reference asset SHA-256 verification failed');
    return bytes;
  };
  try {
    return await Promise.race([
      download(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Reference asset download timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function runNpm(directory, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: directory,
      stdio: 'ignore',
      timeout: 120000,
    });
    child.once('error', () => rejectRun(new Error('Unable to run npm for the reference runtime')));
    child.once('close', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error('Reference runtime npm install failed' + (signal ? ' (' + signal + ')' : ' (exit ' + code + ')')));
    });
  });
}

async function restrictPermissions(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await restrictPermissions(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    else throw new Error('Unexpected file type in the reference runtime');
  }
}

/** Install an explicitly selected, separate reference runtime. Never changes node configuration. */
export async function installReferenceSentinel({ directory, fetchImpl = globalThis.fetch, runNpm: installNpm = runNpm }) {
  if (typeof directory !== 'string' || !isAbsolute(directory))
    throw new Error('--directory must be an absolute path');
  const destination = resolve(directory);
  if (dirname(destination) === destination) throw new Error('The filesystem root cannot be an installation directory');
  if (await exists(destination)) throw new Error('Installation directory already exists; it will not be overwritten');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = join(parent, '.' + basename(destination) + '.install.lock');
  let lock;
  let temporary;
  try {
    // Serialize installers targeting the same destination. Only our own lock
    // and temporary sibling are removed on a failure.
    lock = await open(lockPath, 'wx', 0o600);
    if (await exists(destination)) throw new Error('Installation directory already exists; it will not be overwritten');
    temporary = await mkdtemp(join(parent, '.' + basename(destination) + '.install-'));
    await chmod(temporary, 0o700);
    for (const [name, sha256] of Object.entries(REFERENCE_ASSETS)) {
      const url = `https://raw.githubusercontent.com/${REPOSITORY}/${REFERENCE_COMMIT}/${ASSET_PATH}/${name}`;
      const bytes = await downloadVerifiedAsset({ url, sha256, fetchImpl });
      await writeFile(join(temporary, name), bytes, { mode: 0o600, flag: 'wx' });
    }
    await writeFile(join(temporary, 'package.json'), JSON.stringify({
      name: 'relay-reference-sentinel-runtime',
      version: '0.0.0',
      private: true,
      type: 'commonjs',
      dependencies: { undici: UNDICI_VERSION },
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await installNpm(temporary, [...NPM_ARGS]);
    const source = {
      version: 1,
      repository: 'https://github.com/' + REPOSITORY,
      commit: REFERENCE_COMMIT,
      assetPath: ASSET_PATH,
      assets: REFERENCE_ASSETS,
      dependencies: { undici: UNDICI_VERSION },
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(temporary, 'source.json'), JSON.stringify(source, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await restrictPermissions(temporary);
    if (await exists(destination)) throw new Error('Installation directory appeared during installation; it will not be overwritten');
    await rename(temporary, destination);
    temporary = undefined;
    return { directory: destination, source };
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally {
      if (lock) {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    }
  }
}

export function parseInstallArguments(args) {
  if (args.length !== 2 || args[0] !== '--directory' || !isAbsolute(args[1]))
    throw new Error('Usage: node scripts/install-reference-sentinel.mjs --directory /absolute/runtime/path');
  return { directory: args[1] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await installReferenceSentinel(parseInstallArguments(process.argv.slice(2)));
    console.log('Reference Sentinel runtime installed at ' + result.directory);
    console.log('Source commit: ' + REFERENCE_COMMIT + '; node configuration is unchanged.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
