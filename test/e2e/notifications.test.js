import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';

/**
 * Spec §25 — the signals the operator must receive, exercised through the real
 * pipeline rather than by inserting notification rows directly.
 */

async function seedStack(db, opts = {}) {
  const user = await seedUser(db, opts.user);
  const mission = await seedMission(db, user.id, opts.mission);
  await connectMailbox(db, user.id);
  return { user, mission };
}

async function runDiscovery(system, mission, location = { country: 'US', city: 'Austin' }) {
  await system.queue.enqueue({
    userId: mission.user_id, missionId: mission.id, stage: STAGE.DISCOVERY,
    payload: { location },
  });
  return system.worker.drain();
}

const ofKind = (rows, kind) => rows.filter((n) => n.kind === kind);

test('notifications: a qualified lead in a High-priority target raises the high-priority signal (spec 25)', async () => {
  const { db, system } = await setup();
  const { user, mission } = await seedStack(db, {
    mission: { locations: [{ country: 'US', city: 'Austin', priority: 'high' }] },
  });

  await runDiscovery(system, mission);

  const rows = await system.notifications.list(user.id);
  const high = ofKind(rows, 'high_priority_lead');
  assert.equal(high.length, 1, 'exactly one high-priority signal for the lead');
  assert.match(high[0].title, /ABC Restaurant/);
  assert.equal(high[0].lead_id, (await system.leads.list(user.id))[0].id);
  assert.equal(high[0].read_at, null);
});

test('notifications: a qualified lead outside every High target does not raise the signal (spec 25)', async () => {
  const { db, system } = await setup();
  const { user, mission } = await seedStack(db, {
    // The candidate lands in Austin (US); the only High target is Berlin (DE).
    mission: { locations: [{ country: 'DE', city: 'Berlin', priority: 'high' }] },
  });
  await runDiscovery(system, mission);

  const rows = await system.notifications.list(user.id);
  assert.equal(ofKind(rows, 'high_priority_lead').length, 0);
});

test('notifications: a provider refusal raises the sending-paused signal (spec 25)', async () => {
  const { db, system, email } = await setup();
  const { user, mission } = await seedStack(db);

  email.state.failNext = { code: 'PROVIDER_FORBIDDEN', message: 'Google refused the request: insufficient permission' };
  const jobs = await runDiscovery(system, mission);

  const emailJob = jobs.find((j) => j.stage === STAGE.EMAIL);
  assert.equal(emailJob.status, 'failed');
  assert.equal(emailJob.error_code, 'PROVIDER_FORBIDDEN');
  assert.equal(email.sent.length, 0, 'nothing was sent');

  const paused = ofKind(await system.notifications.list(user.id), 'sending_paused');
  assert.equal(paused.length, 1, 'the operator is told sending stopped');
  assert.equal(paused[0].severity, 'warning');
  assert.match(paused[0].body, /insufficient permission/);
  assert.equal(paused[0].mission_id, mission.id);
});

test('notifications: an expired mailbox raises the mailbox-expired signal (spec 25)', async () => {
  const { db, system, email } = await setup();
  const { user, mission } = await seedStack(db);

  email.state.failNext = { code: 'MAILBOX_AUTH_EXPIRED', message: 'the refresh token was revoked' };
  await runDiscovery(system, mission);

  const expired = ofKind(await system.notifications.list(user.id), 'mailbox_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].severity, 'critical');
});

test('notifications: a scheduled follow-up raises the follow-up-due signal (spec 25)', async () => {
  const { db, system, email } = await setup();
  const { user, mission } = await seedStack(db);

  await runDiscovery(system, mission);
  assert.equal(email.sent.length, 1);

  const due = ofKind(await system.notifications.list(user.id), 'follow_up_due');
  assert.equal(due.length, 1, 'the pending follow-up is announced');
  assert.match(due[0].title, /ABC Restaurant/);
});

test('notifications: repeated signals for the same lead are deduplicated while unread (spec 25)', async () => {
  const { db, system } = await setup();
  const { user, mission } = await seedStack(db);
  await runDiscovery(system, mission);

  // Re-qualifying the same lead must not stack identical unread signals.
  const leads = await system.leads.list(user.id);
  await system.notifications.create(user.id, {
    kind: 'high_priority_lead', severity: 'info', title: 'x', leadId: leads[0].id,
  });
  const high = ofKind(await system.notifications.list(user.id), 'high_priority_lead');
  assert.equal(high.length, 1, 'a second unread signal for the same lead is absorbed');
});

test('notifications: marking signals read updates the unread count (spec 25)', async () => {
  const { db, system } = await setup();
  const { user, mission } = await seedStack(db);
  await runDiscovery(system, mission);

  const rows = await system.notifications.list(user.id);
  const before = await system.notifications.unreadCount(user.id);
  assert.ok(before > 0, 'signals start unread');

  await system.notifications.markRead(user.id, rows[0].id);
  assert.equal(await system.notifications.unreadCount(user.id), before - 1);

  await system.notifications.markAllRead(user.id);
  assert.equal(await system.notifications.unreadCount(user.id), 0);
});
