import { createLogger } from '../core/logger.js';

const log = createLogger('audit');

/**
 * Audit trail for important account and automation events (spec §5.3, §17, §30).
 * Kept in its own module so every service records events the same way.
 *
 * An audit failure must never break the operation being audited — the failure
 * itself is logged so it can be investigated rather than silently dropped.
 */
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
