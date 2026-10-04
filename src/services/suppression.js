import { normalizeEmail, normalizeDomain } from '../core/normalize.js';
import { recordAudit } from './audit.js';

export const SUPPRESSION_SCOPE = {
  EMAIL: 'email',
  DOMAIN: 'domain',
  CONVERSATION: 'conversation',
  BOUNCE: 'bounce',
  COMPLAINT: 'complaint',
  MANUAL: 'manual',
};

/**
 * Suppression and opt-out state (spec §17, §29).
 *
 * A suppressed address is never contacted again, regardless of mission or
 * sending mode. Opt-outs are honoured permanently.
 */
export class SuppressionService {
  constructor({ db }) { this.db = db; }

  add(userId, { scope, value, reason = null, source = 'manual' }) {
    const clean = normalizeSuppressionValue(scope, value);
    if (!clean) return null;
    this.db.run(
      `INSERT INTO suppressions(user_id, scope, value, reason, source)
       VALUES(?,?,?,?,?)
       ON CONFLICT(user_id, scope, value) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
      userId, scope, clean, reason, source
    );
    recordAudit(this.db, { userId, actor: 'system', action: 'suppression.added', entityType: 'suppression', entityId: `${scope}:${clean}` });
    return { scope, value: clean };
  }

  addEmail(userId, email, reason = 'opt-out', source = 'opt_out') {
    return this.add(userId, { scope: SUPPRESSION_SCOPE.EMAIL, value: email, reason, source });
  }

  addDomain(userId, domain, reason = 'domain opt-out', source = 'manual') {
    return this.add(userId, { scope: SUPPRESSION_SCOPE.DOMAIN, value: domain, reason, source });
  }

  list(userId) {
    return this.db.all('SELECT * FROM suppressions WHERE user_id = ? ORDER BY created_at DESC', userId);
  }

  remove(userId, id) {
    return this.db.run('DELETE FROM suppressions WHERE user_id = ? AND id = ?', userId, id).changes > 0;
  }

  /**
   * The authoritative pre-send check. Returns the matching suppression
   * record, or null when the recipient may be contacted.
   *
   * An address is suppressed by ANY address-level scope — explicit opt-out,
   * hard bounce or spam complaint — so a bounced or complained address can
   * never be contacted again.
   */
  isSuppressed(userId, { email = null, domain = null, conversationId = null } = {}) {
    const checks = [];
    const params = [userId];

    const emailNorm = normalizeEmail(email);
    const domainNorm = normalizeDomain(domain)
      || (emailNorm ? normalizeDomain(emailNorm.split('@')[1]) : null);

    if (emailNorm) {
      checks.push(`(scope IN ('email','bounce','complaint') AND value = ?)`);
      params.push(emailNorm);
    }
    if (domainNorm) {
      checks.push(`(scope = 'domain' AND value = ?)`);
      params.push(domainNorm);
    }
    if (conversationId) {
      checks.push(`(scope = 'conversation' AND value = ?)`);
      params.push(String(conversationId));
    }
    if (!checks.length) return null;
    return this.db.get(
      `SELECT * FROM suppressions WHERE user_id = ? AND (${checks.join(' OR ')}) LIMIT 1`,
      ...params
    ) ?? null;
  }

  /**
   * Record a bounce and suppress the address. A hard bounce means the address
   * is undeliverable, so it must never be retried (spec §17).
   */
  recordBounce(userId, email, { hard = true, reason = 'bounced', provider = null } = {}) {
    if (!hard) {
      recordAudit(this.db, { userId, actor: 'system', action: 'email.soft_bounce', detail: { email, provider } });
      return null;
    }
    return this.add(userId, {
      scope: SUPPRESSION_SCOPE.BOUNCE,
      value: email,
      reason,
      source: provider || 'provider',
    });
  }

  /** A complaint/spam report is the strongest signal; suppress immediately. */
  recordComplaint(userId, email, provider = null) {
    return this.add(userId, {
      scope: SUPPRESSION_SCOPE.COMPLAINT,
      value: email,
      reason: 'reported as spam',
      source: provider || 'provider',
    });
  }
}

/** Suppression values are normalised per scope; bad input is ignored, not stored. */
function normalizeSuppressionValue(scope, value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (scope === SUPPRESSION_SCOPE.EMAIL) return normalizeEmail(raw);
  if (scope === SUPPRESSION_SCOPE.DOMAIN) return normalizeDomain(raw);
  if (scope === SUPPRESSION_SCOPE.CONVERSATION) return /^\d+$/.test(raw) ? raw : null;
  return raw.slice(0, 200);
}

export default SuppressionService;