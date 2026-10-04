import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient, connectMailbox } from '../helpers/api.js';

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

/** Two fully signed-in clients against the same server. */
async function twoUsers(base) {
  const ada = createClient(base);
  await ada.signupAndLogin({
    fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical',
  });
  const grace = createClient(base);
  await grace.signupAndLogin({
    fullName: 'Grace', username: 'grace', securityQuestion: 'First language?', securityAnswer: 'Compiler',
  });
  return { ada, grace };
}

/** Signed-in client with a valid account (answers must be 3+ characters). */
async function signedIn(base, username = 'ada') {
  const c = createClient(base);
  await c.signupAndLogin({
    fullName: 'Ada', username,
    securityQuestion: 'First language?', securityAnswer: 'Analytical',
  });
  return c;
}

// ── §33 Changing the service ──────────────────────────────────────

test('§33 api: changing the service changes scouting instead of reusing website rules', async () => {
  await withServer(async ({ system, base, discovery }) => {
    const c = await signedIn(base);
    const { body } = await c.post('/api/missions', MISSION);
    const id = body.mission.id;
    await c.post(`/api/missions/${id}/activate`, {});
    connectMailbox(system.db, 1);

    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();
    assert.deepEqual(discovery.calls[0].types, ['restaurant'], 'a website mission scouts restaurants');

    // Switch the mission to email marketing for a different business type.
    const changed = await c.patch(`/api/missions/${id}`, {
      service: 'email_marketing',
      targetDescription: 'dental practices that ignore appointment reminders',
      offerSummary: 'monthly appointment reminder campaign',
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.mission.service, 'email_marketing');
    assert.equal(
      system.db.get('SELECT service FROM missions WHERE id = ?', id).service, 'email_marketing',
      'the change is persisted, not just echoed'
    );

    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();

    // The next run scouts the NEW type — website-specific rules are not reused.
    assert.deepEqual(discovery.calls.at(-1).types, ['dentist']);
    assert.ok(!discovery.calls.some((x) => x.types.includes('restaurant') && x === discovery.calls.at(-1)));

    // Leads already qualified under the old service are not retroactively
    // re-judged by the new service; only new discoveries are.
    const leads = system.leads.list(1, { limit: 100 });
    assert.ok(leads.length >= 2, 'both runs produced leads');
    assert.ok(leads.every((l) => l.mission_id === id), 'every lead belongs to this mission');
  });
});

// ── §34 Changing geography ────────────────────────────────────────

test('§34 api: USA only, then USA + Germany + Spain + Italy, filters and labels leads', async () => {
  await withServer(async ({ system, base, discovery }) => {
    const c = await signedIn(base);
    const { body } = await c.post('/api/missions', MISSION);
    const id = body.mission.id;
    await c.post(`/api/missions/${id}/activate`, {});
    connectMailbox(system.db, 1);

    // Phase 1 — USA only.
    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();
    assert.equal(discovery.calls.length, 1);
    assert.equal(discovery.calls[0].country, 'US');
    assert.equal(discovery.calls[0].city, 'Austin');

    const usaLeads = system.leads.list(1, { limit: 100 });
    assert.equal(usaLeads.length, 1);
    assert.equal(usaLeads[0].country, 'US', 'the lead carries its country');
    assert.equal(usaLeads[0].city, 'Austin');

    // Phase 2 — widen to four countries by editing the mission's locations.
    const widened = await c.patch(`/api/missions/${id}`, {
      locations: [
        { country: 'US', city: 'Austin', priority: 'high' },
        { country: 'DE', city: 'Berlin', priority: 'high' },
        { country: 'ES', city: 'Madrid', priority: 'normal' },
        { country: 'IT', city: 'Rome', priority: 'normal' },
      ],
    });
    assert.equal(widened.status, 200);
    // Locations come back ranked by priority, then country (not input order).
    assert.deepEqual(
      widened.body.mission.locations.map((l) => l.country), ['DE', 'US', 'ES', 'IT']
    );
    assert.deepEqual(
      widened.body.mission.locations.map((l) => l.priority), ['high', 'high', 'medium', 'medium']
    );

    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();

    // One discovery job per location, each carrying its own country filter.
    const countries = discovery.calls.slice(1).map((x) => x.country).sort();
    assert.deepEqual(countries, ['DE', 'ES', 'IT', 'US']);
    for (const call of discovery.calls.slice(1)) {
      assert.ok(['US', 'DE', 'ES', 'IT'].includes(call.country), 'every call is scoped to a target country');
    }

    // Country metadata on every discovered lead: the original US lead plus one
    // new lead per location in the widened set.
    const all = system.leads.list(1, { limit: 100 });
    assert.equal(all.length, 5, 'the first run plus one lead per widened location');
    assert.deepEqual([...new Set(all.map((l) => l.country))].sort(), ['DE', 'ES', 'IT', 'US']);
    for (const lead of all) {
      assert.ok(lead.country && lead.country.length === 2, 'country is normalised to an ISO-2 code');
    }

    // The API reports the same per-country breakdown.
    const listed = await c.get('/api/leads');
    assert.equal(listed.body.leads.length, 5);
    assert.deepEqual(
      listed.body.leads.map((l) => l.country).sort(), ['DE', 'ES', 'IT', 'US', 'US']
    );
  });
});

// ── Missions ─────────────────────────────────────────────────────

test('api: missions can be created, read, updated and deleted', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });

    const created = await c.post('/api/missions', MISSION);
    assert.equal(created.status, 201);
    const id = created.body.mission.id;
    assert.equal(created.body.mission.name, 'Restaurant Website Redesign');
    assert.equal(created.body.mission.windows.length, 1);
    assert.equal(created.body.mission.locations[0].country, 'US');

    assert.equal((await c.get(`/api/missions/${id}`)).body.mission.sendingMode, 'autopilot');

    const updated = await c.patch(`/api/missions/${id}`, { sendingMode: 'scout_only', name: 'Renamed' });
    assert.equal(updated.body.mission.sendingMode, 'scout_only');
    assert.equal(updated.body.mission.name, 'Renamed');
    assert.equal((await c.get('/api/missions')).body.missions.length, 1);

    assert.equal((await c.del(`/api/missions/${id}`)).body.mission.status, 'archived');
    assert.equal((await c.get('/api/missions')).body.missions.length, 0, 'archived missions are hidden');
  });
});

