import test from 'node:test';
import assert from 'node:assert/strict';

import { hashSecret, verifySecret, encrypt, decrypt, sha256 } from '../../src/core/crypto.js';
import {
  normalizeDomain, normalizeUrl, normalizeEmail, businessDedupeKey,
  normalizeBusinessName, normalizePhone, normalizeCountry, isValidTimeZone,
} from '../../src/core/normalize.js';
import {
  parseTimeToMinutes, formatMinutes, isWithinWindows, nextWindowStart,
  addDays, sqliteUtc, parseSqliteUtc,
} from '../../src/core/time.js';
import { extractJson } from '../../src/ai/runtime.js';
import { AppError, userFacingMessage } from '../../src/core/errors.js';

test('crypto: security answer is hashed and verifies (spec 5.2)', () => {
  const rec = hashSecret('my secret answer');
  assert.equal(rec.algo, 'scrypt');
  assert.ok(!JSON.stringify(rec).includes('my secret answer'), 'plaintext must not persist');
  assert.equal(verifySecret('my secret answer', rec), true);
  assert.equal(verifySecret('wrong answer', rec), false);
});

test('crypto: same secret produces different salts', () => {
  const a = hashSecret('same');
  const b = hashSecret('same');
  assert.notEqual(a.salt_hex, b.salt_hex);
  assert.notEqual(a.hash_hex, b.hash_hex);
});

test('crypto: tokens encrypt/decrypt and detect tampering (spec 5.3)', () => {
  const enc = encrypt('ya29.super-secret-refresh-token');
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes('super-secret'));
  assert.equal(decrypt(enc), 'ya29.super-secret-refresh-token');

  // Flip a bit in the ciphertext so the GCM auth tag can never match.
  // (Flipping trailing base64url characters is unreliable: the padding bits
  // can be changed without altering the decoded bytes.)
  const parts = enc.split(':');
  const raw = Buffer.from(parts[3], 'base64url');
  raw[0] ^= 0x01;
  const tampered = [parts[0], parts[1], parts[2], raw.toString('base64url')].join(':');
  assert.notEqual(tampered, enc);
  assert.throws(() => decrypt(tampered));
});

test('crypto: empty values are not encrypted', () => {
  assert.equal(encrypt(''), null);
  assert.equal(encrypt(null), null);
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
});

test('normalize: domains strip scheme, www and case', () => {
  assert.equal(normalizeDomain('https://WWW.Example.com/menu?x=1'), 'example.com');
  assert.equal(normalizeDomain('example.co.uk'), 'example.co.uk');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('not a domain'), null);
});

test('normalize: urls gain a scheme', () => {
  assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
});

test('normalize: emails are lowercased and domain-normalised', () => {
  assert.equal(normalizeEmail('  Info@WWW.Example.COM '), 'info@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b'), null);
});

