import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';

const drain = (worker) => worker.drain();

function seedFullStack(db, opts = {}) {
  const user = seedUser(db, opts.user);
  const mission = seedMission(db, user.id, opts.mission);
  connectMailbox(db, user.id);
  return { user, mission };
}

const runDiscovery = (system, user, mission) => system.queue.enqueue({
  userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
  payload: { location: { country: 'US', city: 'Austin' } },
});

// ── Happy path ─────────────────────────────────────────────────────

test('pipeline: a mission runs discovery -> research -> analysis -> qualification -> outreach -> send', async () => {
  const { db, system, email, ai } = setup();
  const { user, mission } = seedFullStack(db);

  runDiscovery(system, user, mission);
  const jobs = await drain(system.worker);

  const failures = jobs.filter((j) => j.status !== 'succeeded');
  assert.equal(failures.length, 0, JSON.stringify(failures.map((j) => [j.stage, j.last_error])));

  const leads = system.leads.list(user.id);
  assert.equal(leads.length, 1);
  const lead = leads[0];
  assert.equal(lead.business_name, 'ABC Restaurant');
  assert.equal(lead.status, 'sent');
  assert.ok(lead.first_contacted_at, 'contact time is recorded');

  // Website evidence really came from the fetched HTML.
  const site = system.leads.websiteAnalysis(lead.id);
  assert.equal(site.ok, 1);
  assert.equal(site.evidence.hasViewportMeta, false, 'the HTML really lacks a viewport meta tag');
  assert.deepEqual(site.evidence.mailtoAddresses, ['hello@abcrestaurant.com']);

  const q = system.leads.qualification(lead.id);
  assert.equal(q.qualified, 1);
  assert.ok(q.reason.includes('viewport'), 'the reason cites recorded evidence');

  assert.equal(email.sent.length, 1, 'exactly one message was sent');
  assert.equal(email.sent[0].to, 'hello@abcrestaurant.com');

  assert.ok(ai.calls.includes('analyze_site'), 'site analysis really called the AI');
  assert.ok(ai.calls.includes('qualify'));
  assert.ok(ai.calls.includes('write_outreach'));

  const order = jobs.map((j) => j.stage).filter((s, i, a) => s !== a[i - 1]);
  assert.deepEqual(order, [
    STAGE.DISCOVERY, STAGE.RESEARCH, STAGE.SITE_ANALYSIS,
    STAGE.QUALIFICATION, STAGE.OUTREACH, STAGE.EMAIL,
  ]);

  assert.equal(db.all("SELECT * FROM follow_ups WHERE status = 'pending'").length, 1,
    'a follow-up is pending after the configured delay');
});

test('pipeline: replaying the run does not duplicate leads or sends', async () => {
  const { system, email } = setup();
  const { user, mission } = seedFullStack(system.db);

  system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
    payload: { location: { country: 'US', city: 'Austin' } },
  });
  await drain(system.worker);
  assert.equal(email.sent.length, 1);

  // Re-enqueueing the same discovery work twice must be absorbed.
  const first = system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
    payload: { location: { country: 'US', city: 'Austin' } },
    idempotencyKey: 'sched:1:fixed',
  });
  assert.equal(first.created, true);
  await drain(system.worker);

  const second = system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
    payload: { location: { country: 'US', city: 'Austin' } },
    idempotencyKey: 'sched:1:fixed',
  });
  assert.equal(second.created, false, 'the idempotency key prevents a duplicate run');
  await drain(system.worker);

  assert.equal(system.leads.list(user.id).length, 1, 'duplicate lead prevented');
  assert.equal(email.sent.length, 1, 'duplicate send prevented');
});
test('pipeline: an unqualified lead is closed and never contacted', async () => {
  const { db, system, email } = setup({
    aiOverrides: { qualify: (d) => ({ ...d, qualified: false, reason: 'no opportunity found' }) },
  });
  const { user, mission } = seedFullStack(db);
  runDiscovery(system, user, mission);
  await drain(system.worker);

  const lead = system.leads.list(user.id)[0];
  assert.equal(lead.status, 'closed');
  assert.equal(email.sent.length, 0, 'nothing is sent to an unqualified lead');
  assert.equal(db.all('SELECT * FROM outreach_messages').length, 0);
});

test('pipeline: a business with no website is still investigated (spec 13)', async () => {
  const { db, system } = setup({
    discoveryCandidates: [{
      name: 'No Site Cafe', country: 'US', city: 'Austin',
      phone: '+1 512 555 0199', source: 'test_source', sourceUrl: 'https://example.org/b',
    }],
  });
  const { user, mission } = seedFullStack(db);
  runDiscovery(system, user, mission);
  await drain(system.worker);

  const lead = system.leads.list(user.id)[0];
  assert.equal(lead.business_name, 'No Site Cafe');
  assert.notEqual(lead.status, 'discovered', 'the lead still advanced');

  const presence = system.leads.presenceAnalysis(lead.id);
  assert.ok(presence, 'presence evidence was recorded');
  assert.equal(presence.evidence.hasWebsite, false);
  assert.equal(presence.evidence.publicPhone, '+15125550199');
  assert.equal(email_of(db, lead), null, 'no email is invented for this business');
});

function email_of(db, lead) {
  return db.get('SELECT email_public FROM leads WHERE id = ?', lead.id).email_public;
}

test('pipeline: Scout Only never sends but still drafts (spec 27)', async () => {
  const { db, system, email } = setup();
  const { user, mission } = seedFullStack(db, { mission: { sending_mode: 'scout_only' } });
  runDiscovery(system, user, mission);
  await drain(system.worker);

  assert.equal(email.sent.length, 0, 'Scout Only must not send');
  assert.equal(system.leads.list(user.id)[0].status, 'message_generated');
  assert.equal(db.all('SELECT * FROM outreach_messages').length, 1, 'a draft still exists');
});

test('pipeline: Review & Send waits for approval (spec 27)', async () => {
  const { db, system, email } = setup();
  const { user, mission } = seedFullStack(db, { mission: { sending_mode: 'review_send' } });
  runDiscovery(system, user, mission);
  await drain(system.worker);
  assert.equal(email.sent.length, 0, 'unapproved messages must not send');

  const message = db.get("SELECT * FROM outreach_messages WHERE send_status != 'sent'");
  assert.ok(message);
  system.conversations.markApproved(message.id);
  system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.EMAIL,
    payload: { leadId: message.lead_id, messageId: message.id },
    idempotencyKey: `email:approved:${message.id}`,
  });
  await drain(system.worker);
  assert.equal(email.sent.length, 1, 'sends once approved');
});