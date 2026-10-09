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

export class SuppressionService {
  constructor({ db }) { this.db = db; }

  async add(userId, { scope, value, reason = null, source = 'manual' }) {
    const clean = normalizeSuppressionValue(scope, value);
    if (!clean) return null;
    await this.db.run(
      `INSERT INTO suppressions(user_id, scope, value, reason, source)
       VALUES(?,?,?,?,?)
       ON CONFLICT(user_id, scope, value) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
      userId, scope, clean, reason, source
    );
    await recordAudit(this.db, { userId, actor: 'system', action: 'suppression.added', entityType: 'suppression', entityId: `${scope}:${clean}` });
    return { scope, value: clean };
  }

  async addEmail(userId, email, reason = 'opt-out', source = 'opt_out') {
    return this.add(userId, { scope: SUPPRESSION_SCOPE.EMAIL, value: email, reason, source });
  }

  async addDomain(userId, domain, reason = 'domain opt-out', source = 'manual') {
    return this.add(userId, { scope: SUPPRESSION_SCOPE.DOMAIN, value: domain, reason, source });
  }

  async list(userId) {
    return this.db.all('SELECT * FROM suppressions WHERE user_id = ? ORDER BY created_at DESC', userId);
  }

  async remove(userId, id) {
    const res = await this.db.run('DELETE FROM suppressions WHERE user_id = ? AND id = ?', userId, id);
    return res.changes > 0;
  }

  async isSuppressed(userId, { email = null, domain = null, conversationId = null } = {}) {
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
    return (await this.db.get(
      `SELECT * FROM suppressions WHERE user_id = ? AND (${checks.join(' OR ')}) LIMIT 1`,
      ...params
    )) ?? null;
  }

  async recordBounce(userId, email, { hard = true, reason = 'bounced', provider = null } = {}) {
    if (!hard) {
      await recordAudit(this.db, { userId, actor: 'system', action: 'email.soft_bounce', detail: { email, provider } });
      return null;
    }
    return this.add(userId, {
      scope: SUPPRESSION_SCOPE.BOUNCE,
      value: email,
      reason,
      source: provider || 'provider',
    });
  }

  async recordComplaint(userId, email, provider = null) {
    return this.add(userId, {
      scope: SUPPRESSION_SCOPE.COMPLAINT,
      value: email,
      reason: 'reported as spam',
      source: provider || 'provider',
    });
  }
}

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
