import { createLogger } from '../core/logger.js';

const log = createLogger('audit');

/**
 * The single audit action that proves an automation tick ran — shared by the
 * cron route and the opportunistic driver so both are observable the same way.
 */
export const CRON_TICK_ACTION = 'cron.tick';


/**
 * Audit trail for important account and automation events (spec §5.3, §17, §30).
 * Kept in its own module so every service records events the same way.
 *
 * An audit failure must never break the operation being audited — the failure
 * itself is logged so it can be investigated rather than silently dropped.
 */
/** The most recent event for an action, or null. Never throws on read. */
export async function lastAudit(db, action) {
  try {
    const row = await db.get(
      'SELECT * FROM audit_events WHERE action = ? ORDER BY id DESC LIMIT 1', action,
    );
    return row || null;
  } catch {
    return null;
  }
}

export async function recordAudit(db, {
  userId = null, actor = 'system', action, entityType = null,
  entityId = null, detail = null, ip = null,
}) {
  try {
    await db.run(
      `INSERT INTO audit_events(user_id, actor, action, entity_type, entity_id, detail, ip)
       VALUES(?,?,?,?,?,?,?)`,
      userId, actor, action, entityType,
      entityId === null ? null : String(entityId),
      detail === null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
      ip,
    );
  } catch (e) {
    log.error(`failed to record audit event "${action}"`, { message: e?.message });
  }
}

export async function auditQuery(db, { userId, limit = 100, action = null } = {}) {
  if (action) {
    return db.all(
      'SELECT * FROM audit_events WHERE user_id = ? AND action = ? ORDER BY id DESC LIMIT ?',
      userId, action, limit,
    );
  }
  return db.all(
    'SELECT * FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    userId, limit,
  );
}

export default recordAudit;