test('api: mission creation validates its configuration', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });

    assert.equal((await c.post('/api/missions', { name: '' })).status, 422);
    assert.equal((await c.post('/api/missions', { name: 'X', timezone: 'Mars/Phobos' })).status, 422);
    assert.equal((await c.post('/api/missions', { name: 'X', sendingMode: 'nonsense' })).status, 422);
    // Spec §9: a vague geography is rejected.
    const geo = await c.post('/api/missions', { ...MISSION, locations: [{ country: 'Middle East' }] });
    assert.equal(geo.status, 422);
    assert.match(geo.body.message, /ISO country code/);
  });
});

test('api: the mission lifecycle drives real state', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });
    const { body } = await c.post('/api/missions', MISSION);
    const id = body.mission.id;

    assert.equal((await c.post(`/api/missions/${id}/activate`, {})).body.mission.status, 'scheduled');
    assert.ok((await c.get(`/api/missions/${id}`)).body.mission.nextRunAt, 'activation sets the next window');
    assert.equal((await c.post(`/api/missions/${id}/pause`, {})).body.mission.status, 'paused');
    assert.equal((await c.post(`/api/missions/${id}/resume`, {})).body.mission.status, 'scheduled');
    assert.equal((await c.post(`/api/missions/${id}/stop`, {})).body.mission.status, 'stopped');

    const copy = await c.post(`/api/missions/${id}/duplicate`, {});
    assert.equal(copy.status, 201);
    assert.match(copy.body.mission.name, /\(copy\)$/);
    assert.equal(copy.body.mission.sendingMode, 'scout_only', 'a duplicate starts in the safest mode');
  });
});

test('api: activation requires a schedule and a country', async () => {
  await withServer(async ({ base }) => {
    const c = createClient(base);
    await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });
    const { body } = await c.post('/api/missions', { name: 'Bare' });
    const res = await c.post(`/api/missions/${body.mission.id}/activate`, {});
    assert.equal(res.status, 422);
    assert.match(res.body.message, /scouting window/);
  });
});

