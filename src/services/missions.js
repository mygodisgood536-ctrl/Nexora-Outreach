import { err } from '../core/errors.js';
import { nextWindowStart, isWithinWindows, parseTimeToMinutes } from '../core/time.js';
import { normalizeCountry, slugify, isValidTimeZone } from '../core/normalize.js';
import { recordAudit } from './audit.js';
import { sqliteUtc, nowSqlite } from '../core/time.js';

export const SENDING_MODES = ['scout_only', 'review_send', 'autopilot'];
export const MISSION_STATUS = ['draft', 'scheduled', 'running', 'paused', 'stopped', 'completed', 'archived'];

/** Columns a user may edit directly; structure changes go through their own methods. */
const EDITABLE = new Set([
  'name', 'objective_raw', 'service', 'offer_summary', 'target_description',
  'investigation_notes', 'outreach_instructions', 'sending_mode', 'timezone',
  'follow_up_delay_days', 'max_follow_ups', 'daily_send_limit', 'max_leads_per_run',
]);

export class MissionService {
  constructor({ db }) { this.db = db; }

  create(userId, input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw err.validation('Mission name is required.');
    const timezone = input.timezone || 'UTC';
    if (!isValidTimeZone(timezone)) throw err.validation(`Unknown timezone: ${timezone}`);
    if (input.sending_mode && !SENDING_MODES.includes(input.sending_mode)) {
      throw err.validation(`sending_mode must be one of ${SENDING_MODES.join(', ')}`);
    }

    const id = this.db.run(
      `INSERT INTO missions(user_id, name, objective_raw, service, offer_summary, target_description,
                           investigation_notes, outreach_instructions, sending_mode, timezone,
                           follow_up_delay_days, max_follow_ups, daily_send_limit, max_leads_per_run)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      userId, name, input.objective_raw ?? null, input.service || 'other',
      input.offer_summary ?? null, input.target_description ?? null,
      input.investigation_notes ?? null, input.outreach_instructions ?? null,
      input.sending_mode || 'scout_only', timezone,
      input.follow_up_delay_days ?? 2, input.max_follow_ups ?? 3,
      input.daily_send_limit ?? 20, input.max_leads_per_run ?? 25
    ).lastInsertRowid;

    if (Array.isArray(input.windows)) this.setWindows(id, input.windows);
    if (Array.isArray(input.locations)) this.setLocations(id, input.locations);
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.created', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  get(id) { return this.db.get('SELECT * FROM missions WHERE id = ?', id); }

  /** Ownership check — every mission read/write goes through this. */
  getForUser(id, userId) {
    const m = this.get(id);
    if (!m || m.user_id !== userId) throw err.notFound('Mission');
    return m;
  }

  list(userId, { includeArchived = false } = {}) {
    return includeArchived
      ? this.db.all('SELECT * FROM missions WHERE user_id = ? ORDER BY id DESC', userId)
      : this.db.all(
        "SELECT * FROM missions WHERE user_id = ? AND status != 'archived' ORDER BY id DESC", userId
      );
  }

  update(id, patch = {}) {
    if (patch.timezone && !isValidTimeZone(patch.timezone)) {
      throw err.validation(`Unknown timezone: ${patch.timezone}`);
    }
    if (patch.sending_mode && !SENDING_MODES.includes(patch.sending_mode)) {
      throw err.validation(`sending_mode must be one of ${SENDING_MODES.join(', ')}`);
    }
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE.has(key)) continue;
      // An omitted field must not be bound: SQLite rejects `undefined`.
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      params.push(value);
    }
    if (fields.length) {
      this.db.run(
        `UPDATE missions SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...params, id
      );
    }
    if (Array.isArray(patch.windows)) this.setWindows(id, patch.windows);
    if (Array.isArray(patch.locations)) this.setLocations(id, patch.locations);
    return this.get(id);
  }
