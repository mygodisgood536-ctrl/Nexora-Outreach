import { err } from '../core/errors.js';
import {
  businessDedupeKey, normalizeDomain, normalizeUrl, normalizeEmail,
  normalizePhone, normalizeCountry,
} from '../core/normalize.js';
import { nowSqlite } from '../core/time.js';

/** Ordered pipeline stages a lead moves through (spec §23). */
export const LEAD_STATUS = [
  'discovered', 'investigated', 'analyzed', 'qualified',
  'message_generated', 'awaiting_approval', 'sent', 'replied',
  'suppressed', 'closed', 'failed',
];

/**
 * Lead persistence with cross-mission duplicate prevention (spec §29).
 *
 * A unique index on (user_id, dedupe_key) guarantees the same business is
 * never re-discovered or re-contacted for one user, even across missions.
 */
export class LeadService {
  constructor({ db }) { this.db = db; }

  /**
   * Insert a discovered candidate. Returns the existing lead when the same
   * business is already known, so the caller can skip downstream work.
   */
  createFromCandidate(userId, missionId, candidate) {
    const businessName = String(candidate.name || candidate.businessName || '').trim();
    if (!businessName) return { created: false, reason: 'missing_name' };

    const websiteUrl = normalizeUrl(candidate.website || candidate.websiteUrl);
    const domain = normalizeDomain(candidate.website || candidate.websiteUrl);
    const country = normalizeCountry(candidate.country);
    const dedupeKey = businessDedupeKey({
      domain, websiteUrl, businessName,
      city: candidate.city, region: candidate.region, country,
    });

    const existing = this.db.get(
      'SELECT * FROM leads WHERE user_id = ? AND dedupe_key = ?', userId, dedupeKey
    );
    if (existing) return { created: false, reason: 'duplicate', lead: existing };

    const emailPublic = normalizeEmail(candidate.email || candidate.emailPublic);
    const phonePublic = normalizePhone(candidate.phone || candidate.phonePublic);
    // A contact route is only recorded when the source actually supplied it,
    // together with the URL that witnessed it. Never inferred (spec §29).
    const contactRoute = emailPublic ? 'email' : phonePublic ? 'phone' : null;

    const id = this.db.run(
      `INSERT INTO leads(mission_id, user_id, business_name, website_url, domain, dedupe_key,
                         country, region, city, address, phone_public, email_public,
                         contact_route, contact_evidence, discovery_source, discovery_meta,
                         rating, review_count)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      missionId, userId, businessName, websiteUrl, domain, dedupeKey,
      country, candidate.region || null, candidate.city || null,
      candidate.address || null, phonePublic, emailPublic,
      contactRoute, candidate.contactEvidence || candidate.sourceUrl || null,
      candidate.source || 'unknown',
      candidate.meta ? JSON.stringify(candidate.meta) : null,
      typeof candidate.rating === 'number' ? candidate.rating : null,
      typeof candidate.reviewCount === 'number' ? candidate.reviewCount : null
    ).lastInsertRowid;

    return { created: true, lead: this.get(id) };
  }

  get(id) { return this.db.get('SELECT * FROM leads WHERE id = ?', id); }

  getForUser(id, userId) {
    const lead = this.get(id);
    if (!lead || lead.user_id !== userId) throw err.notFound('Lead');
    return lead;
  }

  setStatus(id, status, { error = null } = {}) {
    if (!LEAD_STATUS.includes(status)) throw err.validation(`Unknown lead status: ${status}`);
    this.db.run(
      "UPDATE leads SET status = ?, stage_error = ?, updated_at = datetime('now') WHERE id = ?",
      status, error, id
    );
    return this.get(id);
  }

  markContacted(id) {
    this.db.run(
      "UPDATE leads SET first_contacted_at = COALESCE(first_contacted_at, ?), updated_at = datetime('now') WHERE id = ?",
      nowSqlite(), id
    );
  }

  /** Has this lead ever been emailed? (spec §14 "previous contact state") */
  hasBeenContacted(id) {
    return Boolean(this.get(id)?.first_contacted_at);
  }
saveWebsiteAnalysis(leadId, { ok, url, error, evidence, findings, score, method, fetchedMs }) {
    this.db.run(
      `INSERT INTO website_analyses(lead_id, url, ok, error, evidence, findings, score, method, fetched_ms)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(lead_id) DO UPDATE SET
         url=excluded.url, ok=excluded.ok, error=excluded.error,
         evidence=excluded.evidence, findings=excluded.findings,
         score=excluded.score, method=excluded.method, fetched_ms=excluded.fetched_ms`,
      leadId, url ?? null, ok ? 1 : 0, error ?? null,
      evidence ? JSON.stringify(evidence) : null,
      findings ? JSON.stringify(findings) : null,
      score ?? null, method ?? null, fetchedMs ?? null
    );
    return this.websiteAnalysis(leadId);
  }

  savePresenceAnalysis(leadId, { evidence, findings, score, method }) {
    this.db.run(
      `INSERT INTO presence_analyses(lead_id, evidence, findings, score, method)
       VALUES(?,?,?,?,?)
       ON CONFLICT(lead_id) DO UPDATE SET
         evidence=excluded.evidence, findings=excluded.findings,
         score=excluded.score, method=excluded.method`,
      leadId,
      evidence ? JSON.stringify(evidence) : null,
      findings ? JSON.stringify(findings) : null,
      score ?? null, method ?? null
    );
    return this.presenceAnalysis(leadId);
  }

  saveQualification(leadId, { qualified, confidence, reason, observed, opportunity, relevantService, explanation, model, error }) {
    this.db.run(
      `INSERT INTO qualifications(lead_id, model, qualified, confidence, reason, observed, opportunity,
                                   relevant_service, explanation, error)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(lead_id) DO UPDATE SET
         model=excluded.model, qualified=excluded.qualified, confidence=excluded.confidence,
         reason=excluded.reason, observed=excluded.observed, opportunity=excluded.opportunity,
         relevant_service=excluded.relevant_service, explanation=excluded.explanation,
         error=excluded.error`,
      leadId, model ?? null, qualified ? 1 : 0, confidence ?? null, reason ?? null,
      observed ? JSON.stringify(observed) : null, opportunity ?? null,
      relevantService ?? null, explanation ?? null, error ?? null
    );
    return this.qualification(leadId);
  }

  websiteAnalysis(leadId) { return parseJson(this.db.get('SELECT * FROM website_analyses WHERE lead_id = ?', leadId)); }
  presenceAnalysis(leadId) { return parseJson(this.db.get('SELECT * FROM presence_analyses WHERE lead_id = ?', leadId)); }
  qualification(leadId) { return parseJson(this.db.get('SELECT * FROM qualifications WHERE lead_id = ?', leadId)); }

  /**
   * The evidence bundle handed to the AI stages. Only real recorded
   * observations are included — nothing is synthesised here.
   */
  evidenceFor(leadId) {
    const lead = this.get(leadId);
    if (!lead) return null;
    const site = this.websiteAnalysis(leadId);
    const presence = this.presenceAnalysis(leadId);
    return {
      lead: {
        id: lead.id,
        businessName: lead.business_name,
        websiteUrl: lead.website_url,
        country: lead.country,
        region: lead.region,
        city: lead.city,
        rating: lead.rating,
        reviewCount: lead.review_count,
        contactRoute: lead.contact_route,
        emailPublic: lead.email_public,
        phonePublic: lead.phone_public,
        discoverySource: lead.discovery_source,
      },
      website: site ? { ok: site.ok, url: site.url, error: site.error, score: site.score, findings: site.findings, evidence: site.evidence } : null,
      presence: presence ? { findings: presence.findings, score: presence.score, evidence: presence.evidence } : null,
      qualification: this.qualification(leadId),
    };
  }

  list(userId, { missionId = null, status = null, limit = 100, offset = 0 } = {}) {
    const clauses = ['user_id = ?'];
    const params = [userId];
    if (missionId) { clauses.push('mission_id = ?'); params.push(missionId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    params.push(limit, offset);
    return this.db.all(
      `SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...params
    );
  }

  count(userId, missionId = null) {
    if (missionId) {
      return this.db.get('SELECT COUNT(*) n FROM leads WHERE user_id = ? AND mission_id = ?', userId, missionId).n;
    }
    return this.db.get('SELECT COUNT(*) n FROM leads WHERE user_id = ?', userId).n;
  }

  toPublic(row) {
    if (!row) return null;
    return {
      id: row.id,
      missionId: row.mission_id,
      businessName: row.business_name,
      websiteUrl: row.website_url,
      country: row.country,
      region: row.region,
      city: row.city,
      rating: row.rating,
      reviewCount: row.review_count,
      contactRoute: row.contact_route,
      emailPublic: row.email_public,
      phonePublic: row.phone_public,
      discoverySource: row.discovery_source,
      status: row.status,
      firstContactedAt: row.first_contacted_at,
      createdAt: row.created_at,
    };
  }
}

function parseJson(row) {
  if (!row) return null;
  const out = { ...row };
  for (const key of ['evidence', 'findings', 'observed']) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { /* leave as-is */ }
    }
  }
  return out;
}

export default LeadService;