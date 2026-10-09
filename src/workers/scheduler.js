import { STAGE } from './queue.js';
import { minutesInTz, sqliteUtc } from '../core/time.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('scheduler');

/** How often each connected mailbox is polled for replies (§18). */
const MONITOR_BUCKET_MS = 15 * 60 * 1000;

/**
 * Window-driven scheduling (spec §10).
 *
 * At the start of an active window the scheduler enqueues eligible discovery
 * work for each running mission. Outside a window it starts nothing.
 *
 * Duplicate prevention is enforced two ways:
 *  - an in-memory set of window occurrences already started by this process, and
 *  - an idempotency key derived from the window occurrence, so even a process
 *    restart cannot start the same window twice.
 *
 * A window occurrence is identified by the mission-local date it started on
 * plus its start minute — one key per window per day, stable for the whole
 * window (unlike an hourly key, which would restart work every hour).
 */

export function windowKeyFor(missionId, windowOccurrence) {
  return `sched:${missionId}:${windowOccurrence}`;
}

/** Mission-local calendar date ("YYYY-MM-DD") of an instant. */
function localDateKey(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * The window occurrence `now` falls into, or null when the mission is outside
 * every window. Handles windows that wrap past midnight: their occurrence is
 * dated on the day the window *started*.
 */
export function activeWindowOccurrence(windows, tz, now = new Date()) {
  if (!windows || windows.length === 0) return null;
  const { minutes, dayOfWeek } = minutesInTz(now, tz);
  const prevDay = (dayOfWeek + 6) % 7;
  const today = localDateKey(now, tz);
  const yesterday = localDateKey(new Date(now.getTime() - 86400000), tz);

  for (const w of windows) {
    const { day_of_week: d, start_min: s, end_min: e } = w;
    if (e <= s) {
      // Wraps past midnight (e.g. 22:00 -> 02:00).
      if (d === dayOfWeek && minutes >= s) return { window: w, occurrence: `${today}:${s}` };
      if (d === prevDay && minutes < e) return { window: w, occurrence: `${yesterday}:${s}` };
      continue;
    }
    if (d === dayOfWeek && minutes >= s && minutes < e) {
      return { window: w, occurrence: `${today}:${s}` };
    }
  }
  return null;
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
    /** occurrence key -> when this process started it (fast path only). */
    this.startedWindows = new Map();
  }

  /** Missions eligible to be scheduled right now. */
  async dueMissions(now = new Date()) {
    const rows = await this.db.all(
      `SELECT m.*, u.automation_paused
         FROM missions m
         JOIN users u ON u.id = m.user_id
        WHERE m.status = 'scheduled' AND m.archived_at IS NULL`,
    );
    const out = [];
    for (const m of rows) {
      // §26: a globally paused account runs nothing.
      if (m.automation_paused) continue;
      try {
        const windows = await this.missions.windows(m.id);
        if (activeWindowOccurrence(windows, m.timezone, now)) out.push(m);
      } catch (e) {
        log.warn(`skipping mission ${m.id}: ${e?.message}`);
      }
    }
    return out;
  }

  /**
   * Schedule one mission's discovery run for the current window.
   * Returns the created job batch, or null when nothing should run.
   */
  async scheduleMission(mission, { now = new Date() } = {}) {
    if (!mission || mission.status !== 'scheduled') return null;

    const windows = await this.missions.windows(mission.id);
    const active = activeWindowOccurrence(windows, mission.timezone, now);
    if (!active) return null;

    const key = windowKeyFor(mission.id, active.occurrence);
    if (this.startedWindows.has(key)) return null;

    const locations = await this.missions.locations(mission.id);
    if (!locations.length) return null;

    let enqueued = 0;
    for (const location of locations) {
      const { created } = await this.queue.enqueue({
        userId: mission.user_id,
        missionId: mission.id,
        stage: STAGE.DISCOVERY,
        payload: { location, limit: mission.max_leads_per_run },
        // One discovery run per mission per window occurrence; replays are absorbed.
        idempotencyKey: `${key}:${location.country}:${location.city || location.region || '*'}`,
      });
      if (created) enqueued++;
    }

    this.startedWindows.set(key, Date.now());
    this._prune();

    // Keep next_run_at current for the UI (§10).
    const next = await this.missions.computeNextRun(mission, now);
    await this.db.run('UPDATE missions SET next_run_at = ? WHERE id = ?', next, mission.id);

    log.info(`scheduled ${enqueued} discovery job(s) for mission ${mission.id} (window ${active.occurrence})`);
    return { missionId: mission.id, windowStart: active.occurrence, enqueued, key };
  }

  /**
   * ISO timestamp of the start of the window containing `now`, or null when
   * the mission is outside its windows.
   */
  async currentWindowStart(mission, now = new Date()) {
    const windows = await this.missions.windows(mission.id);
    const active = activeWindowOccurrence(windows, mission.timezone, now);
    return active ? active.occurrence : null;
  }

  /** Forget occurrences older than two days so the guard set stays bounded. */
  _prune(maxEntries = 500) {
    if (this.startedWindows.size <= maxEntries) return;
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const [k, at] of this.startedWindows) {
      if (at < cutoff) this.startedWindows.delete(k);
    }
    if (this.startedWindows.size > maxEntries * 4) {
      this.startedWindows = new Map([...this.startedWindows].slice(-maxEntries));
    }
  }

  /** One scheduling pass. */
  async tick(now = new Date()) {
    const results = [];
    for (const mission of await this.dueMissions(now)) {
      const r = await this.scheduleMission(mission, { now });
      if (r) results.push(r);
    }
    // Follow-ups and reply monitoring are not window-bound: they belong to the
    // conversation, not the mission's scouting window (§18, §19). Both passes
    // are idempotent, so running them on every tick is safe.
    await this.scheduleFollowUps(now);
    await this.scheduleMailboxMonitors(now);
    return results;
  }

  /**
   * Enqueue follow-ups whose due_at has passed (§19).
   *
   * One job per pending follow-up row, keyed by the row itself, so a restart
   * or a concurrent tick cannot send the same follow-up twice. Paused accounts
   * and missions that are no longer scheduled are filtered out here rather
   * than inside the handler, so paused automation queues nothing at all.
   */
  async scheduleFollowUps(now = new Date()) {
    const rows = await this.db.all(
      `SELECT f.id, f.conversation_id, f.mission_id, m.user_id
         FROM follow_ups f
         JOIN missions m ON m.id = f.mission_id
         JOIN users u ON u.id = m.user_id
        WHERE f.status = 'pending'
          AND f.due_at <= ?
          AND m.status = 'scheduled'
          AND m.archived_at IS NULL
          AND u.automation_paused = 0
        ORDER BY f.due_at ASC`,
      sqliteUtc(now),
    );

    let enqueued = 0;
    for (const row of rows) {
      const { created } = await this.queue.enqueue({
        userId: row.user_id,
        missionId: row.mission_id,
        stage: STAGE.FOLLOW_UP,
        payload: { conversationId: row.conversation_id, followUpId: row.id },
        idempotencyKey: `followup:${row.id}`,
      });
      if (created) enqueued++;
    }
    if (enqueued) log.info(`scheduled ${enqueued} follow-up job(s)`);
    return { due: rows.length, enqueued };
  }

  /**
   * Enqueue one mailbox monitor job per connected mailbox (§18).
   *
   * Polling runs on a fixed 15-minute grid shared by every process: the bucket
   * number goes into the idempotency key, so two processes (or a restart in
   * the middle of a slot) cannot poll the same mailbox twice for the same slot.
   * Only accounts that have actually sent something are polled — a mailbox with
   * no outreach in flight cannot have replies to detect.
   */
  async scheduleMailboxMonitors(now = new Date()) {
    const rows = await this.db.all(
      `SELECT DISTINCT u.id AS user_id
         FROM users u
         JOIN email_connections c ON c.user_id = u.id AND c.status = 'connected'
        WHERE u.automation_paused = 0
          AND EXISTS (
            SELECT 1 FROM outreach_messages om
              JOIN missions m ON m.id = om.mission_id
             WHERE m.user_id = u.id AND om.send_status = 'sent'
          )`,
    );

    const bucket = Math.floor(now.getTime() / MONITOR_BUCKET_MS);
    let enqueued = 0;
    for (const row of rows) {
      const { created } = await this.queue.enqueue({
        userId: row.user_id,
        stage: STAGE.MAILBOX_MONITOR,
        payload: { bucket },
        idempotencyKey: `monitor:${row.user_id}:${bucket}`,
      });
      if (created) enqueued++;
    }
    if (enqueued) log.info(`scheduled ${enqueued} mailbox monitor job(s)`);
    return { mailboxes: rows.length, enqueued };
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`scheduler started (poll ${this.pollMs}ms)`);
    const loop = async () => {
      while (this.running) {
        try {
          await this.tick(new Date());
        } catch (e) {
          log.error('scheduler tick failed', { message: e?.message });
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

  async stop() {
    this.running = false;
    if (this._wake) this._wake();
    if (this._timer) await this._timer.catch(() => {});
    this._timer = null;
    log.info('scheduler stopped');
  }
}

export default Scheduler;
