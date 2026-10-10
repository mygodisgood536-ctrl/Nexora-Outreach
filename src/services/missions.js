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

  async create(userId, input = {}) {
    const name = String(input.name || '').trim();
    if (!name) throw err.validation('Mission name is required.');
    const timezone = input.timezone || 'UTC';
    if (!isValidTimeZone(timezone)) throw err.validation(`Unknown timezone: ${timezone}`);
    if (input.sending_mode && !SENDING_MODES.includes(input.sending_mode)) {
      throw err.validation(`sending_mode must be one of ${SENDING_MODES.join(', ')}`);
    }

    const result = await this.db.run(
      `INSERT INTO missions(user_id, name, objective_raw, service, offer_summary, target_description,
                           investigation_notes, outreach_instructions, sending_mode, timezone,
                           follow_up_delay_days, max_follow_ups, daily_send_limit, max_leads_per_run)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       RETURNING id`,
      userId, name, input.objective_raw ?? null, input.service || 'other',
      input.offer_summary ?? null, input.target_description ?? null,
      input.investigation_notes ?? null, input.outreach_instructions ?? null,
      input.sending_mode || 'scout_only', timezone,
      input.follow_up_delay_days ?? 2, input.max_follow_ups ?? 3,
      input.daily_send_limit ?? 20, input.max_leads_per_run ?? 25
    );
    const id = result.lastInsertRowid;

    if (Array.isArray(input.windows)) await this.setWindows(id, input.windows);
    if (Array.isArray(input.locations)) await this.setLocations(id, input.locations);
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.created', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async get(id) { return this.db.get('SELECT * FROM missions WHERE id = ?', id); }

  /** Ownership check — every mission read/write goes through this. */
  async getForUser(id, userId) {
    const m = await this.get(id);
    if (!m || m.user_id !== userId) throw err.notFound('Mission');
    return m;
  }

  async list(userId, { includeArchived = false } = {}) {
    return includeArchived
      ? this.db.all('SELECT * FROM missions WHERE user_id = ? ORDER BY id DESC', userId)
      : this.db.all(
        "SELECT * FROM missions WHERE user_id = ? AND status != 'archived' ORDER BY id DESC", userId
      );
  }

  async update(id, patch = {}) {
    if (patch.timezone && !isValidTimeZone(patch.timezone)) {
      throw err.validation(`Unknown timezone: ${patch.timezone}`);
    }
    if (patch.sending_mode !== undefined) {
      if (patch.sending_mode === null || !SENDING_MODES.includes(patch.sending_mode)) {
        throw err.validation(`sending_mode must be one of ${SENDING_MODES.join(', ')}`);
      }
    }
    const notNullFields = ['name', 'timezone', 'service', 'sending_mode'];
    for (const field of notNullFields) {
      if (field in patch && patch[field] === null) {
        throw err.validation(`${field} cannot be empty.`);
      }
    }
    // Free-text columns are the only ones a client may explicitly clear.
    const nullableFields = new Set([
      'objective_raw', 'offer_summary', 'target_description',
      'investigation_notes', 'outreach_instructions',
    ]);
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE.has(key)) continue;
      if (value === undefined) continue;
      if (value === null && !nullableFields.has(key)) continue; // null = leave unchanged
      fields.push(`${key} = ?`);
      params.push(value);
    }
    if (fields.length) {
      await this.db.run(
        `UPDATE missions SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...params, id
      );
    }
    if (Array.isArray(patch.windows)) await this.setWindows(id, patch.windows);
    if (Array.isArray(patch.locations)) await this.setLocations(id, patch.locations);
    return this.get(id);
  }

  async setWindows(missionId, windows) {
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
    await this.db.tx(async () => {
      await this.db.run('DELETE FROM mission_windows WHERE mission_id = ?', missionId);
      for (const w of clean) {
        await this.db.run(
          'INSERT INTO mission_windows(mission_id, day_of_week, start_min, end_min) VALUES(?,?,?,?)',
          missionId, w.day, w.start, w.end
        );
      }
    });
    return this.windows(missionId);
  }

  async windows(missionId) {
    return this.db.all(
      'SELECT day_of_week, start_min, end_min FROM mission_windows WHERE mission_id = ? ORDER BY day_of_week, start_min',
      missionId
    );
  }

  /** Spec §9: country is first-class and always a real ISO code, never a vague region. */
  async setLocations(missionId, locations) {
    const clean = locations.map((l) => {
      const country = normalizeCountry(l.country);
      if (!country) throw err.validation('Each target needs a two-letter ISO country code (e.g. US, DE, AE).');
      const priority = ['high', 'medium', 'low'].includes(l.priority) ? l.priority : 'medium';
      return { country, region: l.region || null, city: l.city || null, priority };
    });
    await this.db.tx(async () => {
      await this.db.run('DELETE FROM target_locations WHERE mission_id = ?', missionId);
      for (const l of clean) {
        await this.db.run(
          'INSERT INTO target_locations(mission_id, country, region, city, priority) VALUES(?,?,?,?,?)',
          missionId, l.country, l.region, l.city, l.priority
        );
      }
    });
    return this.locations(missionId);
  }

  async locations(missionId) {
    return this.db.all(
      `SELECT id, country, region, city, priority FROM target_locations
        WHERE mission_id = ?
        ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, country`,
      missionId
    );
  }

  async duplicate(id, userId) {
    const src = await this.getForUser(id, userId);
    const windows = await this.windows(id);
    const locations = await this.locations(id);
    return this.create(userId, {
      name: `${src.name} (copy)`,
      objective_raw: src.objective_raw,
      service: src.service,
      offer_summary: src.offer_summary,
      target_description: src.target_description,
      investigation_notes: src.investigation_notes,
      outreach_instructions: src.outreach_instructions,
      sending_mode: 'scout_only',
      timezone: src.timezone,
      follow_up_delay_days: src.follow_up_delay_days,
      max_follow_ups: src.max_follow_ups,
      daily_send_limit: src.daily_send_limit,
      max_leads_per_run: src.max_leads_per_run,
      windows,
      locations,
    });
  }

  async _setStatus(id, status, extra = {}) {
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params = [status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); params.push(v); }
    await this.db.run(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  async activate(id, userId) {
    const m = await this.getForUser(id, userId);
    const windows = await this.windows(id);
    const locations = await this.locations(id);
    if (windows.length === 0) throw err.validation('Add at least one scouting window before activating.');
    if (locations.length === 0) throw err.validation('Add at least one target country before activating.');
    await this._setStatus(id, 'scheduled', {
      activated_at: nowSqlite(),
      next_run_at: await this.computeNextRun(m, new Date()),
    });
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.activated', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async pause(id, userId) {
    await this.getForUser(id, userId);
    await this._setStatus(id, 'paused');
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.paused', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async resume(id, userId) {
    const m = await this.getForUser(id, userId);
    await this._setStatus(id, 'scheduled', { next_run_at: await this.computeNextRun(m, new Date()) });
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.resumed', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async stop(id, userId) {
    await this.getForUser(id, userId);
    await this._setStatus(id, 'stopped');
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.stopped', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async archive(id, userId) {
    await this.getForUser(id, userId);
    await this._setStatus(id, 'archived', { archived_at: nowSqlite() });
    await recordAudit(this.db, { userId, actor: 'user', action: 'mission.archived', entityType: 'mission', entityId: id });
    return this.get(id);
  }

  async setInterpreted(id, interpreted, reviewed = false) {
    await this.db.run(
      "UPDATE missions SET interpreted_json = ?, interpreted_reviewed = ?, updated_at = datetime('now') WHERE id = ?",
      JSON.stringify(interpreted), reviewed ? 1 : 0, id
    );
    return this.get(id);
  }

  async computeNextRun(mission, from = new Date()) {
    const windows = await this.windows(mission.id);
    if (!windows.length) return null;
    const next = nextWindowStart(windows, from, mission.timezone);
    return next ? sqliteUtc(next) : null;
  }

  async isWithinWindow(mission, at = new Date()) {
    const windows = await this.windows(mission.id);
    return windows.length > 0 && isWithinWindows(windows, at, mission.timezone);
  }

  async toPublic(mission) {
    if (!mission) return null;
    const windows = await this.windows(mission.id);
    const locations = await this.locations(mission.id);
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
      windows: windows.map((w) => ({
        dayOfWeek: w.day_of_week, startMin: w.start_min, endMin: w.end_min,
      })),
      locations,
      activatedAt: mission.activated_at,
      lastRunAt: mission.last_run_at,
      nextRunAt: mission.next_run_at,
      createdAt: mission.created_at,
      slug: slugify(mission.name),
    };
  }
}

export default MissionService;
