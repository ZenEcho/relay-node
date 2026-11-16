import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadVerifiedAsset,
  installReferenceSentinel,
  parseInstallArguments,
  REFERENCE_COMMIT,
} from '../../scripts/install-reference-sentinel.mjs';

test('installer requires an explicit absolute destination and rejects additional arguments', () => {
  assert.deepEqual(parseInstallArguments(['--directory', '/tmp/relay-sentinel']), {
    directory: '/tmp/relay-sentinel',
  });
  for (const args of [[], ['--directory', 'relative'], ['--directory', '/tmp/runtime', '--force']])
    assert.throws(() => parseInstallArguments(args), /Usage:/);
});

test('asset download verifies SHA-256 and forbids redirects', async () => {
  const bytes = Buffer.from('synthetic test asset');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await downloadVerifiedAsset({
    url: 'https://example.test/asset',
    sha256,
    fetchImpl: async (_url: string, options: RequestInit) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      return new Response(bytes);
    },
  });
  assert.deepEqual(result, bytes);
  await assert.rejects(
    downloadVerifiedAsset({
      url: 'https://example.test/asset',
      sha256,
      fetchImpl: async () => new Response('changed content'),
    }),
    /SHA-256/,
  );
});

test('asset download limits both advertised and streamed response sizes and times out', async () => {
  for (const response of [
    new Response('abc', { headers: { 'content-length': '3' } }),
    new Response('abc'),
  ])
    await assert.rejects(
      downloadVerifiedAsset({
        url: 'https://example.test/asset',
        sha256: '',
        maxFileBytes: 2,
        fetchImpl: async () => response,
      }),
      /download limit/,
    );
  await assert.rejects(
    downloadVerifiedAsset({
      url: 'https://example.test/asset',
      sha256: '',
      timeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }),
    /timed out/,
  );
});

test('installer preserves an existing destination without fetching or invoking npm', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'relay-install-existing-'));
  try {
    const directory = join(parent, 'runtime');
    await mkdir(directory);
    await writeFile(join(directory, 'keep'), 'original');
    await assert.rejects(
      installReferenceSentinel({
        directory,
        fetchImpl: async () => {
          assert.fail('must not download');
        },
        runNpm: async () => {
          assert.fail('must not install');
        },
      }),
      /already exists/,
    );
    assert.equal(await readFile(join(directory, 'keep'), 'utf8'), 'original');
    assert.deepEqual(await readdir(parent), ['runtime']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a failed verification cleans the temporary sibling and lock, and never runs npm', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'relay-install-failure-'));
  try {
    await assert.rejects(
      installReferenceSentinel({
        directory: join(parent, 'runtime'),
        fetchImpl: async (url: string) => {
          assert.match(
            url,
            new RegExp(
              '^https://raw\\.githubusercontent\\.com/crhywun/gpt-subscribe-studio-1/' +
                REFERENCE_COMMIT +
                '/',
            ),
          );
          return new Response('wrong upstream content');
        },
        runNpm: async () => {
          assert.fail('must not install');
        },
      }),
      /SHA-256/,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
