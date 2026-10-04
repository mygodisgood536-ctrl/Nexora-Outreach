import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { MissionService } from '../../src/services/missions.js';
import { LeadService } from '../../src/services/leads.js';
import { SuppressionService } from '../../src/services/suppression.js';
import { EmailConnectionStore } from '../../src/services/email-store.js';

function fixture() {
  const db = createTestDb();
  db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
     VALUES('T','t','t','q?',0)`
  );
  const userId = db.get('SELECT id FROM users WHERE username_lower=?', 't').id;
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

test('missions: create stores configuration and defaults (spec 8)', () => {
  const { missions, userId } = fixture();
  const m = missions.create(userId, {
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
  assert.equal(missions.windows(m.id).length, 1);
  assert.equal(missions.locations(m.id)[0].country, 'US');
});

test('missions: activation requires a schedule and a country', () => {
  const { missions, userId } = fixture();
  const bare = missions.create(userId, { name: 'Bare' });
  assert.throws(() => missions.activate(bare.id, userId), (e) => /scouting window/.test(e.message));

  const partial = missions.create(userId, { name: 'Partial', windows });
  assert.throws(() => missions.activate(partial.id, userId), (e) => /target country/.test(e.message));

  const ready = missions.create(userId, { name: 'Ready', windows, locations });
  const activated = missions.activate(ready.id, userId);
  assert.equal(activated.status, 'scheduled');
  assert.ok(activated.next_run_at, 'activation computes the next scouting window');
});

test('missions: country must be a real ISO code, never a vague region (spec 9)', () => {
  const { missions, userId } = fixture();
  const m = missions.create(userId, { name: 'Geo' });
  assert.throws(
    () => missions.setLocations(m.id, [{ country: 'Middle East' }]),
    (e) => /ISO country code/.test(e.message)
  );
  assert.throws(
    () => missions.setLocations(m.id, [{ country: 'Arab' }]),
    (e) => /ISO country code/.test(e.message)
  );
  const ok = missions.setLocations(m.id, [
    { country: 'us', priority: 'high' },
    { country: 'de', priority: 'medium' },
    { country: 'AE', priority: 'low' },
  ]);
  assert.deepEqual(ok.map((l) => l.country), ['US', 'DE', 'AE'], 'ordered by priority rank, not alphabetically');
  assert.equal(ok.find((l) => l.country === 'US').priority, 'high', 'priority is preserved');
});

test('missions: windows accept multiple ranges and reject nonsense (spec 10)', () => {
  const { missions, userId } = fixture();
  const m = missions.create(userId, { name: 'Sched' });
  const w = missions.setWindows(m.id, [
    { dayOfWeek: 1, startMin: '10:00', endMin: '13:00' },
    { dayOfWeek: 1, startMin: '17:00', endMin: '20:00' },
    { dayOfWeek: 2, startMin: 0, endMin: 240 },
  ]);
  assert.equal(w.length, 3);
  assert.equal(w[0].start_min, 600);
  assert.equal(w[2].end_min, 240);
  assert.throws(() => missions.setWindows(m.id, [{ dayOfWeek: 9, startMin: '10:00', endMin: '11:00' }]));
  assert.throws(() => missions.setWindows(m.id, [{ dayOfWeek: 1, startMin: 'nope', endMin: '11:00' }]));
  assert.throws(() => missions.setWindows(m.id, [{ dayOfWeek: 1, startMin: '10:00', endMin: '10:00' }]));
});

test('missions: pause, resume and stop change real state (spec 26)', () => {
  const { missions, userId } = fixture();
  const m = missions.create(userId, { name: 'Ctrl', windows, locations });
  missions.activate(m.id, userId);
  assert.equal(missions.pause(m.id, userId).status, 'paused');
  assert.equal(missions.resume(m.id, userId).status, 'scheduled');
  assert.equal(missions.stop(m.id, userId).status, 'stopped');
  assert.equal(missions.archive(m.id, userId).status, 'archived');
});

test('missions: ownership is enforced on every access', () => {
  const { missions, db, userId } = fixture();
  const m = missions.create(userId, { name: 'Mine', windows, locations });
  db.run(`INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
          VALUES('O','other','other','q?',0)`);
  const other = db.get('SELECT id FROM users WHERE username_lower=?', 'other').id;
  assert.throws(() => missions.getForUser(m.id, other), (e) => e.code === 'NOT_FOUND');
});

test('missions: duplicate copies config but resets to the safest sending mode', () => {
  const { missions, userId } = fixture();
  const m = missions.create(userId, { name: 'Orig', sending_mode: 'autopilot', windows, locations });
  missions.activate(m.id, userId);
  const copy = missions.duplicate(m.id, userId);
  assert.equal(copy.name, 'Orig (copy)');
  assert.equal(copy.sending_mode, 'scout_only');
  assert.equal(missions.windows(copy.id).length, 1);
  assert.equal(missions.locations(copy.id).length, 1);
});

test('leads: a business is only stored once per user (spec 29)', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });

  const first = leads.createFromCandidate(userId, m.id, {
    name: 'ABC Restaurant', website: 'https://abcrestaurant.com', country: 'US',
    source: 'osm', sourceUrl: 'https://example.org/node/1',
  });
  assert.equal(first.created, true);

  const again = leads.createFromCandidate(userId, m.id, {
    name: 'ABC Restaurant', website: 'https://www.abcrestaurant.com/menu', country: 'US',
  });
  assert.equal(again.created, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(leads.count(userId), 1);
});

test('leads: dedupe applies across missions for the same user', () => {
  const { leads, missions, userId } = fixture();
  const a = missions.create(userId, { name: 'A', windows, locations });
  const b = missions.create(userId, { name: 'B', windows, locations });

  leads.createFromCandidate(userId, a.id, { name: 'Shared Biz', website: 'https://shared.example', country: 'US' });
  const second = leads.createFromCandidate(userId, b.id, { name: 'Shared Biz', website: 'https://shared.example', country: 'US' });
  assert.equal(second.created, false, 'the same business must not be re-contacted via another mission');
});

test('leads: contact details are recorded only when the source supplied them', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });

  const withContact = leads.createFromCandidate(userId, m.id, {
    name: 'With Contact', website: 'https://withcontact.example', country: 'US',
    email: 'hello@withcontact.example', source: 'osm', sourceUrl: 'https://osm.example/1',
  });
  assert.equal(withContact.lead.contact_route, 'email');
  assert.equal(withContact.lead.email_public, 'hello@withcontact.example');
  assert.equal(withContact.lead.contact_evidence, 'https://osm.example/1');

  const noContact = leads.createFromCandidate(userId, m.id, {
    name: 'No Contact', website: 'https://nocontact.example', country: 'US',
  });
  assert.equal(noContact.lead.contact_route, null, 'a contact route is never invented');
  assert.equal(noContact.lead.email_public, null);
});

test('leads: invalid candidates are rejected rather than stored', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });
  assert.deepEqual(leads.createFromCandidate(userId, m.id, { name: '   ' }), { created: false, reason: 'missing_name' });
});

test('leads: analysis and qualification persist and round-trip (spec 12, 14)', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });
  const { lead } = leads.createFromCandidate(userId, m.id, {
    name: 'Analysed', website: 'https://analysed.example', country: 'US',
  });

  leads.saveWebsiteAnalysis(lead.id, {
    ok: true, url: 'https://analysed.example', score: 40,
    findings: [{ issue: 'No viewport meta tag', evidence: '<head> lacks meta viewport', severity: 'high' }],
    evidence: { viewportMeta: false },
  });
  const site = leads.websiteAnalysis(lead.id);
  assert.equal(site.ok, 1);
  assert.equal(site.findings[0].issue, 'No viewport meta tag');
  assert.deepEqual(site.evidence, { viewportMeta: false });

  leads.saveQualification(lead.id, {
    qualified: true, confidence: 0.8, reason: 'Site is outdated',
    observed: ['no viewport meta tag'], opportunity: 'Mobile redesign',
    relevantService: 'website_design', model: 'opencode/x',
  });
  const q = leads.qualification(lead.id);
  assert.equal(q.qualified, 1);
  assert.deepEqual(q.observed, ['no viewport meta tag']);

  const bundle = leads.evidenceFor(lead.id);
  assert.equal(bundle.lead.businessName, 'Analysed');
  assert.equal(bundle.website.findings[0].issue, 'No viewport meta tag');
  assert.equal(bundle.qualification.qualified, 1);
});

test('leads: status transitions are validated', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });
  const { lead } = leads.createFromCandidate(userId, m.id, { name: 'Staged', country: 'US' });
  assert.equal(leads.setStatus(lead.id, 'investigated').status, 'investigated');
  assert.throws(() => leads.setStatus(lead.id, 'teleported'), (e) => e.code === 'VALIDATION_FAILED');
});

test('leads: first_contacted_at records contact history once', () => {
  const { leads, missions, userId } = fixture();
  const m = missions.create(userId, { name: 'M', windows, locations });
  const { lead } = leads.createFromCandidate(userId, m.id, { name: 'Contacted', country: 'US' });
  assert.equal(leads.hasBeenContacted(lead.id), false);
  leads.markContacted(lead.id);
  const first = leads.get(lead.id).first_contacted_at;
  assert.ok(first);
  leads.markContacted(lead.id);
  assert.equal(leads.get(lead.id).first_contacted_at, first, 'contact time is not overwritten');
  assert.equal(leads.hasBeenContacted(lead.id), true);
});

test('suppression: opt-out blocks every future send (spec 17, 29)', () => {
  const { suppression, userId } = fixture();
  assert.equal(suppression.isSuppressed(userId, { email: 'optout@example.com' }), null);

  suppression.addEmail(userId, 'OptOut@Example.com', 'asked to stop');
  assert.ok(suppression.isSuppressed(userId, { email: 'optout@example.com' }), 'normalised address matches');
  assert.equal(suppression.isSuppressed(userId, { email: 'someone@example.com' }), null);
});

test('suppression: domain scope blocks a whole site', () => {
  const { suppression, userId } = fixture();
  suppression.addDomain(userId, 'blocked.example');
  assert.ok(suppression.isSuppressed(userId, { domain: 'blocked.example' }));
  assert.ok(suppression.isSuppressed(userId, { email: 'anyone@blocked.example' }), 'domain scope covers its mailboxes');
  assert.equal(suppression.isSuppressed(userId, { email: 'a@allowed.example' }), null);
});

test('suppression: hard bounce and complaint suppress permanently', () => {
  const { suppression, userId } = fixture();
  suppression.recordBounce(userId, 'bounced@example.com', { hard: true });
  assert.ok(suppression.isSuppressed(userId, { email: 'bounced@example.com' }));

  suppression.recordComplaint(userId, 'spam@example.com');
  assert.ok(suppression.isSuppressed(userId, { email: 'spam@example.com' }));

  assert.equal(suppression.recordBounce(userId, 'soft@example.com', { hard: false }), null);
  assert.equal(suppression.isSuppressed(userId, { email: 'soft@example.com' }), null, 'a soft bounce does not suppress');
});

test('suppression: invalid values are not stored', () => {
  const { suppression, userId } = fixture();
  assert.equal(suppression.add(userId, { scope: 'email', value: 'not-an-email' }), null);
  assert.equal(suppression.add(userId, { scope: 'email', value: '' }), null);
  assert.equal(suppression.list(userId).length, 0);
});