import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { ConversationService } from '../../src/services/conversations.js';
import { sqliteUtc } from '../../src/core/time.js';

const suppression = { isSuppressed: async () => null, addEmail: async () => {} };

function svc(db, limits = {}) {
  return new ConversationService({
    db,
    suppression,
    config: {
      limits: {
        globalMaxSendsPerDay: 50,
        globalMaxSendsPerHour: 0,
        globalMinSecondsBetweenSends: 0,
        recipientCooldownDays: 0,
        ...limits,
      },
    },
  });
}

async function seed(db, { mission = {}, leadEmail = 'owner@biz.com', leadMissionId = null } = {}) {
  const { lastInsertRowid: userId } = await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, automation_paused, created_ms)
     VALUES('Ada','ada','ada','q?',0,0)`
  );
  const { lastInsertRowid: missionId } = await db.run(
    `INSERT INTO missions(user_id, name, service, status, sending_mode, daily_send_limit,
                          hourly_send_limit, min_seconds_between_sends, campaign_start_at, campaign_end_at)
     VALUES(?, 'M', 'website_design', 'scheduled', 'autopilot', ?, ?, ?, ?, ?)`,
    userId, mission.daily_send_limit ?? 20, mission.hourly_send_limit ?? 0,
    mission.min_seconds_between_sends ?? 0, mission.campaign_start_at ?? null, mission.campaign_end_at ?? null
  );
  const { lastInsertRowid: leadId } = await db.run(
    `INSERT INTO leads(mission_id, user_id, business_name, dedupe_key, discovery_source, email_public)
     VALUES(?,?,?,?,?,?)`,
    leadMissionId ?? missionId, userId, 'Biz', `k-${Math.random()}`, 'test', leadEmail
  );
  return { userId, missionId, leadId };
}

async function recordSent(db, { userId, missionId, leadId, sentAt }) {
  const { lastInsertRowid: convId } = await db.run(
    'INSERT INTO conversations(lead_id, mission_id, user_id, status) VALUES(?,?,?,?)',
    leadId, missionId, userId, 'sent'
  );
  await db.run(
    `INSERT INTO outreach_messages(conversation_id, lead_id, mission_id, kind, subject, body_text,
                                    send_status, sent_at, idempotency_key)
     VALUES(?,?,?, 'initial', 's', 'b', 'sent', ?, ?)`,
    convId, leadId, missionId, sentAt, `k-${Math.random()}`
  );
}

test('limits: the daily cap blocks further sends for the day', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db, { mission: { daily_send_limit: 1 } });
  await db.run('INSERT INTO send_log(user_id, mission_id, sent_on, count) VALUES(?,?,?,1)',
    userId, missionId, new Date().toISOString().slice(0, 10));
  await assert.rejects(
    () => svc(db).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'owner@biz.com' }),
    (e) => e.code === 'DAILY_LIMIT_REACHED'
  );
});

test('limits: the hourly cap is transient so the job retries after the window', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db, { mission: { hourly_send_limit: 1 } });
  await recordSent(db, { userId, missionId, leadId, sentAt: sqliteUtc(new Date()) });
  await assert.rejects(
    () => svc(db).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'owner@biz.com' }),
    (e) => e.code === 'HOURLY_LIMIT_REACHED' && e.retryable === true
  );
});

test('limits: pacing enforces a minimum gap between sends', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db, { mission: { min_seconds_between_sends: 3600 } });
  await recordSent(db, { userId, missionId, leadId, sentAt: new Date().toISOString().replace('T', ' ').slice(0, 19) });
  await assert.rejects(
    () => svc(db).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'owner@biz.com' }),
    (e) => e.code === 'PACING_WAIT'
  );
});

test('limits: a campaign window gates sending at both ends', async () => {
  const db = await createTestDb(); await db.migrate();
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const { userId, missionId, leadId } = await seed(db, { mission: { campaign_start_at: future } });
  await assert.rejects(
    () => svc(db).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'x@biz.com' }),
    (e) => e.code === 'CAMPAIGN_NOT_STARTED' && e.retryable
  );

  const db2 = await createTestDb(); await db2.migrate();
  const past = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const s2 = await seed(db2, { mission: { campaign_end_at: past } });
  await assert.rejects(
    () => svc(db2).assertSendable(s2.userId, s2.missionId, { id: s2.leadId, business_name: 'Biz', email_public: 'x@biz.com' }),
    (e) => e.code === 'CAMPAIGN_ENDED' && !e.retryable
  );
});

test('limits: recipient cooldown stops re-contacting the same address', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db, { leadEmail: 'dup@biz.com' });
  // A prior send to the same address, from a different mission.
  const { lastInsertRowid: otherMission } = await db.run(
    `INSERT INTO missions(user_id, name, service, status, sending_mode) VALUES(?, 'Other', 'seo', 'scheduled', 'autopilot')`,
    userId
  );
  const { lastInsertRowid: otherLead } = await db.run(
    'INSERT INTO leads(mission_id, user_id, business_name, dedupe_key, discovery_source, email_public) VALUES(?,?,?,?,?,?)',
    otherMission, userId, 'Biz2', `k-${Math.random()}`, 'test', 'dup@biz.com'
  );
  await recordSent(db, { userId, missionId: otherMission, leadId: otherLead, sentAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });

  await assert.rejects(
    () => svc(db, { recipientCooldownDays: 30 }).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'dup@biz.com' }),
    (e) => e.code === 'RECIPIENT_COOLDOWN'
  );
});

test('limits: with no caps configured a clean send passes', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db);
  const email = await svc(db).assertSendable(userId, missionId, { id: leadId, business_name: 'Biz', email_public: 'owner@biz.com' });
  assert.equal(email, 'owner@biz.com');
});

test('limits: sentCount scopes to a mission or the whole user', async () => {
  const db = await createTestDb(); await db.migrate();
  const { userId, missionId, leadId } = await seed(db);
  await recordSent(db, { userId, missionId, leadId, sentAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  assert.equal(await svc(db).sentCount({ missionId }), 1);
  assert.equal(await svc(db).sentCount({ userId }), 1);
});
