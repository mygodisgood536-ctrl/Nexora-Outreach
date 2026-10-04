import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient, connectMailbox } from '../helpers/api.js';

// Stage 2: coverage for the routes added to close the audited API gaps.
// Every gap gets at least one behavioural test and one cross-user test.

const ACCOUNT = {
  fullName: 'Ada Lovelace',
  securityQuestion: 'First programming language?',
  securityAnswer: 'Analytical Engine',
  timezone: 'UTC',
};

const MISSION = {
  name: 'Restaurant Website Redesign',
  service: 'website_design',
  targetDescription: 'restaurants with weak websites',
  offerSummary: 'free-first website redesign',
  windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
  locations: [{ country: 'US', city: 'Austin', priority: 'high' }],
};

async function withServer(fn, options = {}) {
  const ctx = await startTestServer(options);
  try { return await fn(ctx); } finally { await ctx.close(); }
}

async function signUp(base, username) {
  const c = createClient(base);
  await c.signupAndLogin({ ...ACCOUNT, username });
  return c;
}

/**
 * Drive the real pipeline to completion for a fresh account and return the
 * client plus the lead it produced.
 */
async function runPipeline(system, base, { sendingMode = 'autopilot' } = {}) {
  const c = await signUp(base, 'ada');
  connectMailbox(system.db, 1);
  const { body } = await c.post('/api/missions', { ...MISSION, sendingMode });
  const missionId = body.mission.id;
  await c.post(`/api/missions/${missionId}/activate`, {});
  await c.post(`/api/missions/${missionId}/run-now`, {});
  await system.worker.drain();
  const lead = system.leads.list(1)[0];
  return { c, missionId, lead };
}
// ── GAP-1: reject a drafted message (spec 21 user actions, 27) ─────────

test('api: rejecting a draft marks it rejected and records the reason', async () => {
  await withServer(async ({ system, base }) => {
    const { c, missionId } = await runPipeline(system, base, { sendingMode: 'review_send' });
    const message = firstMessage(system, missionId);
    assert.equal(message.send_status, 'draft', 'review_send holds the message for approval');

    const res = await c.post(`/api/messages/${message.id}/reject`, { reason: 'wrong tone for this prospect' });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.send_status, 'rejected');
    assert.match(res.body.message.error, /wrong tone/);
    assert.equal(system.conversations.message(message.id).send_status, 'rejected', 'persisted');
  });
});

test('api: an already-sent message cannot be rejected', async () => {
  await withServer(async ({ system, base }) => {
    const { c, missionId } = await runPipeline(system, base);
    const message = firstMessage(system, missionId);
    assert.equal(message.send_status, 'sent');

    const res = await c.post(`/api/messages/${message.id}/reject`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'MESSAGE_ALREADY_SENT');
    assert.equal(system.conversations.message(message.id).send_status, 'sent', 'history is not rewritten');
  });
});

test('api: one user cannot reject another user\'s message', async () => {
  await withServer(async ({ system, base }) => {
    const { missionId } = await runPipeline(system, base, { sendingMode: 'review_send' });
    const message = firstMessage(system, missionId);

    const grace = await signUp(base, 'grace');
    assert.equal((await grace.post(`/api/messages/${message.id}/reject`, {})).status, 404);
    assert.equal(system.conversations.message(message.id).send_status, 'draft', 'unchanged');
  });
});

