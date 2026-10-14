import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, userFacingMessage, AppError } from '../../src/core/errors.js';

test('failures: no code produces no failure object', () => {
  assert.equal(describeFailure(null), null);
  assert.equal(describeFailure(undefined), null);
});

test('failures: credits exhaustion is explained and tells the operator to top up', () => {
  const f = describeFailure('AI_CREDITS_EXHAUSTED', { kind: 'ai' });
  assert.equal(f.code, 'AI_CREDITS_EXHAUSTED');
  assert.equal(f.kind, 'ai');
  assert.equal(f.retryable, false);
  assert.equal(f.retrySafe, true);
  assert.match(f.action, /credits|quota/i);
});

test('failures: transient rate limits are retryable and safe to retry', () => {
  const f = describeFailure('HTTP_429');
  assert.equal(f.retryable, true);
  assert.equal(f.retrySafe, true);
});

test('failures: suppressed recipients are never safe to retry', () => {
  for (const code of ['SUPPRESSED', 'DUPLICATE', 'NOT_QUALIFIED', 'NO_CONTACT_ROUTE', 'CAMPAIGN_ENDED']) {
    const f = describeFailure(code);
    assert.equal(f.retrySafe, false, `${code} must not be retry-safe`);
  }
});

test('failures: an explicit retryable flag overrides the taxonomy guess', () => {
  assert.equal(describeFailure('AI_INVALID_OUTPUT', { retryable: true }).retryable, true);
  assert.equal(describeFailure('AI_TIMEOUT', { retryable: false }).retryable, false);
});

test('failures: unknown codes still get a human title and a safe default action', () => {
  const f = describeFailure('SOMETHING_NEW');
  assert.equal(f.title, 'Something new');
  assert.equal(f.retrySafe, true);
  assert.ok(f.detail.length > 0);
});

test('failures: every described code also has a user-facing message', () => {
  for (const code of ['AI_CREDITS_EXHAUSTED', 'AI_MODEL_UNAVAILABLE', 'HTTP_429', 'SUPPRESSED']) {
    const msg = userFacingMessage(new AppError(code, 'raw provider text'));
    assert.ok(msg && !msg.includes('raw provider text'), `${code} should not leak raw text`);
  }
});
