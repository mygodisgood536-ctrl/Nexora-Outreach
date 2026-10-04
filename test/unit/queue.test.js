import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { JobQueue, STAGE, backoffMs } from '../../src/workers/queue.js';
import { sqliteUtc, nowSqlite } from '../../src/core/time.js';

function fixture() {
  const db = createTestDb();
  db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
     VALUES('T','t','t','q?',0)`
  );
  const userId = db.get('SELECT id FROM users WHERE username_lower=?', 't').id;
  db.run(`INSERT INTO missions(user_id, name, service) VALUES(?, 'M', 'website_design')`, userId);
  const missionId = db.get('SELECT id FROM missions WHERE user_id=?', userId).id;
  return { db, userId, missionId, queue: new JobQueue(db) };
}

test('queue: enqueue then claim exactly once', () => {
  const { queue, userId, missionId } = fixture();
  const { job, created } = queue.enqueue({
    userId, missionId, stage: STAGE.DISCOVERY, payload: { country: 'US' },
  });
  assert.equal(created, true);
  assert.equal(job.status, 'queued');

  const claimed = queue.claim('worker-1');
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal(queue.claim('worker-2'), null, 'a claimed job must not be double-claimed');
});

test('queue: idempotency key prevents duplicate work (spec 23)', () => {
  const { queue, userId, missionId } = fixture();
  const key = 'discovery:US:restaurant:2026-02-10';
  const a = queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY, idempotencyKey: key });
  const b = queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY, idempotencyKey: key });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.job.id, b.job.id);
});

test('queue: transient failure retries with backoff, bounded (spec 30)', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.RESEARCH, maxAttempts: 3 });

  // A retry is scheduled in the future, so fast-forward run_after between
  // attempts to simulate the backoff elapsing.
  const dueNow = () => queue.db.run(
    `UPDATE automation_jobs SET run_after = ? WHERE id = ?`, nowSqlite(), job.id
  );

  queue.claim('w1');
  let r = queue.fail(job.id, new Error('connection reset'), { kind: 'browser', retryable: true });
  assert.equal(r.retried, true);
  assert.equal(queue.get(job.id).status, 'waiting_retry');
  assert.equal(queue.claim('w1'), null, 'backoff defers the next attempt');

  dueNow();
  queue.claim('w1');
  r = queue.fail(job.id, new Error('again'), { kind: 'browser', retryable: true });
  assert.equal(r.retried, true);

  dueNow();
  queue.claim('w1');
  r = queue.fail(job.id, new Error('third'), { kind: 'browser', retryable: true });
  assert.equal(r.retried, false, 'attempt budget exhausted');
  assert.equal(queue.get(job.id).status, 'failed');
  assert.equal(queue.get(job.id).attempts, 3);
});

test('queue: permanent failure is not retried', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.EMAIL, maxAttempts: 5 });
  queue.claim('w1');
  const r = queue.fail(job.id, new Error('recipients suppressed'), { kind: 'email', retryable: false });
  assert.equal(r.retried, false);
  assert.equal(queue.get(job.id).status, 'failed');
  assert.equal(queue.get(job.id).error_kind, 'email');
});

test('queue: run_after defers execution until due', () => {
  const { queue, userId, missionId } = fixture();
  queue.enqueue({
    userId, missionId, stage: STAGE.OUTREACH,
    runAfter: sqliteUtc(new Date(Date.now() + 3600_000)),
  });
  assert.equal(queue.claim('w1'), null, 'not due yet');
});
test('queue: expired lease is recovered after a crash (spec 30)', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.QUALIFICATION, maxAttempts: 3 });

  // Worker claims, then "dies" with an already-expired lease.
  queue.claim('dead-worker', { leaseMs: -1000 });
  assert.equal(queue.get(job.id).status, 'running');

  assert.equal(queue.recoverStale(), 1);
  const after = queue.get(job.id);
  assert.equal(after.status, 'waiting_retry');
  assert.match(after.last_error, /Recovered after worker interruption/);
  assert.equal(queue.claim('live-worker').id, job.id);
});

test('queue: a live lease is never stolen by recovery', () => {
  const { queue, userId, missionId } = fixture();
  queue.enqueue({ userId, missionId, stage: STAGE.QUALIFICATION });
  queue.claim('live-worker', { leaseMs: 600_000 });
  assert.equal(queue.recoverStale(), 0);
  assert.equal(queue.claim('thief'), null);
});

test('queue: recovery abandons jobs that exhausted their budget', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.RESEARCH, maxAttempts: 1 });
  queue.claim('dead', { leaseMs: -1000 });
  queue.recoverStale();
  const after = queue.get(job.id);
  assert.equal(after.status, 'failed');
  assert.match(after.last_error, /Abandoned/);
});

test('queue: safe stop cancels queued work but not running work', () => {
  const { queue, userId, missionId } = fixture();
  const running = queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY, idempotencyKey: 'k1' });
  const queued = queue.enqueue({ userId, missionId, stage: STAGE.EMAIL, idempotencyKey: 'k2' });
  queue.claim('w1');

  assert.equal(queue.cancelQueued({ missionId }), 1);
  assert.equal(queue.get(running.job.id).status, 'running', 'in-flight work stays recoverable');
  assert.equal(queue.get(queued.job.id).status, 'cancelled');
});

test('queue: complete stores result and clears the lease', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY });
  queue.claim('w1');
  queue.complete(job.id, { discovered: 7 });
  const done = queue.get(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.lease_until, null);
  assert.equal(JSON.parse(done.result).discovered, 7);
});

test('queue: history records the lifecycle for the Activity view (spec 36)', () => {
  const { queue, userId, missionId } = fixture();
  const { job } = queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY });
  queue.claim('w1');
  queue.complete(job.id, {});
  assert.deepEqual(queue.history(job.id).map((h) => h.event), ['created', 'claimed', 'succeeded']);
});

test('queue: stats reflect real counts', () => {
  const { queue, userId, missionId } = fixture();
  queue.enqueue({ userId, missionId, stage: STAGE.DISCOVERY, idempotencyKey: 'a' });
  queue.enqueue({ userId, missionId, stage: STAGE.EMAIL, idempotencyKey: 'b' });
  queue.complete(queue.claim('w1').id, {});
  const s = queue.stats({ userId });
  assert.equal(s.succeeded, 1);
  assert.equal(s.queued, 1);
  assert.equal(s.failed, 0);
});

test('queue: backoff grows and is capped', () => {
  const small = backoffMs(1, 1000, 60000);
  const larger = backoffMs(5, 1000, 60000);
  assert.ok(larger >= small);
  assert.ok(backoffMs(30, 1000, 60000) <= 60000);
});