import { nowSqlite, sqliteUtc } from '../core/time.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('queue');

export const STAGE = {
  DISCOVERY: 'discovery',
  RESEARCH: 'research',
  SITE_ANALYSIS: 'site_analysis',
  QUALIFICATION: 'qualification',
  OUTREACH: 'outreach',
  EMAIL: 'email',
  MAILBOX_MONITOR: 'mailbox_monitor',
  FOLLOW_UP: 'follow_up',
};

export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_RETRY: 'waiting_retry',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** Exponential backoff with a ceiling (spec §30 bounded retry). */
export function backoffMs(attempts, base = 15000, capMs = 30 * 60 * 1000) {
  const raw = base * 2 ** Math.max(0, attempts - 1);
  const jitter = Math.floor(Math.random() * Math.min(raw * 0.2, 5000));
  return Math.min(capMs, raw + jitter);
}

/**
 * Durable job queue (spec §23, §30): claim/lease, bounded retry, crash
 * recovery, safe cancel, idempotency.
 *
 * Every method is `async` — the queue sits on the asynchronous database layer
 * (PostgreSQL in production, SQLite for the zero-install test suite).
 */
export class JobQueue {
  constructor(db) {
    this.db = db;
  }

  async _history(jobId, event, detail = null) {
    try {
      await this.db.run('INSERT INTO job_history(job_id, event, detail) VALUES(?,?,?)', jobId, event, detail);
    } catch (e) {
      // History is diagnostic; never let it break the job lifecycle.
      log.warn('job history write failed', { jobId, event, message: e?.message });
    }
  }