setWindows(missionId, windows) {
    const clean = [];
    for (const w of windows) {
      const day = Number(w.dayOfWeek ?? w.day_of_week);
      const s = w.startMin ?? w.start_min;
      const e = w.endMin ?? w.end_min;
      if (!Number.isInteger(day) || day < 0 || day > 6) throw err.validation('dayOfWeek must be 0-6.');
      const start = typeof s === 'string' ? parseTimeToMinutes(s) : s;
      const end = typeof e === 'string' ? parseTimeToMinutes(e) : e;
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw err.validation('Window times must be "HH:MM".');
      if (start === end) throw err.validation('A window must have a non-zero duration.');
      clean.push({
        day,
        start: ((start % 1440) + 1440) % 1440,
        end: ((end % 1440) + 1440) % 1440,
      });
    }
    this.db.tx(() => {
      this.db.run('DELETE FROM mission_windows WHERE mission_id = ?', missionId);
      for (const w of clean) {
        this.db.run(
          'INSERT INTO mission_windows(mission_id, day_of_week, start_min, end_min) VALUES(?,?,?,?)',
          missionId, w.day, w.start, w.end
        );
      }
    });
    return this.windows(missionId);
  }

  windows(missionId) {
    return this.db.all(
      'SELECT day_of_week, start_min, end_min FROM mission_windows WHERE mission_id = ? ORDER BY day_of_week, start_min',
      missionId
    );
  }

  /** Spec §9: country is first-class and always a real ISO code, never a vague region. */
  setLocations(missionId, locations) {
    const clean = locations.map((l) => {
      const country = normalizeCountry(l.country);
      if (!country) throw err.validation('Each target needs a two-letter ISO country code (e.g. US, DE, AE).');
      const priority = ['high', 'medium', 'low'].includes(l.priority) ? l.priority : 'medium';
      return { country, region: l.region || null, city: l.city || null, priority };
    });
    this.db.tx(() => {
      this.db.run('DELETE FROM target_locations WHERE mission_id = ?', missionId);
      for (const l of clean) {
        this.db.run(
          'INSERT INTO target_locations(mission_id, country, region, city, priority) VALUES(?,?,?,?,?)',
          missionId, l.country, l.region, l.city, l.priority
        );
      }
    });
    return this.locations(missionId);
  }

  locations(missionId) {
    // Rank priority explicitly: alphabetical order would sort high < low < medium.
    return this.db.all(
      `SELECT id, country, region, city, priority FROM target_locations
        WHERE mission_id = ?
        ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, country`,
      missionId
    );
  }

  duplicate(id, userId) {
    const src = this.getForUser(id, userId);
    return this.create(userId, {
      name: `${src.name} (copy)`,
      objective_raw: src.objective_raw,
      service: src.service,
      offer_summary: src.offer_summary,
      target_description: src.target_description,
      investigation_notes: src.investigation_notes,
      outreach_instructions: src.outreach_instructions,
      // A duplicate always starts in the safest mode.
      sending_mode: 'scout_only',
      timezone: src.timezone,
      follow_up_delay_days: src.follow_up_delay_days,
      max_follow_ups: src.max_follow_ups,
      daily_send_limit: src.daily_send_limit,
      max_leads_per_run: src.max_leads_per_run,
      windows: this.windows(id),
      locations: this.locations(id),
    });
  }

  _setStatus(id, status, extra = {}) {
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params = [status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); params.push(v); }
    this.db.run(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Activation requires a schedule and at least one target country. */
  activate(id, userId) {
    const m = this.getForUser(id, userId);
    if (this.windows(id).length === 0) throw err.validation('Add at least one scouting window before activating.');
    if (this.locations(id).length === 0) throw err.validation('Add at least one target country before activating.');
    this._setStatus(id, 'scheduled', {
      activated_at: nowSqlite(),
      next_run_at: this.computeNextRun(m, new Date()),
    });
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.activated', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  pause(id, userId) {
    this.getForUser(id, userId);
    this._setStatus(id, 'paused');
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.paused', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  resume(id, userId) {
    const m = this.getForUser(id, userId);
    this._setStatus(id, 'scheduled', { next_run_at: this.computeNextRun(m, new Date()) });
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.resumed', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  stop(id, userId) {
    this.getForUser(id, userId);
    this._setStatus(id, 'stopped');
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.stopped', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  archive(id, userId) {
    this.getForUser(id, userId);
    this._setStatus(id, 'archived', { archived_at: nowSqlite() });
    recordAudit(this.db, { userId, actor: 'user', action: 'mission.archived', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  setInterpreted(id, interpreted, reviewed = false) {
    this.db.run(
      "UPDATE missions SET interpreted_json = ?, interpreted_reviewed = ?, updated_at = datetime('now') WHERE id = ?",
      JSON.stringify(interpreted), reviewed ? 1 : 0, id
    );
    return this.get(id);
  }

  /** Next moment the mission's scouting window opens (spec §10). */
  computeNextRun(mission, from = new Date()) {
    const windows = this.windows(mission.id);
    if (!windows.length) return null;
    const next = nextWindowStart(windows, from, mission.timezone);
    return next ? sqliteUtc(next) : null;
  }

  isWithinWindow(mission, at = new Date()) {
    const windows = this.windows(mission.id);
    return windows.length > 0 && isWithinWindows(windows, at, mission.timezone);
  }

  /** Shape sent to the client — never includes secrets. */
  toPublic(mission) {
    if (!mission) return null;
    return {
      id: mission.id,
      name: mission.name,
      status: mission.status,
      service: mission.service,
      objectiveRaw: mission.objective_raw,
      offerSummary: mission.offer_summary,
      targetDescription: mission.target_description,
      investigationNotes: mission.investigation_notes,
      outreachInstructions: mission.outreach_instructions,
      sendingMode: mission.sending_mode,
      timezone: mission.timezone,
      followUpDelayDays: mission.follow_up_delay_days,
      maxFollowUps: mission.max_follow_ups,
      dailySendLimit: mission.daily_send_limit,
      maxLeadsPerRun: mission.max_leads_per_run,
      interpreted: mission.interpreted_json ? JSON.parse(mission.interpreted_json) : null,
      interpretedReviewed: Boolean(mission.interpreted_reviewed),
      windows: this.windows(mission.id).map((w) => ({
        dayOfWeek: w.day_of_week, startMin: w.start_min, endMin: w.end_min,
      })),
      locations: this.locations(mission.id),
      activatedAt: mission.activated_at,
      lastRunAt: mission.last_run_at,
      nextRunAt: mission.next_run_at,
      createdAt: mission.created_at,
      slug: slugify(mission.name),
    };
  }
}

export default MissionService;