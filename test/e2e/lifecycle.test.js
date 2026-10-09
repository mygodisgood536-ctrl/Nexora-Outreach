import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';
import { nowSqlite } from '../../src/core/time.js';
import { err } from '../../src/core/errors.js';

const drain = (w) => w.drain();

async function stack(db, opts = {}) {
  const user = await seedUser(db, opts.user);
  const mission = await seedMission(db, user.id, opts.mission);
  await connectMailbox(db, user.id);
  return { user, mission };
}

const start = (system, user, mission) => system.queue.enqueue({
  userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
  payload: { location: { country: 'US', city: 'Austin' } },
});

// â”€â”€ Failure handling (spec Â§30) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('lifecycle: a transient failure retries and then succeeds', async () => {
  let attempts = 0;
  const { db, system } = await setup({
    aiOverrides: {
      qualify: (d) => {
        attempts++;
        // A real AppError, exactly as ai/tasks.js would raise it.
        if (attempts === 1) throw err.ai('AI_TIMEOUT', 'The AI provider timed out.');
        return d;
      },
    },
  });
  const { user, mission } = await stack(db);
  await start(system, user, mission);
  await drain(system.worker);

  const qual = await db.all("SELECT * FROM automation_jobs WHERE stage = 'qualification'");
  assert.equal(qual[0].status, 'waiting_retry', 'transient failure is rescheduled');
  assert.ok(qual[0].run_after > nowSqlite(), 'retry is deferred by backoff');

  await db.run("UPDATE automation_jobs SET run_after = ? WHERE stage = 'qualification'", nowSqlite());
  await drain(system.worker);

  const after = await db.get("SELECT * FROM automation_jobs WHERE stage = 'qualification'");
  assert.equal(after.status, 'succeeded', 'the retry completed the stage');
  assert.equal((await system.leads.list(user.id))[0].status, 'sent');
});

test('lifecycle: a permanent failure stops immediately and notifies the user', async () => {
  const { db, system } = await setup({
    aiOverrides: {
      qualify: () => { throw err.ai('AI_INVALID_OUTPUT', 'The model response was not valid JSON.'); },
    },
  });
  const { user, mission } = await stack(db);
  await start(system, user, mission);
  await drain(system.worker);

  const qual = await db.get("SELECT * FROM automation_jobs WHERE stage = 'qualification'");
  assert.equal(qual.status, 'failed');
  assert.equal(qual.attempts, 1, 'a permanent error is not retried');

  const notes = await system.notifications.list(user.id);
  assert.ok(notes.some((n) => n.kind === 'ai_error'), 'the user is told the AI step failed');
});

test('lifecycle: an expired lease is recovered and the job re-runs', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);

  const { job } = await start(system, user, mission);
  await system.queue.claim('dead-worker', { leaseMs: -1000 });   // worker "dies"
  assert.equal((await system.queue.get(job.id)).status, 'running');

  const recovered = await system.queue.recoverStale();
  assert.equal(recovered, 1);
  await drain(system.worker);
  assert.equal((await system.queue.get(job.id)).status, 'succeeded');
});

test('lifecycle: work survives a process restart', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);
  const { job } = await start(system, user, mission);

  await system.queue.claim('crashed-worker', { leaseMs: -1000 });
  await db.run("UPDATE automation_jobs SET run_after = ? WHERE id = ?", nowSqlite(), job.id);

  // A brand new runtime over the SAME database, as after a restart.
  const { createSystem } = await import('../../src/system.js');
  const restarted = createSystem({
    db, overrides: { ai: system.services.ai, services: system.services },
  });

  const recovered = await restarted.queue.recoverStale();
  assert.equal(recovered, 1, 'the restarted process reclaimed the interrupted job');
  await drain(restarted.worker);
  assert.equal((await restarted.leads.list(user.id)).length, 1);
});

test('lifecycle: a handler that is not registered fails permanently', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);
  await system.queue.enqueue({ userId: user.id, missionId: mission.id, stage: 'not_a_stage' });
  const [job] = await drain(system.worker);
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /No handler registered/);
});

// â”€â”€ Pause, resume, stop (spec Â§26) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('lifecycle: a paused mission does not execute queued work', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);
  const { job } = await start(system, user, mission);
  await db.run("UPDATE missions SET status = 'paused' WHERE id = ?", mission.id);

  await drain(system.worker);
  assert.equal((await system.queue.get(job.id)).status, 'cancelled');
  assert.equal((await system.leads.list(user.id)).length, 0, 'a paused mission does no work');
});

test('lifecycle: Pause All Automation stops every mission', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);
  const { job } = await start(system, user, mission);
  await db.run('UPDATE users SET automation_paused = 1 WHERE id = ?', user.id);

  await drain(system.worker);
  assert.equal((await system.queue.get(job.id)).status, 'cancelled');
  assert.equal((await system.leads.list(user.id)).length, 0);
});

test('lifecycle: a stopped mission cancels queued work and does not resume', async () => {
  const { db, system } = await setup();
  const { user, mission } = await stack(db);
  const { job } = await start(system, user, mission);
  await db.run("UPDATE missions SET status = 'stopped' WHERE id = ?", mission.id);

  await drain(system.worker);
  assert.equal((await system.queue.get(job.id)).status, 'cancelled');

  await system.missions.resume(mission.id, user.id);
  assert.equal((await db.get('SELECT status FROM missions WHERE id = ?', mission.id)).status, 'scheduled');
});
