import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { MissionService } from '../../src/services/missions.js';
import { LeadService } from '../../src/services/leads.js';
import { SuppressionService } from '../../src/services/suppression.js';
import { EmailConnectionStore } from '../../src/services/email-store.js';

async function fixture() {
  const db = await createTestDb();
  // The async database layer applies the schema explicitly; every test needs a
  // migrated database before the services can touch it (migrate() is idempotent).
  await db.migrate();
  await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
     VALUES('T','t','t','q?',0)`
  );
  const userId = (await db.get('SELECT id FROM users WHERE username_lower=?', 't')).id;
  return {
    db, userId,
    missions: new MissionService({ db }),
    leads: new LeadService({ db }),
    suppression: new SuppressionService({ db }),
    emailStore: new EmailConnectionStore({ db }),
  };
}

const windows = [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }];
const locations = [{ country: 'US', priority: 'high' }];

test('missions: create stores configuration and defaults (spec 8)', async () => {
  const { missions, userId } = await fixture();
  const m = await missions.create(userId, {
    name: 'Restaurant Website Redesign',
    service: 'website_design',
    sending_mode: 'autopilot',
    timezone: 'Africa/Lagos',
    windows,
    locations,
  });
  assert.equal(m.name, 'Restaurant Website Redesign');
  assert.equal(m.sending_mode, 'autopilot');
  assert.equal(m.max_follow_ups, 3);
  assert.equal((await missions.windows(m.id)).length, 1);
  assert.equal((await missions.locations(m.id))[0].country, 'US');
});

test('missions: activation requires a schedule and a country', async () => {
  const { missions, userId } = await fixture();
  const bare = await missions.create(userId, { name: 'Bare' });
  await assert.rejects(async () => missions.activate(bare.id, userId), (e) => /scouting window/.test(e.message));

  const partial = await missions.create(userId, { name: 'Partial', windows });
  await assert.rejects(async () => missions.activate(partial.id, userId), (e) => /target country/.test(e.message));

  const ready = await missions.create(userId, { name: 'Ready', windows, locations });
  const activated = await missions.activate(ready.id, userId);
  assert.equal(activated.status, 'scheduled');
  assert.ok(activated.next_run_at, 'activation computes the next scouting window');
});

test('missions: country must be a real ISO code, never a vague region (spec 9)', async () => {
  const { missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'Geo' });
  await assert.rejects(
    async () => missions.setLocations(m.id, [{ country: 'Middle East' }]),
    (e) => /ISO country code/.test(e.message)
  );
  await assert.rejects(
    async () => missions.setLocations(m.id, [{ country: 'Arab' }]),
    (e) => /ISO country code/.test(e.message)
  );
  const ok = await missions.setLocations(m.id, [
    { country: 'us', priority: 'high' },
    { country: 'de', priority: 'medium' },
    { country: 'AE', priority: 'low' },
  ]);
  assert.deepEqual(ok.map((l) => l.country), ['US', 'DE', 'AE'], 'ordered by priority rank, not alphabetically');
  assert.equal(ok.find((l) => l.country === 'US').priority, 'high', 'priority is preserved');
});

test('missions: windows accept multiple ranges and reject nonsense (spec 10)', async () => {
  const { missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'Sched' });
  const w = await missions.setWindows(m.id, [
    { dayOfWeek: 1, startMin: '10:00', endMin: '13:00' },
    { dayOfWeek: 1, startMin: '17:00', endMin: '20:00' },
    { dayOfWeek: 2, startMin: 0, endMin: 240 },
  ]);
  assert.equal(w.length, 3);
  assert.equal(w[0].start_min, 600);
  assert.equal(w[2].end_min, 240);
  await assert.rejects(async () => missions.setWindows(m.id, [{ dayOfWeek: 9, startMin: '10:00', endMin: '11:00' }]));
  await assert.rejects(async () => missions.setWindows(m.id, [{ dayOfWeek: 1, startMin: 'nope', endMin: '11:00' }]));
  await assert.rejects(async () => missions.setWindows(m.id, [{ dayOfWeek: 1, startMin: '10:00', endMin: '10:00' }]));
});

test('missions: pause, resume and stop change real state (spec 26)', async () => {
  const { missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'Ctrl', windows, locations });
  await missions.activate(m.id, userId);
  assert.equal((await missions.pause(m.id, userId)).status, 'paused');
  assert.equal((await missions.resume(m.id, userId)).status, 'scheduled');
  assert.equal((await missions.stop(m.id, userId)).status, 'stopped');
  assert.equal((await missions.archive(m.id, userId)).status, 'archived');
});

test('missions: ownership is enforced on every access', async () => {
  const { missions, db, userId } = await fixture();
  const m = await missions.create(userId, { name: 'Mine', windows, locations });
  await db.run(`INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
          VALUES('O','other','other','q?',0)`);
  const other = (await db.get('SELECT id FROM users WHERE username_lower=?', 'other')).id;
  await assert.rejects(async () => missions.getForUser(m.id, other), (e) => e.code === 'NOT_FOUND');
});

test('missions: duplicate copies config but resets to the safest sending mode', async () => {
  const { missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'Orig', sending_mode: 'autopilot', windows, locations });
  await missions.activate(m.id, userId);
  const copy = await missions.duplicate(m.id, userId);
  assert.equal(copy.name, 'Orig (copy)');
  assert.equal(copy.sending_mode, 'scout_only');
  assert.equal((await missions.windows(copy.id)).length, 1);
  assert.equal((await missions.locations(copy.id)).length, 1);
});

test('leads: a business is only stored once per user (spec 29)', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });

  const first = await leads.createFromCandidate(userId, m.id, {
    name: 'ABC Restaurant', website: 'https://abcrestaurant.com', country: 'US',
    source: 'osm', sourceUrl: 'https://example.org/node/1',
  });
  assert.equal(first.created, true);

  const again = await leads.createFromCandidate(userId, m.id, {
    name: 'ABC Restaurant', website: 'https://www.abcrestaurant.com/menu', country: 'US',
  });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(await leads.count(userId), 1);
});

test('leads: dedupe applies across missions for the same user', async () => {
  const { leads, missions, userId } = await fixture();
  const a = await missions.create(userId, { name: 'A', windows, locations });
  const b = await missions.create(userId, { name: 'B', windows, locations });

  await leads.createFromCandidate(userId, a.id, { name: 'Shared Biz', website: 'https://shared.example', country: 'US' });
  const second = await leads.createFromCandidate(userId, b.id, { name: 'Shared Biz', website: 'https://shared.example', country: 'US' });
  assert.equal(second.created, false, 'the same business must not be re-contacted via another mission');
});

test('leads: contact details are recorded only when the source supplied them', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });

  const withContact = await leads.createFromCandidate(userId, m.id, {
    name: 'With Contact', website: 'https://withcontact.example', country: 'US',
    email: 'hello@withcontact.example', source: 'osm', sourceUrl: 'https://osm.example/1',
  });
  assert.equal(withContact.lead.contact_route, 'email');
  assert.equal(withContact.lead.email_public, 'hello@withcontact.example');
  assert.equal(withContact.lead.contact_evidence, 'https://osm.example/1');

  const noContact = await leads.createFromCandidate(userId, m.id, {
    name: 'No Contact', website: 'https://nocontact.example', country: 'US',
  });
  assert.equal(noContact.lead.contact_route, null, 'a contact route is never invented');
  assert.equal(noContact.lead.email_public, null);
});

test('leads: invalid candidates are rejected rather than stored', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });
  assert.deepEqual(await leads.createFromCandidate(userId, m.id, { name: '   ' }), { created: false, reason: 'missing_name' });
});

test('leads: analysis and qualification persist and round-trip (spec 12, 14)', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });
  const { lead } = await leads.createFromCandidate(userId, m.id, {
    name: 'Analysed', website: 'https://analysed.example', country: 'US',
  });

  await leads.saveWebsiteAnalysis(lead.id, {
    ok: true, url: 'https://analysed.example', score: 40,
    findings: [{ issue: 'No viewport meta tag', evidence: '<head> lacks meta viewport', severity: 'high' }],
    evidence: { viewportMeta: false },
  });
  const site = await leads.websiteAnalysis(lead.id);
  assert.equal(site.ok, 1);
  assert.equal(site.findings[0].issue, 'No viewport meta tag');
  assert.deepEqual(site.evidence, { viewportMeta: false });

  await leads.saveQualification(lead.id, {
    qualified: true, confidence: 0.8, reason: 'Site is outdated',
    observed: ['no viewport meta tag'], opportunity: 'Mobile redesign',
    relevantService: 'website_design', model: 'opencode/x',
  });
  const q = await leads.qualification(lead.id);
  assert.equal(q.qualified, 1);
  assert.deepEqual(q.observed, ['no viewport meta tag']);

  const bundle = await leads.evidenceFor(lead.id);
  assert.equal(bundle.lead.businessName, 'Analysed');
  assert.equal(bundle.website.findings[0].issue, 'No viewport meta tag');
  assert.equal(bundle.qualification.qualified, 1);
});

test('leads: status transitions are validated', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });
  const { lead } = await leads.createFromCandidate(userId, m.id, { name: 'Staged', country: 'US' });
  assert.equal((await leads.setStatus(lead.id, 'investigated')).status, 'investigated');
  await assert.rejects(async () => leads.setStatus(lead.id, 'teleported'), (e) => e.code === 'VALIDATION_FAILED');
});

test('leads: first_contacted_at records contact history once', async () => {
  const { leads, missions, userId } = await fixture();
  const m = await missions.create(userId, { name: 'M', windows, locations });
  const { lead } = await leads.createFromCandidate(userId, m.id, { name: 'Contacted', country: 'US' });
  assert.equal(await leads.hasBeenContacted(lead.id), false);
  await leads.markContacted(lead.id);
  const first = (await leads.get(lead.id)).first_contacted_at;
  assert.ok(first);
  await leads.markContacted(lead.id);
  assert.equal((await leads.get(lead.id)).first_contacted_at, first, 'contact time is not overwritten');
  assert.equal(await leads.hasBeenContacted(lead.id), true);
});

test('suppression: opt-out blocks every future send (spec 17, 29)', async () => {
  const { suppression, userId } = await fixture();
  assert.equal(await suppression.isSuppressed(userId, { email: 'optout@example.com' }), null);

  await suppression.addEmail(userId, 'OptOut@Example.com', 'asked to stop');
  assert.ok(await suppression.isSuppressed(userId, { email: 'optout@example.com' }), 'normalised address matches');
  assert.equal(await suppression.isSuppressed(userId, { email: 'someone@example.com' }), null);
});

test('suppression: domain scope blocks a whole site', async () => {
  const { suppression, userId } = await fixture();
  await suppression.addDomain(userId, 'blocked.example');
  assert.ok(await suppression.isSuppressed(userId, { domain: 'blocked.example' }));
  assert.ok(await suppression.isSuppressed(userId, { email: 'anyone@blocked.example' }), 'domain scope covers its mailboxes');
  assert.equal(await suppression.isSuppressed(userId, { email: 'a@allowed.example' }), null);
});

test('suppression: hard bounce and complaint suppress permanently', async () => {
  const { suppression, userId } = await fixture();
  await suppression.recordBounce(userId, 'bounced@example.com', { hard: true });
  assert.ok(await suppression.isSuppressed(userId, { email: 'bounced@example.com' }));

  await suppression.recordComplaint(userId, 'spam@example.com');
  assert.ok(await suppression.isSuppressed(userId, { email: 'spam@example.com' }));

  assert.equal(await suppression.recordBounce(userId, 'soft@example.com', { hard: false }), null);
  assert.equal(await suppression.isSuppressed(userId, { email: 'soft@example.com' }), null, 'a soft bounce does not suppress');
});

test('suppression: invalid values are not stored', async () => {
  const { suppression, userId } = await fixture();
  assert.equal(await suppression.add(userId, { scope: 'email', value: 'not-an-email' }), null);
  assert.equal(await suppression.add(userId, { scope: 'email', value: '' }), null);
  assert.equal((await suppression.list(userId)).length, 0);
});
