import test from 'node:test';
import assert from 'node:assert/strict';

import { createSystem } from '../../src/system.js';
import { createTestDb } from '../../src/db/index.js';
import {
  assessMessage, assertMessageQuality, qualityFeedback, RECOMMENDED_SERVICES,
} from '../../src/services/message-quality.js';

const ANALYSIS = {
  website: {
    evidence: { hasViewportMeta: false, title: 'ABC Restaurant' },
    findings: [{ issue: 'Missing viewport meta tag', evidence: 'no <meta name="viewport">' }],
    opportunities: ['mobile layout'],
  },
};

const GOOD = {
  subject: 'Your booking button on phones',
  body: 'Hi, I noticed ABC Restaurant has no mobile viewport tag, so the booking button can be hard to reach on phones. I put together a cleaner mobile layout as a free first pass.',
  referenced_observations: ['no viewport meta tag'],
};

const ctx = (extra = {}) => ({
  lead: { businessName: 'ABC Restaurant' },
  analysis: ANALYSIS,
  mission: {},
  followUpNumber: 0,
  ...extra,
});

test('message-quality: a grounded, specific message passes', () => {
  const report = assessMessage(GOOD, ctx());
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.checks.references_evidence, true);
  assert.equal(qualityFeedback(report), true);
});

test('message-quality: structural problems are reported deterministically', () => {
  assert.ok(assessMessage({ ...GOOD, subject: '' }, ctx()).issues.some((i) => i.code === 'MISSING_SUBJECT'));
  assert.ok(assessMessage({ ...GOOD, body: 'short note' }, ctx()).issues.some((i) => i.code === 'BODY_TOO_SHORT'));
  assert.ok(assessMessage({ ...GOOD, subject: 'x'.repeat(141) }, ctx()).issues.some((i) => i.code === 'SUBJECT_TOO_LONG'));
  assert.ok(assessMessage({ subject: 'x'.repeat(141), body: GOOD.body }, ctx()).issues.some((i) => i.code === 'SUBJECT_TOO_LONG'));
});

test('message-quality: placeholder, filler, emoji and separators are rejected', () => {
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body} Best, {{first_name}}` }, ctx())
    .issues.some((i) => i.code === 'PLACEHOLDER'));
  assert.ok(assessMessage({ ...GOOD, body: 'Hey, I hope this email finds you well. ABC Restaurant has no mobile viewport tag so the booking button hides on phones and I can help.' }, ctx())
    .issues.some((i) => i.code === 'BANNED_FILLER'));
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body} 🚀` }, ctx())
    .issues.some((i) => i.code === 'EMOJI'));
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body}\n----------\nRegards` }, ctx())
    .issues.some((i) => i.code === 'BANNED_SEPARATOR'));
});

test('message-quality: guarantees and false first-hand claims are rejected', () => {
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body} We guarantee 100% results.` }, ctx())
    .issues.some((i) => i.code === 'GUARANTEE_CLAIM'));
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body} When I visited your site, the booking button was hidden on mobile phones.` }, ctx())
    .issues.some((i) => i.code === 'FALSE_OBSERVATION'));
});

test('message-quality: a message with no recorded evidence is ungrounded', () => {
  const report = assessMessage(
    { subject: 'Quick note', body: 'Hi there, I would love to help your growing business with a brand new website and better marketing.' },
    ctx(),
  );
  assert.ok(report.issues.some((i) => i.code === 'NO_PERSONALIZATION'));
  assert.equal(report.checks.references_evidence, false);
});

test('message-quality: a claimed observation must exist in the evidence', () => {
  const report = assessMessage(
    { ...GOOD, referenced_observations: ['a checkout flow that crashes on Safari'] },
    ctx(),
  );
  assert.ok(report.issues.some((i) => i.code === 'UNSUPPORTED_CLAIM'), JSON.stringify(report.issues));
});

test('message-quality: follow-ups have a tighter length budget and need no re-grounding', () => {
  const longBody = `${Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ')}`;
  const report = assessMessage({ subject: 'Following up', body: longBody }, ctx({ followUpNumber: 1 }));
  assert.ok(report.issues.some((i) => i.code === 'BODY_TOO_LONG'));
});

test('message-quality: an identical body sent to another prospect is a template duplicate', () => {
  const report = assessMessage(GOOD, ctx({ priorBodies: [GOOD.body] }));
  assert.ok(report.issues.some((i) => i.code === 'DUPLICATE_TEMPLATE'));
});

