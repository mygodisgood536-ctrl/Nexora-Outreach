import test from 'node:test';
import assert from 'node:assert/strict';

// The webhook secret is read from the environment when config is imported, and
// node:test runs each file in its own process — so setting it here, before the
// dynamic import pulls in src/config.js, is deterministic.
process.env.WEBHOOK_SECRET = 'test-webhook-secret';

const { startTestServer, createClient, connectMailbox } = await import('../helpers/api.js');

const ACCOUNT = {
  fullName: 'Ada Lovelace',
  securityQuestion: 'First programming language?',
  securityAnswer: 'Analytical Engine',
  timezone: 'UTC',
};

const MISSION = {
  name: 'Restaurant Website Redesign',
  service: 'website_design',
  sendingMode: 'autopilot',
  targetDescription: 'restaurants with weak websites',
  offerSummary: 'free-first website redesign',
  windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
  locations: [{ country: 'US', city: 'Austin', priority: 'high' }],
};

async function withServer(fn) {
  const ctx = await startTestServer();
  try { return await fn(ctx); } finally { await ctx.close(); }
}

async function signUp(base, username = 'ada') {
  const c = createClient(base);
  await c.signupAndLogin({ ...ACCOUNT, username });
  return c;
}

/** Run the real pipeline to a sent message and return the contacted lead. */
async function contactedLead(system, c) {
  await connectMailbox(system.db, 1);
  const { body } = await c.post('/api/missions', MISSION);
  await c.post(`/api/missions/${body.mission.id}/activate`, {});
  await c.post(`/api/missions/${body.mission.id}/run-now`, {});
  await system.worker.drain();
  const lead = (await system.leads.list(1))[0];
  assert.equal(lead.status, 'sent', 'the pipeline reached the sending stage');
  return lead;
}

// ── GAP: natural-language mission interpretation (spec §8) ──────────────

test('api: a plain-language objective is interpreted into a reviewable draft (spec 8)', async () => {
  await withServer(async ({ base }) => {
    const anon = createClient(base);
    const unauth = await anon.post('/api/missions/interpret', { objective: 'Find restaurants without mobile sites in Austin' });
    assert.equal(unauth.status, 401, 'interpretation is not an anonymous service');

    const c = await signUp(base);
    const res = await c.post('/api/missions/interpret', {
      objective: 'Find restaurants with weak websites around Austin, USA and offer a free redesign',
    });
    assert.equal(res.status, 200);
    const i = res.body.interpretation;
    assert.equal(i.service, 'website_design');
    assert.deepEqual(i.countries, ['US'], 'countries come back as ISO codes');
    assert.ok(Array.isArray(i.qualification_bar) && i.qualification_bar.length > 0);
    assert.ok(i.outreach_instructions && typeof i.outreach_instructions === 'object');
    assert.equal(typeof i.model, 'string', 'the model that served the call is reported');

    // Interpretation is a dry run: nothing is created.
    assert.equal((await c.get('/api/missions')).body.missions.length, 0);
  });
});

test('api: interpreting rejects an objective too short to act on', async () => {
  await withServer(async ({ base }) => {
    const c = await signUp(base);
    const res = await c.post('/api/missions/interpret', { objective: 'hi' });
    assert.equal(res.status, 422);
  });
});

// ── GAP: bounce and complaint ingestion (spec §17) ──────────────────────

test('api: a reported hard bounce suppresses the recipient and closes the lead (spec 17)', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signUp(base);
    const lead = await contactedLead(system, c);
    assert.ok(lead.email_public, 'the pipeline recorded a contact address');

    const res = await c.post('/api/email/events', {
      type: 'bounce', email: lead.email_public, hard: true,
      reason: '550 mailbox unavailable', provider: 'google',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.suppressed, 1);
    assert.equal(res.body.leadsUpdated, 1);
    assert.equal((await system.leads.get(lead.id)).status, 'suppressed');

    const list = await c.get('/api/suppressions');
    assert.equal(list.status, 200);
    assert.ok(list.body.suppressions.some((s) => s.value === lead.email_public && s.scope === 'bounce'));
  });
});

test('api: a soft bounce is audited but does not suppress the recipient', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signUp(base);
    const lead = await contactedLead(system, c);

    const res = await c.post('/api/email/events', {
      type: 'bounce', email: lead.email_public, hard: false, reason: '452 mailbox full',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.suppressed, 0, 'a temporary failure must not block a working address');
    assert.equal((await system.leads.get(lead.id)).status, 'sent');
  });
});

test('api: provider webhooks need the shared secret (spec 17)', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signUp(base);
    const lead = await contactedLead(system, c);
    const provider = createClient(base);

    assert.equal(
      (await provider.post('/api/email/events', { type: 'complaint', email: lead.email_public })).status,
      401, 'an anonymous caller without the secret is rejected',
    );
    assert.equal(
      (await provider.post('/api/email/events',
        { type: 'complaint', email: lead.email_public },
        { headers: { 'x-nexora-webhook-secret': 'wrong-secret' } })).status,
      401,
    );

    const ok = await provider.post('/api/email/events',
      { type: 'complaint', email: lead.email_public, provider: 'google' },
      { headers: { 'x-nexora-webhook-secret': 'test-webhook-secret' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.suppressed, 1);
    assert.equal((await system.leads.get(lead.id)).status, 'suppressed');
  });
});

test('api: delivery events validate input and unknown recipients', async () => {
  await withServer(async ({ base }) => {
    const c = await signUp(base);
    assert.equal((await c.post('/api/email/events', { type: 'nonsense', email: 'a@b.com' })).status, 422);
    assert.equal((await c.post('/api/email/events', { type: 'bounce', email: 'not-an-email' })).status, 422);

    // A secret-carrying webhook for an address nobody contacted has no owner.
    const provider = createClient(base);
    const missing = await provider.post('/api/email/events',
      { type: 'bounce', email: 'nobody@example.com' },
      { headers: { 'x-nexora-webhook-secret': 'test-webhook-secret' } });
    assert.equal(missing.status, 404);
  });
});