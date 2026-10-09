import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startTestServer, createClient, connectMailbox } from '../helpers/api.js';

async function withServer(fn, options = {}) {
  const ctx = await startTestServer(options);
  try { return await fn(ctx); } finally { await ctx.close(); }
}

async function signedIn(base) {
  const c = createClient(base);
  await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });
  return c;
}

// â”€â”€ AI settings (spec Â§7 / Â§31) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('api: AI settings expose the runtime catalog, not a hard-coded list', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.get('/api/ai/settings');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.catalog), 'the catalog is returned');
    assert.ok(res.body.catalog.length > 0);
    for (const m of res.body.catalog) assert.match(m.id, /^[^/]+\/[^/]+$/);
    assert.deepEqual(res.body.providers, ['opencode']);
    assert.ok(res.body.selection, 'the current selection is reported');
  });
});

test('api: selecting a model persists it and unknown models are rejected', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signedIn(base);

    const ok = await c.put('/api/ai/settings', { model: 'opencode/test-model' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.selection.model, 'opencode/test-model');
    assert.equal(system.aiRuntime.selection(1).model, 'opencode/test-model');

    const bad = await c.put('/api/ai/settings', { model: 'not-a-real/model' });
    assert.equal(bad.status, 422, 'a model OpenCode does not offer is rejected');
    assert.equal((await c.put('/api/ai/settings', {})).status, 422);
    assert.equal((await c.get('/api/ai/settings')).body.selection.model, 'opencode/test-model');
  });
});

test('api: AI diagnostics do not leak credentials', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.get('/api/ai/diagnostics');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!/access_token|refresh_token|client_secret/i.test(JSON.stringify(res.body)));
  });
});

// â”€â”€ Email connections (spec Â§6) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('api: email connections report provider availability without secrets', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.get('/api/email/connections');
    assert.equal(res.status, 200);
    assert.ok(res.body.providers.find((p) => p.id === 'google'));
    assert.ok(res.body.providers.find((p) => p.id === 'microsoft'));
    for (const p of res.body.providers) {
      assert.ok(!/token|secret/i.test(JSON.stringify(p.connection)), 'no credentials in state');
    }
  });
});

test('api: connecting an unconfigured or unknown provider fails clearly', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.post('/api/email/google/connect', {});
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'PROVIDER_NOT_CONFIGURED');
    assert.equal((await c.post('/api/email/pigeon/connect', {})).status, 502);
    assert.equal((await c.post('/api/email/pigeon/disconnect', {})).status, 502);
  });
});

test('api: a configured provider completes the full OAuth round trip', async () => {
  await withServer(async ({ base, email }) => {
    const c = await signedIn(base);
    email.configure('google');

    const connect = await c.post('/api/email/google/connect', {});
    assert.equal(connect.status, 200);
    assert.match(connect.body.authorizeUrl, /^https:\/\/oauth\.example\/google\?state=/);

    // The callback carries the state the server issued.
    const state = new URL(connect.body.authorizeUrl).searchParams.get('state');
    const done = await c.get(`/api/email/google/callback?code=abc&state=${state}`);
    assert.equal(done.status, 200);
    assert.equal(done.body.connection.status, 'connected');

    const list = await c.get('/api/email/connections');
    const google = list.body.providers.find((p) => p.id === 'google');
    assert.equal(google.connection.status, 'connected');
    assert.equal(google.connection.accountEmail, 'google@example.com');

    assert.equal((await c.post('/api/email/google/disconnect', {})).status, 200);
    const after = await c.get('/api/email/connections');
    assert.equal(after.body.providers.find((p) => p.id === 'google').connection.status, 'disconnected');
  });
});

