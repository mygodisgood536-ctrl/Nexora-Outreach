import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient } from '../helpers/api.js';
import { STAGE } from '../../src/workers/queue.js';

/**
 * Spec §32 / §40 — the whole product in one honest run.
 *
 * Everything below happens the way it happens for a real user: the HTTP API,
 * the real scheduler deciding when to scout, the real queue, the real worker
 * and the real services. The mission is never started by hand — the scheduler
 * picks it up because its scouting window opened (§10, §38). Only the outbound
 * boundaries (AI, email transport, HTTP/discovery) are faked.
 */

// Monday 9 February 2026, 11:00 UTC — inside the mission's scouting window.
const IN_WINDOW = new Date(Date.UTC(2026, 1, 9, 11, 0));
const DAY_AFTER = new Date(Date.UTC(2026, 1, 10, 11, 0));

const OBJECTIVE = 'Austin restaurants whose websites are weak on phones, offer a free first pass.';

test('§32 journey: sign-up to autonomous outreach, reply monitoring and recovery', async () => {
  const ctx = await startTestServer();
  const { db, system, email, base } = ctx;
  try {
    const c = createClient(base);

    // ── §5.1 the username is checked before the form is submitted ──────
    const free = await c.get('/api/auth/username-available?username=ada');
    assert.equal(free.body.available, true);

    const { created, me } = await c.signupAndLogin({
      fullName: 'Ada Lovelace',
      username: 'ada',
      securityQuestion: 'First language?',
      securityAnswer: 'Analytical',
    });
    assert.equal(created.status, 201);
    assert.ok(me.body.user.id, 'the session belongs to a real account');

    const taken = await c.get('/api/auth/username-available?username=ada');
    assert.equal(taken.body.available, false);

    // ── §6 the mailbox is connected through the real authorization pair ──
    email.configure('google');
    const authorize = await c.post('/api/email/google/connect', {});
    assert.equal(authorize.status, 200);
    const state = new URL(authorize.body.authorizeUrl).searchParams.get('state');
    const connected = await c.get(`/api/email/google/callback?code=abc&state=${state}`);
    assert.equal(connected.status, 200);
    assert.equal(connected.body.connection.status, 'connected');
    const connections = await c.get('/api/email/connections');
    assert.equal(
      connections.body.providers.find((p) => p.id === 'google').connection.status, 'connected',
    );

    // ── §8 a plain-language objective becomes a reviewable draft ────────
    const interpreted = await c.post('/api/missions/interpret', { objective: OBJECTIVE });
    assert.equal(interpreted.status, 200);
    assert.ok(interpreted.body.interpretation, 'the structured interpretation is shown for review');
    assert.equal(interpreted.body.interpretation.service, 'website_design');
    assert.deepEqual(interpreted.body.interpretation.countries, ['US']);

    // ── §8 the mission is created, then activated (§10) ─────────────────
    const createdMission = await c.post('/api/missions', {
      name: 'Austin restaurants — mobile redesign',
      service: 'website_design',
      sendingMode: 'autopilot',
      timezone: 'UTC',
      targetDescription: 'restaurants with weak mobile websites',
      offerSummary: 'free-first mobile redesign',
      windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
      locations: [{ country: 'US', city: 'Austin', priority: 'high' }],
    });
    assert.equal(createdMission.status, 201);
    const missionId = createdMission.body.mission.id;

    const activated = await c.post(`/api/missions/${missionId}/activate`, {});
    assert.equal(activated.body.mission.status, 'scheduled');
    assert.ok(activated.body.mission.nextRunAt, 'activation schedules the next window');

    // ── §10 the scheduler starts the work; nobody presses "run" ──────────
    const scheduled = await system.scheduler.tick(IN_WINDOW);
    assert.equal(scheduled.length, 1, 'the open window produced real work');
    const job = await db.get("SELECT * FROM automation_jobs WHERE stage = 'discovery'");
    assert.equal(job.mission_id, missionId);

    // ── the pipeline runs discovery → … → send through the real worker ───
    await system.worker.drain();

    const leads = await system.leads.list(me.body.user.id, { limit: 10 });
    assert.equal(leads.length, 1, 'the mission discovered a real lead');
    const lead = leads[0];
    assert.equal(lead.status, 'sent', 'the qualified lead was contacted');

    assert.equal(email.sent.length, 1, 'exactly one message was sent');
    const sent = email.sent[0];
    assert.equal(sent.to, 'hi+1@us.example');

    // §12/§21 the evidence behind the decision is recorded and visible.
    const evidence = await system.evidence.latestForLead(lead.id);
    assert.ok(evidence, 'the investigation left an audit version');

    const detail = await c.get(`/api/leads/${lead.id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.qualification, 'the lead detail explains why it qualified');
    assert.ok(detail.body.websiteAnalysis, 'the lead detail shows the website investigation');
    assert.ok(detail.body.latestAudit, 'the lead detail shows the evidence audit');
    assert.ok(detail.body.messages.length >= 1, 'the message that was sent is on the prospect view');
    assert.ok(detail.body.followUps.length >= 1, 'the follow-up schedule is on the prospect view');

    // ── §20 the dashboard reflects the autonomous run ────────────────────
    const dashboard = await c.get('/api/dashboard');
    assert.equal(dashboard.body.missions.active, 1);
    assert.equal(dashboard.body.leads.discovered, 1);
    assert.equal(dashboard.body.leads.sent, 1);
    assert.equal(dashboard.body.messages.sent, 1);
    assert.equal(dashboard.body.scoutingState, 'running', 'the dashboard says automation is live');
    assert.ok(dashboard.body.nextScouting, 'the next scouting session is shown');

    // ── §19 the sent message scheduled a follow-up ──────────────────────
    const pending = await db.all("SELECT * FROM follow_ups WHERE status = 'pending'");
    assert.equal(pending.length, 1, 'a follow-up is pending');

    // ── §18/§25 a reply is detected, recorded and announced ─────────────
    email.state.replies = [{
      providerMessageId: 'inbound-1',
      threadKey: 'thread-hi+1@us.example',
      from: 'Test Biz Austin, US #1 <hi+1@us.example>',
      subject: `Re: ${sent.subject}`,
      text: 'Yes please — send me the details of the redesign.',
      receivedAt: IN_WINDOW.toISOString(),
    }];
    const polled = await system.scheduler.scheduleMailboxMonitors(DAY_AFTER);
    assert.equal(polled.enqueued, 1, 'the mailbox is polled on its own schedule');
    await system.worker.drain();

    const conversation = await system.conversations.getFor(lead.id, missionId);
    const updated = await system.conversations.getById(conversation.id);
    assert.equal(updated.status, 'reply_received');
    assert.equal(updated.reply_count, 1);
    assert.equal((await system.leads.get(lead.id)).status, 'replied');

    const notes = await system.notifications.list(me.body.user.id);
    assert.ok(
      notes.some((n) => n.kind === 'reply_received' || n.kind === 'reply'),
      `the reply is announced (kinds: ${notes.map((n) => n.kind).join(', ')})`,
    );

    // §18 the user must be able to read what the prospect wrote, not merely
    // that a reply exists: the text is kept with the thread and shown in it.
    const thread = await system.conversations.threadFor(conversation.id);
    const inbound = thread.filter((m) => m.direction === 'inbound');
    assert.equal(inbound.length, 1, 'the reply is part of the thread');
    assert.equal(inbound[0].body_text, 'Yes please — send me the details of the redesign.');
    assert.ok(inbound[0].intent, 'the AI reading of the reply is attached to it');

    const inbox = await c.get('/api/conversations');
    const listed = inbox.body.conversations.find((x) => x.id === conversation.id);
    assert.equal(listed.business_name, lead.business_name, 'the inbox names the business');
    assert.equal(listed.inbound_body, inbound[0].body_text, 'the inbox previews the reply itself');
    const opened = await c.get(`/api/conversations/${conversation.id}`);
    assert.ok(
      opened.body.messages.some((m) => m.direction === 'inbound' && m.body_text.includes('send me the details')),
      'the conversation view returns the reply text',
    );

    // The prospect view shows the same thread, so the reply is readable where
    // the operator is actually looking at the business.
    const prospect = await c.get(`/api/leads/${lead.id}`);
    assert.ok(
      prospect.body.messages.some((m) => m.direction === 'inbound' && m.body_text.includes('send me the details')),
      'the prospect view shows the reply text as well',
    );

    // §19/§38 no further follow-up after a reply.
    const afterReply = await db.all("SELECT * FROM follow_ups WHERE status = 'pending'");
    assert.equal(afterReply.length, 0, 'the pending follow-up was cancelled by the reply');

    // ── §26 the user can stop everything, and start it again ────────────
    await c.post('/api/automation/pause', {});
    const whilePaused = await system.scheduler.tick(DAY_AFTER);
    assert.equal(whilePaused.length, 0, 'Pause All Automation suppresses scouting');
    const followUpsWhilePaused = await system.scheduler.scheduleFollowUps(DAY_AFTER);
    assert.equal(followUpsWhilePaused.enqueued, 0, 'and follow-ups');

    await c.post('/api/automation/resume', {});
    const afterResume = await system.scheduler.tick(DAY_AFTER);
    assert.equal(afterResume.length, 0, 'Tuesday has no window, so nothing fires');
    const tuesday = await c.post(`/api/missions/${missionId}/run-now`, {});
    assert.equal(tuesday.body.enqueued, 1, 'the user can still ask for a run');
    await system.worker.drain();

    // ── §30/§23 work interrupted by a crash is recovered after a restart ──
    const { job: interrupted } = await system.queue.enqueue({
      userId: me.body.user.id, missionId, stage: STAGE.RESEARCH, payload: { leadId: lead.id },
    });
    await system.queue.claim('dead-worker', { leaseMs: -1000 });
    assert.equal((await system.queue.get(interrupted.id)).status, 'running');

    // A brand new runtime over the SAME database, exactly as after a restart.
    const { createSystem } = await import('../../src/system.js');
    const restarted = createSystem({
      db, overrides: { ai: system.services.ai, services: system.services },
    });
    assert.equal(await restarted.queue.recoverStale(), 1, 'the restart reclaimed the interrupted job');
    await restarted.worker.drain();
    assert.equal((await restarted.queue.get(interrupted.id)).status, 'succeeded');

    // ── §36 the whole thing is legible to the user afterwards ────────────
    const activity = await c.get(`/api/missions/${missionId}/activity`);
    assert.equal(activity.status, 200);
    assert.ok(activity.body.jobs.length > 0, 'the activity view lists the run');

    const notifications = await c.get('/api/notifications');
    assert.equal(notifications.status, 200);
    assert.ok(notifications.body.notifications.length > 0);
  } finally {
    await ctx.close();
  }
});