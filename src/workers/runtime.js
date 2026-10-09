import { randomUUID } from 'node:crypto';
import { createLogger } from '../core/logger.js';
import { AppError, ERROR_KIND, userFacingMessage } from '../core/errors.js';
import { STAGE, JOB_STATUS } from './queue.js';

const log = createLogger('worker');

/**
 * Executes queued jobs.
 *
 * Responsibilities (spec §23): run, claim with a lease, report results and
 * errors, retry transient failures with bounded backoff, and recover work
 * interrupted by a crash.
 *
 * Handlers are plain async functions `(ctx) => result`, registered per stage.
 * The runtime never fabricates success: a handler either returns a result or
 * throws, and a throw is recorded with its error kind.
 */
export class WorkerRuntime {
  constructor({ db, queue, workerId = null, leaseMs = 10 * 60 * 1000, pollMs = 1000, services = {} }) {
    this.db = db;
    this.queue = queue;
    this.workerId = workerId || `worker-${randomUUID().slice(0, 8)}`;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.services = services;
    this.handlers = new Map();
    this.running = false;
    this._timer = null;
    this._wake = null;
    this._inFlight = false;
    this.processed = 0;
  }

  register(stage, handler) {
    if (typeof handler !== 'function') throw new Error(`Handler for ${stage} must be a function`);
    this.handlers.set(stage, handler);
    return this;
  }

  registerAll(map) {
    for (const [stage, handler] of Object.entries(map)) this.register(stage, handler);
    return this;
  }

  has(stage) { return this.handlers.has(stage); }

  /**
   * A job whose mission is no longer running must not execute. Cancellation is
   * scoped to the stage so other stages keep running.
   */
  async blockReason(job) {
    if (!job.mission_id) {
      const onlyUser = await this.db.get('SELECT automation_paused FROM users WHERE id = ?', job.user_id);
      return onlyUser?.automation_paused ? 'automation_paused' : null;
    }
    const mission = await this.db.get('SELECT status FROM missions WHERE id = ?', job.mission_id);
    if (!mission) return 'mission_deleted';
    if (['paused', 'stopped', 'archived'].includes(mission.status)) return `mission_${mission.status}`;
    const user = await this.db.get('SELECT automation_paused FROM users WHERE id = ?', job.user_id);
    if (user?.automation_paused) return 'automation_paused';
    return null;
  }

  async makeContext(job) {
    const mission = job.mission_id
      ? await this.db.get('SELECT * FROM missions WHERE id = ?', job.mission_id)
      : null;
    return {
      db: this.db,
      queue: this.queue,
      job,
      payload: safeParse(job.payload),
      mission,
      user: await this.db.get('SELECT * FROM users WHERE id = ?', job.user_id),
      workerId: this.workerId,
      log: log.child(job.stage),
      services: this.services,
      heartbeat: () => this.queue.heartbeat(job.id, this.leaseMs),
      isCancelled: async () => Boolean(await this.blockReason(job)),
    };
  }

  /** Split failures by kind so the UI can explain what went wrong (§30). */
  async recordFailure(ctx, error) {
    // Honour an explicit kind/retryable on ANY error object, not just
    // AppError. Otherwise a provider error carrying a permanent code would be
    // retried forever and would never raise the right notification.
    const knownKinds = Object.values(ERROR_KIND);
    const kind = error instanceof AppError
      ? error.kind
      : (knownKinds.includes(error?.kind) ? error.kind : ERROR_KIND.SYSTEM);
    // An unknown error is assumed transient: losing work is worse than a retry.
    const retryable = typeof error?.retryable === 'boolean'
      ? error.retryable
      : (error instanceof AppError ? error.retryable : true);

    const result = await this.queue.fail(ctx.job.id, error, { kind, retryable });
    log.warn(`job ${ctx.job.id} (${ctx.job.stage}) failed`, { kind, retryable, message: error?.message });

    const notify = ctx.services?.notifications;
    if (notify) {
      try {
        if (kind === ERROR_KIND.AI) {
          await notify.create(ctx.job.user_id, {
            kind: 'ai_error', severity: 'warning',
            title: 'AI step needs attention',
            body: userFacingMessage(error), missionId: ctx.job.mission_id,
          });
        } else if (!retryable && ctx.job.mission_id) {
          await notify.create(ctx.job.user_id, {
            kind: 'job_failed', severity: 'warning',
            title: 'An automation step failed',
            body: `${ctx.job.stage}: ${userFacingMessage(error)}`, missionId: ctx.job.mission_id,
          });
        }
      } catch (e) {
        log.warn('could not raise failure notification', { message: e?.message });
      }
    }
    return result;
  }

  /**
   * One pass: recover interrupted work, then claim and execute a single job.
   * Returns the finished job, or null when the queue was empty.
   */
  async tick({ recover = true } = {}) {
    if (this._inFlight) return null;      // one job at a time per worker
    this._inFlight = true;
    try {
      if (recover) await this.queue.recoverStale();
      const job = await this.queue.claim(this.workerId, { leaseMs: this.leaseMs });
      if (!job) return null;

      const handler = this.handlers.get(job.stage);
      if (!handler) {
        await this.queue.fail(job.id, new Error(`No handler registered for stage "${job.stage}"`), {
          kind: ERROR_KIND.SYSTEM, retryable: false,
        });
        return this.queue.get(job.id);
      }

      // A mission paused or stopped after queueing must not keep executing.
      const blocked = await this.blockReason(job);
      if (blocked) {
        // `cancel` records the reason in job_history.
        await this.queue.cancel(job.id, blocked);
        return this.queue.get(job.id);
      }

      const ctx = await this.makeContext(job);
      try {
        const result = await handler(ctx);
        await this.queue.complete(job.id, result === undefined ? null : result);
        this.processed++;
        log.info(`job ${job.id} (${job.stage}) succeeded`, { missionId: job.mission_id });
      } catch (error) {
        await this.recordFailure(ctx, error);
      }
      return this.queue.get(job.id);
    } finally {
      this._inFlight = false;
    }
  }

  /** Drain the queue until empty. Used by tests and the CLI worker. */
  async drain({ maxJobs = 5000 } = {}) {
    const done = [];
    for (let i = 0; i < maxJobs; i++) {
      const job = await this.tick();
      if (!job) break;
      done.push(job);
    }
    return done;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    log.info(`worker ${this.workerId} started`);
    const loop = async () => {
      while (this.running) {
        try {
          const job = await this.tick();
          if (!this.running) break;
          if (!job) await this._sleep(this.pollMs);
        } catch (e) {
          log.error('worker loop error', { message: e?.message });
        }
        if (!this.running) break;
        await this._sleep(this.pollMs);
      }
    };
    this._timer = loop();
  }

  /**
   * Sleep that `stop()` can cut short, so shutdown does not have to wait out
   * a full poll interval before the loop notices it should exit.
   */
  _sleep(ms) {
    // A stop() that lands while a tick is in flight would otherwise arm a full
    // poll interval after the loop already decided to sleep.
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._wake = null; resolve(); }, ms);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  /** Safe stop: start nothing new; in-flight work stays recoverable (§26). */
  async stop() {
    this.running = false;
    if (this._wake) this._wake();
    if (this._timer) await this._timer.catch(() => {});
    this._timer = null;
    log.info(`worker ${this.workerId} stopped`);
  }
}

function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

export { STAGE, JOB_STATUS };
export default WorkerRuntime;
