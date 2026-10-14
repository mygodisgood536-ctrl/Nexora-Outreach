import { sha256 } from '../core/crypto.js';
import { err } from '../core/errors.js';

/**
 * Versioned evidence store (spec §12/§13/§21/§30).
 *
 * Every evidence-collection pass over a lead opens a new, immutable `audits`
 * version (1, 2, 3 …), and each concrete finding is appended to
 * `audit_evidence` with the exact JSON that was recorded and its SHA-256 hash.
 *
 * The projections used by the rest of the app (`website_analyses`,
 * `presence_analyses`, `qualifications`) are overwritten on each pass; these
 * tables are what make it possible to say truthfully which version a claim was
 * drawn from, and to show the operator how the evidence changed over time.
 */
export const EVIDENCE_KIND = {
  RESEARCH: 'research',
  WEBSITE_FINDING: 'website_finding',
  PRESENCE: 'presence',
  RECOMMENDATION: 'recommendation',
  VERIFICATION: 'verification',
  QUALIFICATION: 'qualification',
};

export class EvidenceService {
  constructor({ db }) { this.db = db; }

  /**
   * Open the next audit version for a lead. The version is derived inside the
   * database so concurrent passes cannot both claim the same number; the
   * UNIQUE(lead_id, version) constraint is the final guard.
   */
  async startAudit(userId, leadId, { trigger = 'research', method = null } = {}) {
    if (!leadId) throw err.validation('An audit needs a lead.');
    const row = await this.db.get(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM audits WHERE lead_id = ?',
      leadId,
    );
    const version = Number(row?.next || 1);
    const res = await this.db.run(
      `INSERT INTO audits(user_id, lead_id, version, status, trigger, method, started_at)
       VALUES(?,?,?, 'running', ?, ?, datetime('now')) RETURNING id`,
      userId, leadId, version, trigger, method,
    );
    return this.db.get('SELECT * FROM audits WHERE id = ?', res.lastInsertRowid);
  }

  /** Read one audit by id. */
  async audit(id) { return this.db.get('SELECT * FROM audits WHERE id = ?', id); }

  async latestAudit(leadId) {
    return this.db.get('SELECT * FROM audits WHERE lead_id = ? ORDER BY version DESC LIMIT 1', leadId);
  }

  async finishAudit(auditId, { status = 'succeeded', error = null, method = null } = {}) {
    if (!auditId) return null;
    await this.db.run(
      `UPDATE audits
          SET status = ?, error = ?, method = COALESCE(?, method), finished_at = datetime('now')
        WHERE id = ?`,
      status, error === null ? null : String(error).slice(0, 1000), method, auditId,
    );
    return this.db.get('SELECT * FROM audits WHERE id = ?', auditId);
  }

  /**
   * Append one evidence item. The JSON is hashed at write time so later edits
   * are detectable, and the row is bound to the audit version and the lead.
   */
  async record({ auditId, leadId, userId, kind, source = null, method = null, url = null, payload = null }) {
    if (!auditId) throw err.validation('Evidence must belong to an audit version.');
    if (!kind) throw err.validation('Evidence needs a kind.');
    const json = payload === undefined ? null : (payload === null ? null : JSON.stringify(payload));
    const hash = json === null ? null : sha256(json);
    const res = await this.db.run(
      `INSERT INTO audit_evidence(audit_id, lead_id, user_id, kind, source, method, url, payload, hash)
       VALUES(?,?,?,?,?,?,?,?,?) RETURNING id`,
      auditId, leadId, userId, kind, source, method, url, json, hash,
    );
    return this.db.get('SELECT * FROM audit_evidence WHERE id = ?', res.lastInsertRowid);
  }

  async evidenceFor(auditId) {
    return (await this.db.all(
      'SELECT * FROM audit_evidence WHERE audit_id = ? ORDER BY id ASC', auditId,
    )).map(parseEvidence);
  }

  async forLead(leadId, { limit = 100 } = {}) {
    return (await this.db.all(
      'SELECT * FROM audit_evidence WHERE lead_id = ? ORDER BY id DESC LIMIT ?', leadId, limit,
    )).map(parseEvidence);
  }

  /** Audits for a lead, newest first, each with its evidence attached. */
  async auditsFor(leadId, { limit = 20, evidenceLimit = 100 } = {}) {
    const audits = await this.db.all(
      'SELECT * FROM audits WHERE lead_id = ? ORDER BY version DESC LIMIT ?', leadId, limit,
    );
    const out = [];
    for (const audit of audits) {
      const evidence = await this.evidenceFor(audit.id);
      out.push({ ...audit, evidence: evidence.slice(0, evidenceLimit) });
    }
    return out;
  }

  /** The latest audit version with its evidence — what the prospect view shows. */
  async latestForLead(leadId) {
    const latest = await this.db.get(
      'SELECT * FROM audits WHERE lead_id = ? ORDER BY version DESC LIMIT 1', leadId,
    );
    if (!latest) return null;
    return { ...latest, evidence: await this.evidenceFor(latest.id) };
  }
}

function parseEvidence(row) {
  const out = { ...row };
  if (typeof out.payload === 'string') {
    try { out.payload = JSON.parse(out.payload); } catch { /* leave raw */ }
  }
  return out;
}

export default EvidenceService;
