import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';
import { sqliteUtc } from '../../src/core/time.js';

const drain = (w) => w.drain();

function stack(db, opts = {}) {
  const user = seedUser(db, opts.user);
  const mission = seedMission(db, user.id, opts.mission);
  connectMailbox(db, user.id);
  return { user, mission };
}

const start = (system, user, mission) => system.queue.enqueue({
  userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
  payload: { location: { country: 'US', city: 'Austin' } },
});

/** Run the pipeline to completion and return the lead. */
async function toEnd(system, user, mission) {
  start(system, user, mission);
  await drain(system.worker);
  return system.leads.list(user.id)[0];
}

function firstMessage(db, lead) {
  return db.get('SELECT * FROM outreach_messages WHERE lead_id = ?', lead.id);
}

const sendAgain = (system, user, mission, lead, message, tag) => system.queue.enqueue({
  userId: user.id, missionId: mission.id, stage: STAGE.EMAIL,
  payload: { leadId: lead.id, messageId: message.id },
  idempotencyKey: `email:${tag}:${message.id}`,
});

// ── Suppression and limits (spec §17, §29) ────────────────────────

test('policy: a suppressed recipient is never contacted', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db, { mission: { sending_mode: 'review_send' } });
  const lead = await toEnd(system, user, mission);
  const message = firstMessage(db, lead);

  // The prospect opted out after the draft was created.
  system.suppression.addEmail(user.id, 'hello@abcrestaurant.com', 'asked to stop');
  sendAgain(system, user, mission, lead, message, 'suppressed');
  await drain(system.worker);

  assert.equal(email.sent.length, 0, 'a suppressed address is never emailed');
  assert.equal(system.leads.get(lead.id).status, 'suppressed');
});

test('policy: a domain-level suppression blocks the whole site', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db, { mission: { sending_mode: 'review_send' } });
  const lead = await toEnd(system, user, mission);
  const message = firstMessage(db, lead);

  system.suppression.addDomain(user.id, 'abcrestaurant.com');
  sendAgain(system, user, mission, lead, message, 'dom');
  await drain(system.worker);
  assert.equal(email.sent.length, 0);
});

test('policy: the daily send limit stops further sends', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db, { mission: { sending_mode: 'autopilot', dailySendLimit: 1 } });
  const lead = await toEnd(system, user, mission);
  assert.equal(email.sent.length, 1, 'the first send goes through');

  const message = firstMessage(db, lead);
  system.conversations.markApproved(message.id);
  // Pretend the daily budget is already spent.
  db.run('UPDATE send_log SET count = 1 WHERE user_id = ?', user.id);

  sendAgain(system, user, mission, lead, message, 'limit');
  await drain(system.worker);
  assert.equal(email.sent.length, 1, 'the daily limit blocked a second send');
});

test('policy: an expired mailbox stops sending and notifies the user', async () => {
  const { system, email } = setup({
    emailState: { failNext: { code: 'MAILBOX_AUTH_EXPIRED', message: 'grant expired', retryable: false } },
  });
  const { user, mission } = stack(system.db);
  await toEnd(system, user, mission);

  assert.equal(email.sent.length, 0, 'nothing was sent');
  const note = system.notifications.list(user.id).find((n) => n.kind === 'mailbox_expired');
  assert.ok(note, 'the user is told to reconnect their mailbox');
  assert.equal(note.severity, 'critical');
});
// ── Reply monitoring (spec §18) ───────────────────────────────────

test('policy: a reply notifies the user and cancels pending follow-ups', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db);
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);
  assert.equal(db.all("SELECT * FROM follow_ups WHERE status = 'pending'").length, 1);

  email.state.replies = [{
    providerMessageId: 'inbound-1',
    threadKey: 'thread-hello@abcrestaurant.com',
    from: 'ABC Restaurant <hello@abcrestaurant.com>',
    subject: 'Re: Your website at ABC Restaurant',
    text: 'Hi, yes please send some details about the redesign.',
    receivedAt: new Date().toISOString(),
  }];

  system.queue.enqueue({ userId: user.id, missionId: null, stage: STAGE.MAILBOX_MONITOR, payload: {} });
  await drain(system.worker);

  const updated = system.conversations.getById(conversation.id);
  assert.equal(updated.status, 'reply_received');
  assert.equal(updated.reply_count, 1);
  assert.equal(system.leads.get(lead.id).status, 'replied');

  assert.equal(db.all("SELECT * FROM follow_ups WHERE status = 'pending'").length, 0,
    'follow-ups are cancelled the moment a reply arrives');
  assert.equal(db.all("SELECT * FROM follow_ups WHERE status = 'cancelled'")[0].reason_cancelled, 'prospect replied');

  const note = system.notifications.list(user.id).find((n) => n.kind === 'reply');
  assert.ok(note, 'the user is notified immediately');
  assert.equal(note.severity, 'critical');
});

test('policy: a reply from a stranger is ignored', async () => {
  const { system, email } = setup();
  const { user, mission } = stack(system.db);
  await toEnd(system, user, mission);

  email.state.replies = [{
    providerMessageId: 'spam-1', from: 'noreply@somewhere-else.example',
    subject: 'hello', text: 'not a prospect', receivedAt: new Date().toISOString(),
  }];
  system.queue.enqueue({ userId: user.id, missionId: null, stage: STAGE.MAILBOX_MONITOR, payload: {} });
  await drain(system.worker);

  assert.equal(system.notifications.list(user.id).filter((n) => n.kind === 'reply').length, 0);
});