test('normalize: business names drop legal suffixes and generic words', () => {
  assert.equal(normalizeBusinessName('ABC Restaurant LLC'), 'abc');
test('dedupe: same business via different inputs maps to one key (spec 29)', () => {
  const a = businessDedupeKey({ domain: 'www.abcrestaurant.com', businessName: 'ABC Restaurant' });
  const b = businessDedupeKey({ websiteUrl: 'https://abcrestaurant.com/', businessName: 'ABC Restaurant LLC' });
  assert.equal(a, b);

  const byName = businessDedupeKey({ businessName: 'ABC Restaurant LLC', city: 'Austin', country: 'US' });
  const byName2 = businessDedupeKey({ businessName: 'ABC Restaurant', city: 'Austin', country: 'US' });
  assert.equal(byName, byName2, 'name+locality fallback must be stable');
  assert.notEqual(a, byName, 'a website lead and a name-only lead differ');
});

test('normalize: phone, country, timezone validation', () => {
  assert.equal(normalizePhone('+1 (512) 555-0100'), '+15125550100');
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizeCountry('de'), 'DE');
  assert.equal(normalizeCountry('Germany'), null, 'spec 9 forbids vague geography');
  assert.equal(isValidTimeZone('Africa/Lagos'), true);
  assert.equal(isValidTimeZone('Mars/Phobos'), false);
});

test('time: parses and formats window times (spec 10)', () => {
  assert.equal(parseTimeToMinutes('10:00'), 600);
  assert.equal(parseTimeToMinutes('1:30 PM'), 810);
  assert.equal(parseTimeToMinutes('12:00 AM'), 0);
  assert.equal(parseTimeToMinutes('12:00 PM'), 720);
  assert.equal(parseTimeToMinutes('nonsense'), null);
  assert.equal(formatMinutes(600), '10:00');
  assert.equal(formatMinutes(0), '00:00');
});

test('time: window matching respects the mission timezone', () => {
  // 2026-02-10 is a Tuesday. 13:00Z === 14:00 in Africa/Lagos (UTC+1).
  const windows = [{ day_of_week: 2, start_min: 14 * 60, end_min: 18 * 60 }];
  assert.equal(isWithinWindows(windows, new Date('2026-02-10T13:30:00Z'), 'Africa/Lagos'), true);
  assert.equal(isWithinWindows(windows, new Date('2026-02-10T10:00:00Z'), 'Africa/Lagos'), false);
  assert.equal(isWithinWindows(windows, new Date('2026-02-11T13:30:00Z'), 'Africa/Lagos'), false);
  assert.equal(isWithinWindows([], new Date('2026-02-10T13:30:00Z'), 'UTC'), false);
});

test('time: window crossing midnight is handled', () => {
  // Window starts Tuesday 22:00 and therefore ends on Wednesday 02:00.
  const windows = [{ day_of_week: 2, start_min: 22 * 60, end_min: 2 * 60 }];
  assert.equal(isWithinWindows(windows, new Date('2026-02-10T22:30:00Z'), 'UTC'), true, 'start side, Tuesday');
  assert.equal(isWithinWindows(windows, new Date('2026-02-11T01:00:00Z'), 'UTC'), true, 'tail side, Wednesday');
  assert.equal(isWithinWindows(windows, new Date('2026-02-11T12:00:00Z'), 'UTC'), false, 'past the end');
  assert.equal(isWithinWindows(windows, new Date('2026-02-10T12:00:00Z'), 'UTC'), false, 'before the start');
});

test('time: nextWindowStart finds the upcoming session', () => {
  const windows = [
    { day_of_week: 1, start_min: 10 * 60, end_min: 13 * 60 },
    { day_of_week: 1, start_min: 17 * 60, end_min: 20 * 60 },
  ];
  const next = nextWindowStart(windows, new Date('2026-02-09T00:00:00Z'), 'UTC');
  assert.equal(next.toISOString(), '2026-02-09T10:00:00.000Z');
  assert.equal(nextWindowStart([], new Date('2026-02-09T00:00:00Z'), 'UTC'), null);
});

test('time: sqlite timestamp round-trip', () => {
  const s = sqliteUtc(new Date('2026-02-10T12:34:56.000Z'));
  assert.equal(s, '2026-02-10 12:34:56');
  assert.equal(parseSqliteUtc(s).toISOString(), '2026-02-10T12:34:56.000Z');
  assert.equal(addDays(new Date('2026-02-10T12:00:00Z'), 2).toISOString(), '2026-02-12T12:00:00.000Z');
});

test('ai: extractJson handles fences, prose and nested braces', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":[1,2]} done'), { a: [1, 2] });
  assert.deepEqual(extractJson('{"a":"} not a brace","b":2}'), { a: '} not a brace', b: 2 });
  assert.deepEqual(extractJson('{"a":"esc \\" quote","b":2}'), { a: 'esc " quote', b: 2 });
  assert.equal(extractJson('no json here'), null);
});

test('errors: transient vs permanent classification (spec 30)', () => {
  assert.equal(new AppError('TIMEOUT', 'x').retryable, true);
  assert.equal(new AppError('HTTP_5XX', 'x').retryable, true);
  assert.equal(new AppError('AI_PROVIDER_ERROR', 'x').retryable, true);
  assert.equal(new AppError('SUPPRESSED', 'x').retryable, false);
  assert.equal(new AppError('VALIDATION_FAILED', 'x').retryable, false);
});

test('errors: user-facing messages hide internals', () => {
  assert.match(userFacingMessage(new AppError('MAILBOX_AUTH_EXPIRED', 'raw token error')), /authorization expired/i);
  assert.match(userFacingMessage(new AppError('SUPPRESSED', 'raw')), /opted out/i);
  assert.match(userFacingMessage(new Error('internal stack stuff')), /unexpected error/i);
});
  assert.equal(normalizeBusinessName('The Blue Spoon Cafe'), 'blue spoon');
});