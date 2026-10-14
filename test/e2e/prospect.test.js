import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient, connectMailbox } from '../helpers/api.js';

// Stage 3: the per-prospect workspace actions (spec §21) — grounded Q&A,
// on-demand drafting, evidence refresh — plus operator job retry (§30).

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

async function signedIn(base, username) {
  const c = createClient(base);
  await c.signupAndLogin({ ...ACCOUNT, username });
  return c;
}

/** Runs the whole pipeline for the first user and returns the resulting lead. */
async function pipeline(system, base, { connect = true } = {}) {
  const c = await signedIn(base, 'ada');
  if (connect) await connectMailbox(system.db, 1);
  const { body } = await c.post('/api/missions', { ...MISSION, sendingMode: 'autopilot' });
  await c.post(`/api/missions/${body.mission.id}/activate`, {});
  await c.post(`/api/missions/${body.mission.id}/run-now`, {});
  await system.worker.drain();
  const lead = (await system.leads.list(1))[0];
  return { c, missionId: body.mission.id, lead };
}

test('prospect: asking a question returns a grounded answer and rejects junk', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);

    const res = await c.post(`/api/leads/${lead.id}/ask`, { question: 'Why should I contact them?' });
    assert.equal(res.status, 200);
    assert.ok(res.body.answer.length > 0);
    assert.ok(Array.isArray(res.body.observed));

    const tooShort = await c.post(`/api/leads/${lead.id}/ask`, { question: 'x' });
    assert.equal(tooShort.status, 422);
  });
});

test('prospect: another user cannot ask about or draft for this lead', async () => {
  await withServer(async ({ system, base }) => {
    const { lead } = await pipeline(system, base);
    const other = await signedIn(base, 'bob');

    assert.equal((await other.post(`/api/leads/${lead.id}/ask`, { question: 'Tell me about them.' })).status, 404);
    assert.equal((await other.post(`/api/leads/${lead.id}/draft`, {})).status, 404);
    assert.equal((await other.post(`/api/leads/${lead.id}/refresh`, {})).status, 404);
  });
});

test('prospect: drafting creates a reviewable draft message', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);

    const res = await c.post(`/api/leads/${lead.id}/draft`, {});
    assert.equal(res.status, 201);
    assert.equal(res.body.message.send_status, 'draft');
    assert.ok(res.body.message.subject.length > 0);

    // The draft shows up in the same prospect view the pipeline uses.
    const detail = await c.get(`/api/leads/${lead.id}`);
    assert.ok(detail.body.messages.some((m) => m.id === res.body.message.id));
  });
});

test('prospect: drafting is idempotent so a double-click never duplicates a draft', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);

    const first = await c.post(`/api/leads/${lead.id}/draft`, { requestId: 'req-1' });
    const replay = await c.post(`/api/leads/${lead.id}/draft`, { requestId: 'req-1' });
    assert.equal(first.status, 201);
    assert.equal(replay.body.message.id, first.body.message.id);
    assert.equal(replay.body.deduped, true);

    // Without a request id, an in-flight draft of the same kind is returned.
    const again = await c.post(`/api/leads/${lead.id}/draft`, {});
    assert.equal(replay.body.deduped, true);
    assert.equal(replay.body.message.id, first.body.message.id);

    const detail = await c.get(`/api/leads/${lead.id}`);
    assert.equal(detail.body.messages.filter((m) => m.send_status === 'draft').length, 1);
  });
});

test('prospect: refreshing evidence is idempotent while a pass is in flight', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);

    const first = await c.post(`/api/leads/${lead.id}/refresh`, {});
    const second = await c.post(`/api/leads/${lead.id}/refresh`, {});
    assert.equal(first.status, 202);
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.job.id, first.body.job.id, 'a second refresh must reuse the in-flight job');
  });
});

test('prospect: evidence is versioned per lead and owned by its user', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);

    const res = await c.get(`/api/leads/${lead.id}/evidence`);
    assert.equal(res.status, 200);
    assert.ok(res.body.audits.length >= 1, 'at least one audit version must exist');
    const latest = res.body.audits[0];
    assert.equal(latest.version, 1);
    assert.ok(latest.evidence.length >= 1, 'the audit must carry captured evidence');
    assert.ok(latest.evidence.every((e) => e.lead_id === lead.id));
    // Every evidence item is traceable to the audit version it came from.
    assert.ok(latest.evidence.every((e) => e.audit_id === latest.id && e.hash));

    const other = await signedIn(base, 'bob');
    assert.equal((await other.get(`/api/leads/${lead.id}/evidence`)).status, 404);
  });
});

test('prospect: a failed job surfaces an explained, retry-safe failure', async () => {
  await withServer(async ({ system, base }) => {
    const { c } = await pipeline(system, base);
    const job = await system.queue.enqueue({ userId: 1, missionId: null, stage: 'research', payload: {} });
    await system.queue.claim('w1');
    await system.queue.fail(job.job.id, new Error('no credits'), {
      kind: 'ai', retryable: false, code: 'AI_CREDITS_EXHAUSTED',
    });

    const activity = await c.get('/api/activity');
    const row = activity.body.jobs.find((j) => j.id === job.job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.failure.code, 'AI_CREDITS_EXHAUSTED');
    assert.equal(row.failure.retryable, false);
    assert.equal(row.failure.retrySafe, true);
    assert.match(row.failure.action, /credits|quota/i);
  });
});

test('prospect: drafting without a connected mailbox is refused', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base, { connect: false });
    const res = await c.post(`/api/leads/${lead.id}/draft`, {});
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'MAILBOX_NOT_CONNECTED');
  });
});

test('prospect: evidence refresh enqueues a new research job', async () => {
  await withServer(async ({ system, base }) => {
    const { c, lead } = await pipeline(system, base);
    const res = await c.post(`/api/leads/${lead.id}/refresh`, {});
    assert.equal(res.status, 202);
    assert.equal(res.body.job.stage, 'research');
  });
});

test('jobs: an operator can retry a failed job, but only their own', async () => {
  await withServer(async ({ system, base }) => {
    const c = await signedIn(base, 'ada');
    const { job } = await system.queue.enqueue({
      userId: 1, missionId: null, stage: 'research', payload: {},
    });
    await system.queue.claim('w1');
    await system.queue.fail(job.id, new Error('boom'), { kind: 'system', retryable: false });
    assert.equal((await system.queue.get(job.id)).status, 'failed');

    const other = await signedIn(base, 'bob');
    assert.equal((await other.post(`/api/jobs/${job.id}/retry`, {})).status, 404, 'cross-user retry is refused');

    const res = await c.post(`/api/jobs/${job.id}/retry`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.job.status, 'queued');
  });
});