test('api: run-now enqueues through the real queue, not a direct handler call', async () => {
  await withServer(async ({ system, base }) => {
    const c = createClient(base);
    await c.signupAndLogin({ fullName: 'Ada', username: 'ada', securityQuestion: 'First language?', securityAnswer: 'Analytical' });
    connectMailbox(system.db, 1);   // the pipeline needs a mailbox to reach outreach
    const { body } = await c.post('/api/missions', MISSION);
    const res = await c.post(`/api/missions/${body.mission.id}/run-now`, {});
    assert.equal(res.status, 202);
    assert.equal(res.body.enqueued, 1);

    const queued = system.db.get("SELECT * FROM automation_jobs WHERE stage = 'discovery'");
    assert.ok(queued, 'a discovery job was persisted for the worker');
    assert.equal(queued.mission_id, body.mission.id);

    // Draining runs the whole pipeline through the normal architecture.
    await system.worker.drain();
    assert.equal(system.leads.list(1).length, 1, 'the pipeline completed from an API-triggered job');
  });
});

// ── Cross-user authorization ──────────────────────────────────────

test('api: one user cannot read or change another user\'s mission', async () => {
  await withServer(async ({ base }) => {
    const { ada, grace } = await twoUsers(base);
    const { body } = await ada.post('/api/missions', MISSION);
    const id = body.mission.id;

    assert.equal((await grace.get(`/api/missions/${id}`)).status, 404);
    assert.equal((await grace.patch(`/api/missions/${id}`, { name: 'stolen' })).status, 404);
    assert.equal((await grace.post(`/api/missions/${id}/activate`, {})).status, 404);
    assert.equal((await grace.del(`/api/missions/${id}`)).status, 404);
    assert.equal((await grace.get(`/api/missions/${id}/activity`)).status, 404);

    assert.equal((await grace.get('/api/missions')).body.missions.length, 0);
    assert.equal((await ada.get(`/api/missions/${id}`)).body.mission.name, 'Restaurant Website Redesign');
  });
});

test('api: leads, conversations and messages are isolated per user', async () => {
  await withServer(async ({ system, base }) => {
    const { ada, grace } = await twoUsers(base);
    connectMailbox(system.db, 1);
    const { body } = await ada.post('/api/missions', MISSION);
    const missionId = body.mission.id;
    await ada.post(`/api/missions/${missionId}/run-now`, {});
    await system.worker.drain();

    const lead = system.leads.list(1)[0];
    assert.ok(lead, 'Ada has a lead');

    assert.equal((await ada.get(`/api/leads/${lead.id}`)).status, 200);
    assert.equal((await grace.get(`/api/leads/${lead.id}`)).status, 404);
    assert.equal((await grace.get('/api/leads')).body.leads.length, 0);

    const conversation = system.conversations.getFor(lead.id, missionId);
    assert.equal((await ada.get(`/api/conversations/${conversation.id}`)).status, 200);
    assert.equal((await grace.get(`/api/conversations/${conversation.id}`)).status, 404);
    assert.equal((await grace.get('/api/conversations')).body.conversations.length, 0);

    const message = system.db.get('SELECT * FROM outreach_messages LIMIT 1');
    assert.equal((await ada.post(`/api/messages/${message.id}/approve`, {})).status, 200);
    assert.equal((await grace.post(`/api/messages/${message.id}/approve`, {})).status, 404);
  });
});

test('api: notifications, suppressions and activity are per user', async () => {
  await withServer(async ({ base }) => {
    const { ada, grace } = await twoUsers(base);

    ada.setCsrf((await ada.get('/api/auth/me')).body.csrfToken);

    assert.equal((await ada.post('/api/suppressions', {
      scope: 'email', value: 'blocked@example.com', reason: 'asked to stop',
    })).status, 201);
    assert.equal((await ada.get('/api/suppressions')).body.suppressions.length, 1);
    assert.equal((await grace.get('/api/suppressions')).body.suppressions.length, 0);

    // Invalid suppression values are rejected, not stored.
    const bad = await ada.post('/api/suppressions', { scope: 'email', value: 'not-an-email' });
    assert.equal(bad.status, 422);

    const listed = await ada.get('/api/suppressions');
    await ada.del(`/api/suppressions/${listed.body.suppressions[0].id}`);
    assert.equal((await ada.get('/api/suppressions')).body.suppressions.length, 0);

    assert.equal((await ada.get('/api/activity')).status, 200);
    assert.equal((await grace.get('/api/notifications')).body.notifications.length, 0);
  });
});