import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as sdk from '@relay/node';
import * as contracts from '@relay/node/contracts';
import * as rules from '@relay/node/rules';
import * as browser from '@relay/node/browser';

const require = createRequire(import.meta.url);
test('the built SDK exposes four deliberate entries without console persistence models', async () => {
  const metadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(metadata.exports), ['.', './contracts', './rules', './browser']);
  assert.equal(typeof sdk.ProtocolEngine, 'function');
  assert.equal(typeof sdk.NativeTransport, 'function');
  assert.equal(contracts.NODE_PROTOCOL_VERSION, 1);
  assert.equal(rules.money('12.34'), 1234n);
  assert.equal(rules.billingPostalCodeOptional('HK'), true);
  assert.equal(rules.billingPostalCodeOptional('US'), false);
  for (const entry of ['@relay/node/core/domain', '@relay/node/worker/protocol'])
    assert.throws(() => require.resolve(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  for (const key of ['defaults', 'countries', 'terminal', 'active', 'nodeBlockers'])
    assert.equal(key in sdk || key in contracts || key in rules, false, key);
});

test('the browser entry is a standalone module with no Node runtime or external imports', async () => {
  const source = await readFile(new URL(import.meta.resolve('@relay/node/browser')), 'utf8');
  assert.doesNotMatch(source, /(?:^|\n)import\s|node:/);
  assert.equal(typeof browser.authorizeSentinelInPage, 'function');
  assert.equal(typeof browser.prepareStripeTokenInPage, 'function');
});