test('policy: an opt-out reply suppresses the address permanently', async () => {
  const { system, email } = setup({
    aiOverrides: { reply_triage: (d) => ({ ...d, intent: 'unsubscribes', is_opt_out: true }) },
  });
  const { user, mission } = stack(system.db);
  await toEnd(system, user, mission);

  email.state.replies = [{
    providerMessageId: 'inbound-2', from: 'hello@abcrestaurant.com',
    subject: 'stop', text: 'Please stop emailing me.', receivedAt: new Date().toISOString(),
  }];
  system.queue.enqueue({ userId: user.id, missionId: null, stage: STAGE.MAILBOX_MONITOR, payload: {} });
  await drain(system.worker);

  assert.ok(system.suppression.isSuppressed(user.id, { email: 'hello@abcrestaurant.com' }),
    'the opt-out is recorded as suppression');
});
// ── Follow-ups (spec §19) ─────────────────────────────────────────

test('policy: a follow-up is not sent before the configured delay', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db, { mission: { followUpDelayDays: 2 } });
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);

  system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.FOLLOW_UP,
    payload: { conversationId: conversation.id },
  });
  await drain(system.worker);

  assert.equal(email.sent.length, 1, 'still only the original message');
  assert.equal(
    db.get('SELECT * FROM follow_ups WHERE conversation_id = ?', conversation.id).status, 'pending'
  );
});

test('policy: a due follow-up is sent and reschedules only up to the maximum', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db, { mission: { followUpDelayDays: 2, maxFollowUps: 2 } });
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);

  let n = 0;
  const runFollowUp = async () => {
    n++;
    db.run(
      "UPDATE follow_ups SET due_at = ? WHERE conversation_id = ? AND status = 'pending'",
      sqliteUtc(new Date(Date.now() - 1000)), conversation.id
    );
    system.queue.enqueue({
      userId: user.id, missionId: mission.id, stage: STAGE.FOLLOW_UP,
      payload: { conversationId: conversation.id },
      idempotencyKey: `fu:${conversation.id}:${n}`,
    });
    await drain(system.worker);
  };

  await runFollowUp();
  assert.equal(email.sent.length, 2, 'the first follow-up was sent');
  const afterFirst = system.conversations.getById(conversation.id);
  assert.equal(afterFirst.followups_sent, 1);
  // A next follow-up is queued, so the conversation shows it is scheduled.
  assert.equal(afterFirst.status, 'follow_up_scheduled');
  assert.equal(
    db.all("SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending'", conversation.id).length, 1,
    'exactly one follow-up is pending at a time'
  );

  await runFollowUp();
  assert.equal(email.sent.length, 3, 'the second follow-up was sent');

  await runFollowUp();
  assert.equal(email.sent.length, 3, 'max_follow_ups is respected — no third follow-up');
  assert.equal(
    db.all("SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending'", conversation.id).length,
    0, 'nothing further is scheduled at the limit'
  );
});

test('policy: a reply prevents the scheduled follow-up from sending', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db);
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);

  system.conversations.recordReply(conversation.id, { providerMessageId: 'r1' });
  db.run("UPDATE follow_ups SET due_at = ? WHERE conversation_id = ?", sqliteUtc(new Date(Date.now() - 1000)), conversation.id);
  system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.FOLLOW_UP,
    payload: { conversationId: conversation.id },
  });
  await drain(system.worker);

  assert.equal(email.sent.length, 1, 'no follow-up after a reply');
  assert.equal(
    db.get('SELECT * FROM follow_ups WHERE conversation_id = ?', conversation.id).status, 'cancelled'
  );
});

test('policy: a paused mission prevents the follow-up from sending', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db);
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);

  db.run("UPDATE missions SET status = 'paused' WHERE id = ?", mission.id);
  db.run("UPDATE follow_ups SET due_at = ? WHERE conversation_id = ?", sqliteUtc(new Date(Date.now() - 1000)), conversation.id);
  const { job } = system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.FOLLOW_UP,
    payload: { conversationId: conversation.id },
  });
  await drain(system.worker);

  assert.equal(email.sent.length, 1, 'nothing extra was sent');
  // The worker refuses to run the stage at all for a paused mission.
  assert.equal(system.queue.get(job.id).status, 'cancelled');
  assert.match(system.queue.get(job.id).last_error, /mission_paused/);
});

test('policy: a suppressed recipient blocks the follow-up', async () => {
  const { db, system, email } = setup();
  const { user, mission } = stack(db);
  const lead = await toEnd(system, user, mission);
  const conversation = system.conversations.getFor(lead.id, mission.id);

  system.suppression.recordBounce(user.id, 'hello@abcrestaurant.com', { hard: true });
  db.run("UPDATE follow_ups SET due_at = ? WHERE conversation_id = ?", sqliteUtc(new Date(Date.now() - 1000)), conversation.id);
  system.queue.enqueue({
    userId: user.id, missionId: mission.id, stage: STAGE.FOLLOW_UP,
    payload: { conversationId: conversation.id },
  });
  await drain(system.worker);

  assert.equal(email.sent.length, 1, 'a bounced address is never contacted again');
});