test('message-quality: a repeated opening is flagged even when the rest differs', () => {
  const prior = 'Hi, I noticed ABC Restaurant has no mobile viewport tag, so booking on phones is awkward and worth a quick fix.';
  const candidate = 'Hi, I noticed ABC Restaurant has no mobile viewport tag, and a cleaner layout would help guests book on the go.';
  const report = assessMessage({ ...GOOD, body: candidate }, ctx({ priorBodies: [prior] }));
  assert.ok(report.issues.some((i) => i.code === 'REPETITIVE_OPENING'), JSON.stringify(report.issues));
});

test('message-quality: claiming to be a real human is rejected', () => {
  assert.ok(assessMessage({ ...GOOD, body: `${GOOD.body} I am a real person, not a bot.` }, ctx())
    .issues.some((i) => i.code === 'FALSE_OBSERVATION'));
});

test('message-quality: assertMessageQuality throws a permanent typed error', () => {
  assert.throws(
    () => assertMessageQuality({ subject: 'Hi', body_text: 'too short' }, ctx()),
    (e) => e.code === 'MESSAGE_QUALITY_REJECTED' && e.permanent === true && e.status === 422,
  );
});

test('message-quality: RECOMMENDED_SERVICES is the controlled §16 vocabulary', () => {
  assert.deepEqual(RECOMMENDED_SERVICES, [
    'full_redesign', 'homepage_improvement', 'mobile_improvement', 'other', 'not_applicable',
  ]);
});

// ── Service-level gate (real DB + LeadService) ───────────────────────────────

async function fixture() {
  const system = createSystem({ db: createTestDb() });
  await system.db.migrate();
  await system.db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
     VALUES('T','t','t','q?',0)`
  );
  const userId = (await system.db.get('SELECT id FROM users WHERE username_lower=?', 't')).id;
  await system.db.run(`INSERT INTO missions(user_id, name, service) VALUES(?, 'M', 'website_design')`, userId);
  const missionId = (await system.db.get('SELECT id FROM missions WHERE user_id=?', userId)).id;
  return { system, userId, missionId };
}

async function addLead(system, userId, missionId, name) {
  await system.db.run(
    `INSERT INTO leads(user_id, mission_id, business_name, discovery_source, dedupe_key)
     VALUES(?,?,?, 'overpass', ?)`,
    userId, missionId, name, name.toLowerCase(),
  );
  const leadId = (await system.db.get('SELECT id FROM leads WHERE user_id=? AND business_name=?', userId, name)).id;
  await system.leads.saveWebsiteAnalysis(leadId, {
    ok: true,
    evidence: { hasViewportMeta: false, title: name },
    findings: [{ issue: 'Missing viewport meta tag', evidence: 'no viewport tag' }],
    score: 40,
    method: 'http_fetch_heuristics',
  });
  return leadId;
}

test('message-quality service: rejects an ungrounded stored message at the send boundary', async () => {
  const { system, userId, missionId } = await fixture();
  const leadId = await addLead(system, userId, missionId, 'ABC Restaurant');
  await assert.rejects(
    () => system.messageQuality.assertSendable({
      lead_id: leadId, mission_id: missionId, kind: 'initial',
      subject: 'Hello', body_text: 'Hi there, I would love to help your business grow with a brand new website soon.',
    }),
    (e) => e.code === 'MESSAGE_QUALITY_REJECTED',
  );
});

test('message-quality service: accepts a grounded message and flags cross-prospect duplicates', async () => {
  const { system, userId, missionId } = await fixture();
  const first = await addLead(system, userId, missionId, 'ABC Restaurant');
  const second = await addLead(system, userId, missionId, 'XYZ Diner');

  const message = {
    lead_id: first, mission_id: missionId, kind: 'initial',
    subject: GOOD.subject, body_text: GOOD.body, referenced_observations: ['no viewport meta tag'],
  };
  const report = await system.messageQuality.assertSendable(message);
  assert.equal(report.ok, true, JSON.stringify(report.issues));

  // Persist the first message so the second prospect's identical body is a
  // cross-prospect template duplicate (spec §15).
  const conversation = await system.conversations.ensure(first, missionId, userId);
  await system.db.run(
    `INSERT INTO outreach_messages(conversation_id, lead_id, mission_id, kind, subject, body_text, send_status)
     VALUES(?,?,?,?,?,?, 'sent')`,
    conversation.id, first, missionId, 'initial', GOOD.subject, GOOD.body,
  );
  await assert.rejects(
    () => system.messageQuality.assertSendable({
      ...message, lead_id: second, referenced_observations: ['no viewport meta tag'],
    }),
    (e) => e.code === 'MESSAGE_QUALITY_REJECTED',
  );
});
