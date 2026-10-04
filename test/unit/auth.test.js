import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { AuthService } from '../../src/services/auth.js';
import { sqliteUtc } from '../../src/core/time.js';

function setup() {
  const db = createTestDb();
  return { db, auth: new AuthService({ db, sessionTtlHours: 72 }) };
}

const account = {
  fullName: 'Ada Lovelace',
  username: 'ada',
  securityQuestion: 'First programming language?',
  securityAnswer: 'Analytical Engine',
  timezone: 'Africa/Lagos',
};

test('auth: signup creates an account with a hashed answer (spec 5.2)', () => {
  const { db, auth } = setup();
  const { userId } = auth.signup(account);
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  assert.equal(user.username, 'ada');

  const cred = db.get('SELECT * FROM security_credentials WHERE user_id = ?', userId);
  assert.equal(cred.algo, 'scrypt');
  assert.ok(!cred.hash_hex.includes('Analytical'), 'the answer must never be stored in clear');
});

test('auth: duplicate usernames are rejected server-side (spec 5.1, test 32)', () => {
  const { auth } = setup();
  auth.signup(account);
  assert.throws(() => auth.signup(account), (e) => e.code === 'DUPLICATE_USERNAME');
  assert.throws(() => auth.signup({ ...account, username: 'ADA' }), (e) => e.code === 'DUPLICATE_USERNAME');
});

test('auth: username availability is checked before submitting', () => {
  const { auth } = setup();
  assert.equal(auth.isUsernameAvailable('ada').available, true);
  auth.signup(account);
  const res = auth.isUsernameAvailable('ada');
  assert.equal(res.available, false);
  assert.match(res.reason, /already taken/i);
  assert.equal(auth.isUsernameAvailable('a').available, false, 'format is validated too');
  assert.equal(auth.isUsernameAvailable('has space').available, false);
});

test('auth: login succeeds with the correct security answer', () => {
  const { auth } = setup();
  auth.signup(account);
  const res = auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });
  assert.ok(res.token && res.token.length > 20);
  assert.equal(res.user.username, 'ada');
});

test('auth: login rejects a wrong answer without revealing which part failed', () => {
  const { auth } = setup();
  auth.signup(account);
  assert.throws(
    () => auth.login({ username: 'ada', securityAnswer: 'wrong' }),
    (e) => e.code === 'UNAUTHENTICATED' && /Incorrect username or security answer/.test(e.message)
  );
  assert.throws(
    () => auth.login({ username: 'nobody', securityAnswer: 'x' }),
    (e) => e.code === 'UNAUTHENTICATED'
  );
});

test('auth: repeated failures trigger progressive lockout (spec 5.3)', () => {
  const { db, auth } = setup();
  auth.signup(account);

  // Schedule is [0,0,0,1,5,15,60,240]: the first two failures are tolerated,
  // the third arms a 1 minute lock, and each later failure lengthens it.
  for (let i = 0; i < 2; i++) {
    assert.throws(() => auth.login({ username: 'ada', securityAnswer: 'nope' }), (e) => e.code === 'UNAUTHENTICATED');
  }
  assert.throws(() => auth.login({ username: 'ada', securityAnswer: 'nope' }), (e) => e.code === 'LOCKED');

  const user = db.get('SELECT * FROM users WHERE username_lower = ?', 'ada');
  assert.ok(user.locked_until, 'a lock must be persisted');
  const lockedMs = new Date(`${user.locked_until.replace(' ', 'T')}Z`).getTime() - Date.now();
  assert.ok(lockedMs > 30_000 && lockedMs <= 60_000, `expected a ~1 minute lock, got ${lockedMs}ms`);
});
test('auth: a locked account refuses even the correct answer until it expires', () => {
  const { db, auth } = setup();
  auth.signup(account);
  for (let i = 0; i < 4; i++) {
    try { auth.login({ username: 'ada', securityAnswer: 'nope' }); } catch { /* expected */ }
  }
  assert.throws(
    () => auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' }),
    (e) => e.code === 'LOCKED'
  );

  // Simulate the lock elapsing.
  db.run('UPDATE users SET locked_until = ? WHERE username_lower = ?',
    sqliteUtc(new Date(Date.now() - 1000)), 'ada');
  assert.ok(auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' }).token);
});

test('auth: a successful login clears the failure counter', () => {
  const { db, auth } = setup();
  auth.signup(account);
  for (let i = 0; i < 2; i++) {
    try { auth.login({ username: 'ada', securityAnswer: 'nope' }); } catch { /* expected */ }
  }
  auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });
  assert.equal(db.get('SELECT failed_attempts FROM users WHERE username_lower = ?', 'ada').failed_attempts, 0);
});

test('auth: sessions resolve, touch and revoke (spec 5.3)', () => {
  const { auth } = setup();
  auth.signup(account);
  const { token } = auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });

  assert.equal(auth.resolveSession(token).username, 'ada');
  assert.equal(auth.resolveSession('garbage'), null);
  assert.equal(auth.resolveSession(null), null);

  auth.logout(token);
  assert.equal(auth.resolveSession(token), null, 'revoked sessions must not resolve');
});

test('auth: expired sessions are rejected', () => {
  const { db, auth } = setup();
  auth.signup(account);
  const { token } = auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });
  db.run('UPDATE sessions SET expires_at = ?', sqliteUtc(new Date(Date.now() - 1000)));
  assert.equal(auth.resolveSession(token), null);
});

test('auth: session tokens are never stored in the clear', () => {
  const { db, auth } = setup();
  auth.signup(account);
  const { token } = auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });
  const rows = db.all('SELECT id FROM sessions');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, token);
});

test('auth: signup validates its inputs', () => {
  const { auth } = setup();
  assert.throws(() => auth.signup({ ...account, fullName: 'A' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.throws(() => auth.signup({ ...account, username: 'no spaces allowed' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.throws(() => auth.signup({ ...account, securityAnswer: 'x' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.throws(() => auth.signup({ ...account, securityQuestion: '' }), (e) => e.code === 'VALIDATION_FAILED');
});

test('auth: important account events are audited (spec 5.3)', () => {
  const { db, auth } = setup();
  auth.signup(account);
  auth.login({ username: 'ada', securityAnswer: 'Analytical Engine' });
  const actions = db.all('SELECT action FROM audit_events ORDER BY id').map((r) => r.action);
  assert.deepEqual(actions, ['account.created', 'auth.login']);
});

test('auth: pause all automation is persisted (spec 26)', () => {
  const { auth } = setup();
  const { userId } = auth.signup(account);
  assert.equal(auth.setAutomationPaused(userId, true).automationPaused, true);
  assert.equal(auth.setAutomationPaused(userId, false).automationPaused, false);
});