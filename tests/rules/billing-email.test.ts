import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindBillingEmail,
  selectBillingEmail,
  type BillingEmailContext,
} from '../../packages/rules/src/billing-email.js';

test('ChatGPT billing uses the valid Session email before the configured default', () => {
  assert.deepEqual(
    selectBillingEmail(
      'chatgpt',
      { user: { email: ' session@example.invalid ' } },
      'default@example.invalid',
    ),
    {
      provider: 'chatgpt',
      email: 'session@example.invalid',
      source: 'session',
    },
  );
  for (const email of [undefined, '', '  ', 'bad-email', 'bad\n@example.invalid'])
    assert.equal(
      selectBillingEmail('chatgpt', { user: { email } }, 'default@example.invalid').email,
      'default@example.invalid',
    );
  assert.equal(
    selectBillingEmail('chatgpt', { user: { email: '' } }, 'invalid-default').source,
    'none',
  );
});

test('Grok request email precedes googleEmail and uses the default only when neither is valid', () => {
  const response = {
    status: 'authenticated',
    session: {
      email: 'grok@example.invalid',
      googleEmail: 'google@example.invalid',
    },
  };
  assert.equal(
    selectBillingEmail('grok', response, 'default@example.invalid').email,
    'grok@example.invalid',
  );
  assert.equal(
    selectBillingEmail('grok', {
      session: { email: 'invalid', googleEmail: 'google@example.invalid' },
    }).email,
    'google@example.invalid',
  );
  assert.equal(
    selectBillingEmail('grok', { session: {} }, 'default@example.invalid').email,
    'default@example.invalid',
  );
  assert.equal(selectBillingEmail('grok', { session: {} }).email, 'pay@grok.com');
});

test('an address can have no Session or email while the accepted billing binding stays stable across later Sessions', () => {
  assert.equal(selectBillingEmail('chatgpt', undefined).source, 'none');
  const context: BillingEmailContext = {
    session: { user: { email: 'first@example.invalid' } },
    billing: { email: 'default@example.invalid' },
  };
  const binding = bindBillingEmail(context, 'chatgpt', context.billing?.email);
  assert.equal(context.billing?.email, 'first@example.invalid');
  context.session = { user: { email: 'changed@example.invalid' } };
  assert.deepEqual(bindBillingEmail(context, 'chatgpt', 'new-default@example.invalid'), binding);
  assert.equal(context.email, 'first@example.invalid');
  assert.equal(context.billing?.email, 'first@example.invalid');
});
