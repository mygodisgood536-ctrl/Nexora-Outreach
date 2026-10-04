import { STAGE } from './queue.js';
import { nowSqlite, sqliteUtc } from '../core/time.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scheduler');

/**
 * Window-driven scheduling (spec §10).
 *
 * At the start of an active window the scheduler enqueues eligible discovery
 * work for each running mission. Outside a window it starts nothing.
 *
 * Duplicate prevention is enforced two ways:
 *  - an in-memory set of missions already started in the current window, and
 *  - an idempotency key derived from the window, so even a process restart
 *    cannot start the same window twice.
 */

export function windowKeyFor(missionId, windowStartIso) {
  return `sched:${missionId}:${windowStartIso}`;
}

export class Scheduler {
  constructor({ db, queue, missions, pollMs = 30000 }) {
    this.db = db;
    this.queue = queue;
    this.missions = missions;
    this.pollMs = pollMs;
    this.running = false;
    this._timer = null;
    this._wake = null;
    this.startedWindows = new Set();
  }

  /** Missions eligible to be scheduled right now. */
  dueMissions(now = new Date()) {
    const missions = this.db.all(
      "SELECT * FROM missions WHERE status = 'scheduled' AND archived_at IS NULL"
    );
    return missions.filter((m) => {
      // §26: a globally paused account runs nothing.
      const user = this.db.get('SELECT automation_paused FROM users WHERE id = ?', m.user_id);
      if (user?.automation_paused) return false;
      return this.missions.isWithinWindow(m, now);
    });
  }

  /**
   * Schedule one mission's discovery run for the current window.
   * Returns the created job, or null when nothing should run.
   */
  scheduleMission(mission, { now = new Date() } = {}) {
    if (!mission || mission.status !== 'scheduled') return null;
    if (this.startedWindows.has(mission.id)) return null;

    const windowStart = this.currentWindowStart(mission, now);
    if (!windowStart) return null;
    const key = windowKeyFor(mission.id, windowStart);
    if (this.startedWindows.has(key)) return null;

    const locations = this.missions.locations(mission.id);
    if (!locations.length) return null;

    let enqueued = 0;
    for (const location of locations) {
      const { created } = this.queue.enqueue({
        userId: mission.user_id,
        missionId: mission.id,
        stage: STAGE.DISCOVERY,
        payload: { location, limit: mission.max_leads_per_run },
        // One discovery run per mission per window; replays are absorbed.
        idempotencyKey: `${key}:${location.country}:${location.city || location.region || '*'}`,
      });
      if (created) enqueued++;
    }

    this.startedWindows.add(key);
    this.startedWindows.add(mission.id);

    // Keep next_run_at current for the UI (§10).
    const next = this.missions.computeNextRun(mission, now);
    this.db.run('UPDATE missions SET next_run_at = ? WHERE id = ?', next, mission.id);

    log.info(`scheduled ${enqueued} discovery job(s) for mission ${mission.id} (window ${windowStart})`);
    return { missionId: mission.id, windowStart, enqueued, key };
  }

  /**
   * ISO timestamp of the start of the window containing `now`, or null when
   * the mission is outside its windows.
   */
  currentWindowStart(mission, now = new Date()) {
    const windows = this.missions.windows(mission.id);
    if (!windows.length) return null;
    if (!this.missions.isWithinWindow(mission, now)) return null;
    // The window identity only needs to be stable within a day.
    return `${now.toISOString().slice(0, 13)}`;
  }

  /** One scheduling pass. */
  tick(now = new Date()) {
    const results = [];
    for (const mission of this.dueMissions(now)) {
      const r = this.scheduleMission(mission, { now });
      if (r) results.push(r);
    }
    // Forget per-mission guards for windows that have closed.
    if (results.length === 0 && this.startedWindows.size > 500) {
      this.startedWindows = new Set([...this.startedWindows].filter((k) => k.startsWith('sched:')));
    }
    return results;
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`scheduler started (poll ${this.pollMs}ms)`);
    const loop = async () => {
      while (this.running) {
        try { this.tick(new Date()); } catch (e) { log.error('scheduler tick failed', { message: e?.message }); }
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
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._wake = null; resolve(); }, ms);
      this._wake = () => { clearTimeout(timer); this._wake = null; resolve(); };
    });
  }

  async stop() {
    this.running = false;
    if (this._wake) this._wake();
    if (this._timer) await this._timer.catch(() => {});
    this._timer = null;
    log.info('scheduler stopped');
  }
}

export { nowSqlite, sqliteUtc };
export default Scheduler;