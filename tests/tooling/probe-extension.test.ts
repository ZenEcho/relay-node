import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
// This helper is deliberately a build-free script, shared by both isolated probe modes.
// @ts-ignore JavaScript diagnostic tooling is outside the SDK compilation boundary.
import { prepareProbeExtension } from '../../scripts/probes/lib/extension.mjs';

for (const official of [false, true])
  test(`${official ? 'official and reference' : 'reference'} probe extension loads its generated worker offline`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-probe-extension-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await prepareProbeExtension(directory, {
      name: 'Relay probe fixture',
      official,
    });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const source = `await import(${JSON.stringify(pathToFileURL(join(directory, manifest.background.service_worker)).href)}); console.log(JSON.stringify({ reference: typeof globalThis.relayReferenceAuthorize, official: typeof globalThis.relaySdkAuthorize }));`;
    const loaded = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8',
      }),
    );
    assert.deepEqual(loaded, {
      reference: 'function',
      official: official ? 'function' : 'undefined',
    });
  });