test('api: rejecting a message requires a session and a CSRF token', async () => {
  await withServer(async ({ system, base }) => {
// ── GAP-2: lead detail carries the whole prospect view (spec 21) ────────

test('api: lead detail includes message history, follow-ups and suppression status', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await runPipeline(system, base);
    const res = await c.get(`/api/leads/${lead.id}`);
    assert.equal(res.status, 200);

    assert.ok(res.body.conversation, 'the conversation is present');
    assert.equal(res.body.messages.length, 1, 'conversation history is included');
    assert.equal(res.body.messages[0].send_status, 'sent');
    assert.ok(Array.isArray(res.body.followUps), 'follow-up status is included');
    assert.equal(res.body.suppression.suppressed, false, 'not suppressed yet');

    // The values come from the services, not from a hard-coded shape.
    const conversation = system.conversations.getFor(lead.id, lead.mission_id);
    assert.deepEqual(
      res.body.messages.map((m) => m.id),
      system.conversations.messagesFor(conversation.id).map((m) => m.id)
    );

    // Suppressing the recipient is reflected on the same screen.
    system.suppression.addEmail(1, lead.email_public, 'asked to stop', 'manual');
    const after = await c.get(`/api/leads/${lead.id}`);
    assert.equal(after.body.suppression.suppressed, true);
    assert.equal(after.body.suppression.scope, 'email');
  });
});

test('api: one user cannot read another user\'s lead detail', async () => {
  await withServer(async ({ system, base }) => {
    const { lead } = await runPipeline(system, base);
    const grace = await signUp(base, 'grace');
    const res = await grace.get(`/api/leads/${lead.id}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.lead, undefined, 'no lead data leaks');
  });
});

// ── GAP-3: the dashboard reports every element of spec 20 ───────────────

test('api: the dashboard reports websites analyzed, messages, state and attention', async () => {
  await withServer(async ({ system, base }) => {
    const { c } = await runPipeline(system, base);
    const res = await c.get('/api/dashboard');
    assert.equal(res.status, 200);
    const d = res.body;

    assert.equal(d.missions.total, 1);
    assert.equal(d.leads.discovered, 1);
    assert.ok(d.websitesAnalyzed >= 1, 'websites analyzed is reported');
    assert.equal(d.messages.generated, 1, 'messages generated');
    assert.equal(d.messages.sent, 1, 'messages sent');
    assert.equal(d.scoutingState, 'running', 'automation is live with a connected mailbox');
    assert.ok(Array.isArray(d.itemsRequiringAttention));
    assert.equal(d.nextScouting.length, 1, 'next scouting session');
  });
});

test('api: dashboard scouting state and attention reflect a missing mailbox', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signUp(base, 'nomail');
    const res = await c.get('/api/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.scoutingState, 'needs_mailbox');
    assert.ok(res.body.itemsRequiringAttention.some((i) => i.kind === 'mailbox_not_connected'));

    // Pausing is surfaced too.
    await c.post('/api/auth/automation-paused', { paused: true });
    const paused = await c.get('/api/dashboard');
    assert.equal(paused.body.scoutingState, 'paused');
    assert.ok(paused.body.itemsRequiringAttention.some((i) => i.kind === 'automation_paused'));
  });
});

test('api: dashboard counts are isolated per user', async () => {
  await withServer(async ({ system, base }) => {
    const { c } = await runPipeline(system, base);
    const mine = (await c.get('/api/dashboard')).body;
    assert.ok(mine.websitesAnalyzed >= 1 && mine.messages.sent === 1);

    const grace = await signUp(base, 'grace');
    const theirs = (await grace.get('/api/dashboard')).body;
    assert.equal(theirs.missions.total, 0);
    assert.equal(theirs.leads.discovered, 0);
    assert.equal(theirs.websitesAnalyzed, 0);
    assert.equal(theirs.messages.generated, 0);
    assert.equal(theirs.messages.sent, 0);
  });
});

// ── GAP-4: re-issue a recovery code while signed in (spec 5.3) ─────────

test('api: a new recovery code can be issued and the old one stops working', async () => {
  await withServer(async ({ system, base }) => {
    const created = createClient(base);
    const signup = await created.post('/api/auth/signup', { ...ACCOUNT, username: 'ada' });
    const original = signup.body.recoveryCode;
    assert.ok(original);

    const me = await created.get('/api/auth/me');
    created.setCsrf(me.body.csrfToken);
    const rotated = await created.post('/api/auth/recovery-code', {});
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.recoveryCode, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    assert.notEqual(rotated.body.recoveryCode, original);

    // The superseded code is dead; the new one works.
    const old = createClient(base);
    assert.equal((await old.post('/api/auth/recover', {
      username: 'ada', recoveryCode: original, newSecurityAnswer: 'First Attempt',
    })).status, 401);

    const fresh = createClient(base);
    const ok = await fresh.post('/api/auth/recover', {
      username: 'ada', recoveryCode: rotated.body.recoveryCode, newSecurityAnswer: 'Second Attempt',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.username, 'ada');
    assert.equal(system.db.get('SELECT recovery_code_hash FROM users WHERE id = 1').recovery_code_hash.length, 64);
  });
});

test('api: issuing a recovery code requires a session and a CSRF token', async () => {
  await withServer(async ({ base }) => {
    const anon = createClient(base);
    assert.equal((await anon.post('/api/auth/recovery-code', {})).status, 401);

    const c = await signUp(base, 'nocsrf');
    c.clearCsrf();
    assert.equal((await c.post('/api/auth/recovery-code', {})).status, 403);
  });
});
    const { missionId } = await runPipeline(system, base, { sendingMode: 'review_send' });
    const message = firstMessage(system, missionId);

    const anon = createClient(base);
    assert.equal((await anon.post(`/api/messages/${message.id}/reject`, {})).status, 401);

    const c = await signUp(base, 'nocsrf');
    c.clearCsrf();
    assert.equal((await c.post(`/api/messages/${message.id}/reject`, {})).status, 403);
    assert.equal(system.conversations.message(message.id).send_status, 'draft', 'unchanged');
  });
});

/** The single message produced by a completed pipeline run. */
function firstMessage(system, missionId) {
  const conversation = system.conversations.getFor(system.leads.list(1)[0].id, missionId);
  return system.conversations.messagesFor(conversation.id)[0];
}