  /**
   * Enqueue a job. `idempotencyKey` makes replays safe: the same key returns
   * the existing job instead of creating a duplicate (spec §23).
   *
   * The insert uses `ON CONFLICT DO NOTHING` so two concurrent enqueues with
   * the same key cannot both win — the loser reads the winner's row.
   */
  async enqueue({
    userId, missionId = null, stage, payload = {},
    maxAttempts = 3, runAfter = null, idempotencyKey = null,
  }) {
    const r = await this.db.run(
      `INSERT INTO automation_jobs
         (user_id, mission_id, stage, payload, status, max_attempts, run_after, idempotency_key)
       VALUES(?,?,?,?,'queued',?,?,?)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      userId, missionId, stage, JSON.stringify(payload ?? {}), maxAttempts,
      runAfter || nowSqlite(), idempotencyKey,
    );

    if (r.changes === 0 && idempotencyKey) {
      const existing = await this.db.get(
        'SELECT * FROM automation_jobs WHERE idempotency_key = ?',
        idempotencyKey,
      );
      if (existing) return { job: existing, created: false };
      // Conflict target matched nothing and no row appeared: fall through to
      // a plain read by id so the caller always gets a job back.
    }

    const job = await this.db.get('SELECT * FROM automation_jobs WHERE id = ?', r.lastInsertRowid);
    if (!job) {
      const existing = idempotencyKey
        ? await this.db.get('SELECT * FROM automation_jobs WHERE idempotency_key = ?', idempotencyKey)
        : null;
      if (existing) return { job: existing, created: false };
      throw new Error('Job enqueue failed: the inserted job could not be read back.');
    }
    await this._history(job.id, 'created', stage);
    return { job, created: true };
  }

  /**
   * Atomically claim the next runnable job and take a time-boxed lease.
   * The lease is what makes crash recovery possible: a worker that dies
   * leaves `lease_until` behind and the job is reclaimed later.
   */
  async claim(workerId, { leaseMs = 10 * 60 * 1000, stages = null } = {}) {
    const now = nowSqlite();
    const leaseUntil = sqliteUtc(new Date(Date.now() + leaseMs));
    const stageClause = stages && stages.length ? `AND stage IN (${stages.map(() => '?').join(',')})` : '';

    // SELECT takes (run_after <=, lease_until <=, ...stages)
    const selectParams = [now, now];
    if (stages && stages.length) selectParams.push(...stages);

    const job = await this.db.get(
      `SELECT * FROM automation_jobs
        WHERE status IN ('queued','waiting_retry')
          AND run_after <= ?
          AND (lease_until IS NULL OR lease_until <= ?)
          ${stageClause}
        ORDER BY run_after ASC, id ASC
        LIMIT 1`,
      ...selectParams,
    );
    if (!job) return null;

    const res = await this.db.run(
      `UPDATE automation_jobs
          SET status='running', attempts=attempts+1, worker_id=?, lease_until=?, started_at=?, updated_at=datetime('now')
        WHERE id=? AND status IN ('queued','waiting_retry')`,
      workerId, leaseUntil, now, job.id,
    );
    if (res.changes === 0) return null; // lost the race to another worker

    await this._history(job.id, 'claimed', workerId);
    return this.db.get('SELECT * FROM automation_jobs WHERE id = ?', job.id);
  }

  async complete(jobId, result = null) {
    await this.db.run(
      `UPDATE automation_jobs
          SET status='succeeded', result=?, finished_at=datetime('now'),
              lease_until=NULL, updated_at=datetime('now')
        WHERE id=?`,
      result === null ? null : JSON.stringify(result), jobId,
    );
    await this._history(jobId, 'succeeded');
  }

  /**
   * Record a failure. Transient failures are rescheduled with bounded backoff;
   * permanent failures stop immediately rather than retrying forever.
   */
  async fail(jobId, error, { kind = 'system', retryable = false, maxAttempts = null } = {}) {
    const job = await this.db.get('SELECT * FROM automation_jobs WHERE id = ?', jobId);
    if (!job) return null;
    const message = String(error?.message || error || 'Unknown error').slice(0, 2000);
    const limit = maxAttempts ?? job.max_attempts;
    const canRetry = retryable && job.attempts < limit;

    if (canRetry) {
      const at = sqliteUtc(new Date(Date.now() + backoffMs(job.attempts)));
      await this.db.run(
        `UPDATE automation_jobs
            SET status='waiting_retry', last_error=?, error_kind=?, run_after=?,
                lease_until=NULL, updated_at=datetime('now')
          WHERE id=?`,
        message, kind, at, jobId,
      );
      await this._history(jobId, 'retry', `attempt ${job.attempts}/${limit}: ${message}`);
      return { retried: true, runAfter: at };
    }

    await this.db.run(
      `UPDATE automation_jobs
          SET status='failed', last_error=?, error_kind=?, finished_at=datetime('now'),
              lease_until=NULL, updated_at=datetime('now')
        WHERE id=?`,
      message, kind, jobId,
    );
    await this._history(jobId, 'failed', message);
    log.warn(`job ${jobId} failed permanently`, { stage: job.stage, kind, message });
    return { retried: false };
  }

  /**
   * Crash recovery: a job left `running` whose lease expired belonged to a
   * process that died. Requeue it (respecting the attempt budget).
   */
  async recoverStale() {
    const now = nowSqlite();
    const stale = await this.db.all(
      `SELECT * FROM automation_jobs
        WHERE status='running' AND (lease_until IS NULL OR lease_until <= ?)`,
      now,
    );
    let recovered = 0;
    for (const job of stale) {
      if (job.attempts < job.max_attempts) {
        await this.db.run(
          `UPDATE automation_jobs
              SET status='waiting_retry', lease_until=NULL, worker_id=NULL,
                  run_after=?, last_error='Recovered after worker interruption',
                  updated_at=datetime('now')
            WHERE id=?`,
          now, job.id,
        );
        await this._history(job.id, 'recovered', 'lease expired; requeued');
        recovered++;
      } else {
        await this.db.run(
          `UPDATE automation_jobs SET status='failed', lease_until=NULL,
                  last_error='Abandoned after worker interruption', finished_at=datetime('now'),
                  updated_at=datetime('now')
            WHERE id=?`,
          job.id,
        );
        await this._history(job.id, 'failed', 'abandoned');
      }
    }
    if (recovered) log.info(`recovered ${recovered} interrupted job(s)`);
    return recovered;
  }

  /**
   * Cancel a single job, including one that is currently running. Used when a
   * mission is paused/stopped after the job was claimed, so the job cannot be
   * left stranded in `running`.
   */
  async cancel(jobId, reason = 'cancelled') {
    await this.db.run(
      `UPDATE automation_jobs
          SET status='cancelled', last_error=?, lease_until=NULL, updated_at=datetime('now')
        WHERE id=?`,
      reason, jobId,
    );
    await this._history(jobId, 'cancelled', reason);
    return this.get(jobId);
  }

  /** Safe stop: cancel queued work for a mission without touching running work. */
  async cancelQueued({ missionId, userId = null, stages = null } = {}) {
    const clauses = [`status IN ('queued','waiting_retry')`];
    const params = [];
    if (missionId) { clauses.push('mission_id = ?'); params.push(missionId); }
    if (userId) { clauses.push('user_id = ?'); params.push(userId); }
    if (stages && stages.length) {
      clauses.push(`stage IN (${stages.map(() => '?').join(',')})`);
      params.push(...stages);
    }
    const rows = await this.db.all(`SELECT id FROM automation_jobs WHERE ${clauses.join(' AND ')}`, ...params);
    for (const r of rows) {
      await this.db.run(
        `UPDATE automation_jobs SET status='cancelled', lease_until=NULL, updated_at=datetime('now') WHERE id=?`,
        r.id,
      );
      await this._history(r.id, 'cancelled', 'stopped by user or mission state');
    }
    return rows.length;
  }

  /** Extend a lease for long-running work so recovery does not steal it. */
  async heartbeat(jobId, leaseMs = 10 * 60 * 1000) {
    await this.db.run(
      `UPDATE automation_jobs SET lease_until=?, updated_at=datetime('now') WHERE id=? AND status='running'`,
      sqliteUtc(new Date(Date.now() + leaseMs)), jobId,
    );
  }

  async get(jobId) { return this.db.get('SELECT * FROM automation_jobs WHERE id = ?', jobId); }

  async stats({ userId = null, missionId = null } = {}) {
    const clauses = [];
    const params = [];
    if (userId) { clauses.push('user_id = ?'); params.push(userId); }
    if (missionId) { clauses.push('mission_id = ?'); params.push(missionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.db.all(`SELECT status, COUNT(*) n FROM automation_jobs ${where} GROUP BY status`, ...params);
    const out = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      queued: out.queued || 0,
      running: out.running || 0,
      waiting_retry: out.waiting_retry || 0,
      succeeded: out.succeeded || 0,
      failed: out.failed || 0,
      cancelled: out.cancelled || 0,
    };
  }

  async recent({ userId, missionId = null, limit = 50 } = {}) {
    if (missionId) {
      return this.db.all(
        `SELECT * FROM automation_jobs WHERE user_id=? AND mission_id=? ORDER BY id DESC LIMIT ?`,
        userId, missionId, limit,
      );
    }
    return this.db.all('SELECT * FROM automation_jobs WHERE user_id=? ORDER BY id DESC LIMIT ?', userId, limit);
  }

  async history(jobId) {
    return this.db.all('SELECT * FROM job_history WHERE job_id=? ORDER BY id ASC', jobId);
  }

  /**
   * Jobs of a given stage that are due to run right now — used by the
   * scheduler's producers (mailbox monitoring, follow-ups) and by the
   * serverless tick endpoint.
   */
  async countRunnable({ userId = null, stages = null } = {}) {
    const clauses = [`status IN ('queued','waiting_retry')`, 'run_after <= ?'];
    const params = [nowSqlite()];
    if (userId) { clauses.push('user_id = ?'); params.push(userId); }
    if (stages && stages.length) {
      clauses.push(`stage IN (${stages.map(() => '?').join(',')})`);
      params.push(...stages);
    }
    const row = await this.db.get(
      `SELECT COUNT(*) n FROM automation_jobs WHERE ${clauses.join(' AND ')}`,
      ...params,
    );
    return row?.n || 0;
  }
}

export default JobQueue;
