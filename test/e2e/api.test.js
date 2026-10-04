import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient, startTestApp } from '../helpers/api.js';

const ACCOUNT = {
  fullName: 'Ada Lovelace',
  username: 'ada',
  securityQuestion: 'First programming language?',
  securityAnswer: 'Analytical Engine',
  timezone: 'Africa/Lagos',
};

const MISSION = {
  name: 'Restaurant Website Redesign',
  service: 'website_design',
  sendingMode: 'autopilot',
  timezone: 'UTC',
  targetDescription: 'restaurants with weak websites',
  offerSummary: 'free-first website redesign',
  windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
  locations: [{ country: 'US', city: 'Austin', priority: 'high' }],
};

async function withServer(fn) {
  const ctx = await startTestServer();
  try { return await fn(ctx); } finally { await ctx.close(); }
}

test('app: the real entry point boots API + scheduler + worker and stops cleanly', async () => {
  const ctx = await startTestApp();
  try {
    // All three subsystems are live.
    assert.equal(ctx.system.scheduler.running, true);
    assert.equal(ctx.system.worker.running, true);

    const health = await fetch(`${ctx.base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // A real signup works against the booted application.
    const c = createClient(ctx.base);
    const created = await c.post('/api/auth/signup', ACCOUNT);
    assert.equal(created.status, 201);
    assert.equal((await c.get('/api/auth/me')).status, 200);
  } finally {
    await ctx.app.stop('SIGTERM');
  }

  assert.equal(ctx.app.stopped, true);
  assert.equal(ctx.system.scheduler.running, false, 'the scheduler stopped');
  assert.equal(ctx.system.worker.running, false, 'the worker stopped');
  await assert.rejects(() => fetch(`${ctx.base}/api/health`), 'the HTTP listener is closed');

  // Stopping twice is harmless, so a repeated signal cannot corrupt state.
  await ctx.app.stop('SIGINT');
  assert.equal(ctx.app.stopped, true);
});

// ── Health & auth ────────────────────────────────────────────────

test('app: shutdown does not wait out a poll interval', async () => {
  const ctx = await startTestApp();
  // The scheduler and worker poll on long intervals by default. Stopping must
  // cut the sleep short instead of blocking until the next tick.
  ctx.system.scheduler.pollMs = 30000;
  ctx.system.worker.pollMs = 30000;
  const startedAt = Date.now();
  await ctx.app.stop('SIGTERM');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5000, `shutdown took ${elapsed}ms; it must not wait for the poll interval`);
});

test('api: health is public', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

test('api: signup creates an account, sets a session cookie and returns the user', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    const res = await c.post('/api/auth/signup', ACCOUNT);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'ada');

    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /nexora_session=/);
    assert.match(cookie, /HttpOnly/, 'session cookie must be HttpOnly');
    assert.match(cookie, /SameSite=Lax/);
    assert.ok(!cookie.includes('Secure=') || process.env.NODE_ENV === 'production');
  });
});

test('api: duplicate username is rejected with 409 (spec 5.1)', async () => {
  await withServer(async ({ base }) => {
    const a = createClient(base);
    assert.equal((await a.post('/api/auth/signup', ACCOUNT)).status, 201);
    const b = createClient(base);
    const res = await b.post('/api/auth/signup', ACCOUNT);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'DUPLICATE_USERNAME');
  });
});

test('api: username availability endpoint works for taken and free names', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);
    const taken = await c.get('/api/auth/username-available?username=ada');
    assert.equal(taken.body.available, false);
    const free = await c.get('/api/auth/username-available?username=grace');
    assert.equal(free.body.available, true);
  });
});

test('api: login succeeds with the security answer and fails without', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);

    const bad = createClient(base);
    const badRes = await bad.post('/api/auth/login', { username: 'ada', securityAnswer: 'nope' });
    assert.equal(badRes.status, 401);
    assert.equal(badRes.body.error, 'UNAUTHENTICATED');

    const good = createClient(base);
    const ok = await good.post('/api/auth/login', { username: 'ada', securityAnswer: 'Analytical Engine' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.username, 'ada');
    assert.equal((await good.get('/api/auth/me')).status, 200);
  });
});

test('api: a recovery code is issued once at signup and never stored in the clear', async () => {
  await withServer(async ({ system, base }) => {
    const c = createClient(base);
    const created = await c.post('/api/auth/signup', ACCOUNT);
    assert.equal(created.status, 201);
    assert.match(created.body.recoveryCode, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);

    const stored = system.db.get('SELECT * FROM recovery_codes WHERE user_id = 1');
    assert.ok(stored, 'a recovery code row exists');
    assert.equal(stored.used_at, null);
    assert.ok(!stored.code_hash.includes(created.body.recoveryCode), 'only a hash is stored');

    // It is never echoed back on a later read.
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.recoveryCode, undefined);
    assert.ok(!JSON.stringify(me.body).includes(created.body.recoveryCode));
  });
});

test('api: recovery sets a new answer, revokes old sessions and cannot be reused', async () => {
  await withServer(async ({ base }) => {
    const thief = createClient(base);
    const created = await thief.post('/api/auth/signup', ACCOUNT);
    const code = created.body.recoveryCode;
    // The thief is signed in on a session the recovery must kill.
    assert.equal((await thief.get('/api/auth/me')).status, 200);

    const attacker = createClient(base);
    const res = await attacker.post('/api/auth/recover', {
      username: ACCOUNT.username, recoveryCode: code, newSecurityAnswer: 'Difference Engine',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, ACCOUNT.username);

    // The pre-recovery session is dead immediately.
    assert.equal((await thief.get('/api/auth/me')).status, 401,
      'a session open before recovery no longer authenticates');

    // The recovered session works and the new answer is the one that logs in.
    assert.equal((await attacker.get('/api/auth/me')).status, 200);
    assert.equal(
      (await attacker.post('/api/auth/login', {
        username: ACCOUNT.username, securityAnswer: 'Difference Engine',
      })).status, 200);
    assert.equal(
      (await attacker.post('/api/auth/login', {
        username: ACCOUNT.username, securityAnswer: ACCOUNT.securityAnswer,
      })).status, 401, 'the old answer no longer works');

    // The code is single-use.
    const replay = createClient(base);
    assert.equal((await replay.post('/api/auth/recover', {
      username: ACCOUNT.username, recoveryCode: code, newSecurityAnswer: 'Another Answer',
    })).status, 401, 'a recovery code cannot be redeemed twice');
  });
});

test('api: recovery refuses a wrong code and does not reveal whether a user exists', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);

    const wrong = await c.post('/api/auth/recover', {
      username: ACCOUNT.username, recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD', newSecurityAnswer: 'New Answer',
    });
    assert.equal(wrong.status, 401);

    const unknown = await c.post('/api/auth/recover', {
      username: 'nobody', recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD', newSecurityAnswer: 'New Answer',
    });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.message, wrong.body.message,
      'an unknown user and a wrong code are indistinguishable');

    assert.equal((await c.post('/api/auth/recover', {
      username: ACCOUNT.username, recoveryCode: 'AAAAA-BBBBB-CCCCC-DDDDD', newSecurityAnswer: 'x',
    })).status, 422, 'the new answer is still validated');

    // Nothing changed: the original answer still logs in.
    assert.equal((await c.post('/api/auth/login', {
      username: ACCOUNT.username, securityAnswer: ACCOUNT.securityAnswer,
    })).status, 200);
  });
});

test('api: protected endpoints reject anonymous callers with 401', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    for (const path of ['/api/auth/me', '/api/missions', '/api/leads', '/api/dashboard', '/api/activity']) {
      const res = await c.get(path);
      assert.equal(res.status, 401, `${path} must require auth`);
      assert.equal(res.body.error, 'UNAUTHENTICATED');
    }
  });
});

test('api: a tampered session cookie does not authenticate', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);
    const forged = c.jar.get('nexora_session');
    c.jar.set('nexora_session', `${forged.slice(0, -4)}AAAA`);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});

// ── CSRF ─────────────────────────────────────────────────────────

test('api: state-changing requests require a CSRF token', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);
    await c.get('/api/auth/me');   // captures a valid token

    const noToken = await c.post('/api/missions', MISSION, { withCsrf: false });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.body.error, 'CSRF_FAILED');

    c.clearCsrf();
    const wrongToken = await c.post('/api/missions', MISSION, { withCsrf: true });
    assert.equal(wrongToken.status, 403);
  });
});

test('api: GET requests do not require a CSRF token', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);
    c.clearCsrf();
    assert.equal((await c.get('/api/missions')).status, 200);
  });
});

test('api: logout revokes the session immediately', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.post('/api/auth/signup', ACCOUNT);
    const me = await c.get('/api/auth/me');
    c.setCsrf(me.body.csrfToken);
    assert.equal((await c.post('/api/auth/logout', {})).status, 200);
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
});