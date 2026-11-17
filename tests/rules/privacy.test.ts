import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../../packages/rules/src/privacy.js';
import { auditRedact, trace } from '../../packages/runtime/src/audit.js';

const id = '12345678-1234-4234-a374-fb7f4267ebbf';

test('numeric UUID segments survive redaction in fields, text and URLs while PANs remain hidden', () => {
  const value = auditRedact({
    traceId: id,
    request: { requestId: id, url: 'https://example.invalid/runs/' + id },
    response: 'run ' + id + ' card 4242 4242 4242 4242 and 4242424242424242',
    card_number: '4242424242424242',
    authorization: 'Bearer private-token',
  });
  assert.equal(value.traceId, id);
  assert.equal(value.request.requestId, id);
  assert.equal(value.request.url, 'https://example.invalid/runs/' + id);
  assert.equal(value.response, 'run ' + id + ' card [CARD]and [REDACTED]');
  assert.equal(value.card_number, '[REDACTED]');
  assert.equal(value.authorization, '[REDACTED]');
  assert.deepEqual(auditRedact(value), value);
  assert.equal(cleanText(id.toUpperCase()), id.toUpperCase());
});

test('a UUID supplied as a secret is still redacted, including copies outside the sensitive field', () => {
  const value = auditRedact({ password: id, response: id });
  assert.equal(value.password, '[REDACTED]');
  assert.equal(value.response, '[REDACTED]');
});

test('trace start and completion retain one valid UUID across repeated audit redaction', async () => {
  const entries: any[] = [];
  await trace(
    async (entry) => {
      entries.push(auditRedact(entry));
    },
    'test',
    {},
    async () => 'ok',
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].traceId, entries[1].traceId);
  assert.match(entries[0].traceId, /^[0-9a-f-]{36}$/);
});