test('api: the OAuth callback rejects a bad code, another user and any replay', async () => {
  await withServer(async ({ base, email }) => {
    email.configure('google');
    const ada = await signedIn(base);
    const issue = async () => {
      const r = await ada.post('/api/email/google/connect', {});
      return new URL(r.body.authorizeUrl).searchParams.get('state');
    };

    // A rejected exchange still burns the state: no second attempt on that link.
    const badCode = await issue();
    assert.equal((await ada.get(`/api/email/google/callback?code=bad-code&state=${badCode}`)).status, 502);
    assert.equal((await ada.get(`/api/email/google/callback?code=abc&state=${badCode}`)).status, 422,
      'a consumed link cannot be retried');

    // Another signed-in account must not be able to finish Ada's grant.
    const grace = createClient(base);
    await grace.signupAndLogin({ fullName: 'Grace', username: 'grace', securityQuestion: 'Q2?', securityAnswer: 'Compiler' });
    const crossUser = await issue();
    assert.equal((await grace.get(`/api/email/google/callback?code=abc&state=${crossUser}`)).status, 401);

    // A state that was never issued must not connect anything.
    assert.equal((await ada.get(`/api/email/google/callback?code=abc&state=1.999.forged`)).status, 422);

    // A fresh link works exactly once.
    const good = await issue();
    assert.equal((await ada.get(`/api/email/google/callback?code=abc&state=${good}`)).status, 200);
    assert.equal((await ada.get(`/api/email/google/callback?code=abc&state=${good}`)).status, 422,
      'a replayed link is rejected');
  });
});

test('api: the OAuth callback rejects a state this server never issued', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);

    const missing = await c.get('/api/email/google/callback');
    assert.equal(missing.status, 422);
    assert.match(missing.body.message, /authorization code/);

    for (const forged of ['notanumber.1.2', '999.1.2', '1.1.2', crypto.randomUUID()]) {
      const res = await c.get(`/api/email/google/callback?code=abc&state=${encodeURIComponent(forged)}`);
      assert.equal(res.status, 422, `"${forged}" must not be accepted`);
    }
  });
});

test('api: OAuth callbacks require an authenticated session', async () => {
  await withServer(async ({ base, email }) => {
    email.configure('google');
    const ada = await signedIn(base);
    const connect = await ada.post('/api/email/google/connect', {});
    const state = new URL(connect.body.authorizeUrl).searchParams.get('state');

    const anon = createClient(base);
    assert.equal((await anon.get(`/api/email/google/callback?code=abc&state=${state}`)).status, 401);
  });
});

test('api: the redirect URI is derived from the configured public base URL', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.get('/api/email/redirect-uri?provider=microsoft');
    assert.equal(res.status, 200);
    assert.match(res.body.redirectUri, /\/api\/email\/microsoft\/callback$/);
  });
});

// â”€â”€ Protocol behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('api: unknown routes 404, wrong methods 405, bad ids 422', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    assert.equal((await c.get('/api/does-not-exist')).status, 404);
    assert.equal((await c.del('/api/missions')).status, 405);
    assert.equal((await c.get('/api/missions/abc/activity')).status, 422);
  });
});

test('api: malformed JSON bodies are rejected', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const csrf = (await c.get('/api/auth/me')).body.csrfToken;
    const res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': csrf,
      },
      body: '{not json',
    });
    assert.ok([400, 422].includes(res.status), `expected a validation error, got ${res.status}`);
  });
});

test('api: the dashboard summarises only the caller\'s data', async () => {
  await withServer(async ({ system, base }) => {
    const ada = await signedIn(base);
    const { body } = await ada.post('/api/missions', {
      name: 'M', service: 'website_design',
      // Discovery must know which business type to scout for.
      targetDescription: 'restaurants with weak websites',
      windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
      locations: [{ country: 'US', city: 'Austin' }],
    });
    await connectMailbox(system.db, 1);   // otherwise the pipeline stops before outreach
    await ada.post(`/api/missions/${body.mission.id}/run-now`, {});
    await system.worker.drain();

    const res = await ada.get('/api/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.missions.total, 1);
    assert.equal(res.body.leads.discovered, 1);
    assert.equal(res.body.jobs.succeeded > 0, true);

    const grace = createClient(base);
    await grace.signupAndLogin({ fullName: 'Grace', username: 'grace', securityQuestion: 'First language?', securityAnswer: 'Analytical' });
    const graceDash = await grace.get('/api/dashboard');
    assert.equal(graceDash.body.missions.total, 0, "Grace sees none of Ada's work");
    assert.equal(graceDash.body.leads.discovered, 0);
  });
});

test('api: automation can be paused globally through the API', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signedIn(base);
    assert.equal((await c.post('/api/auth/automation-paused', { paused: true })).body.user.automationPaused, true);
    assert.equal((await system.db.get('SELECT automation_paused FROM users WHERE id = 1')).automation_paused, 1);
    assert.equal((await c.get('/api/dashboard')).body.automationPaused, true);
    assert.equal((await c.post('/api/auth/automation-paused', { paused: false })).body.user.automationPaused, false);
  });
});