import { STAGE } from './queue.js';
import { err } from '../core/errors.js';

/**
 * §12/§13 Website analysis and §14 qualification.
 *
 * Both stages run on the OpenCode-backed AI runtime and are given only the
 * evidence recorded by the research stage.
 */

export async function siteAnalysisHandler(ctx) {
  const { services, payload, job, mission } = ctx;
  const { leads, ai, queue, evidence: audit } = services;
  const lead = await leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');
  // The audit version opened by the research pass this analysis belongs to.
  const auditId = payload.auditId ?? null;

  const site = await leads.websiteAnalysis(lead.id);
  const presence = await leads.presenceAnalysis(lead.id);

  const leadView = {
    businessName: lead.business_name,
    websiteUrl: lead.website_url,
    city: lead.city, region: lead.region, country: lead.country,
    contactRoute: lead.contact_route,
    discoverySource: lead.discovery_source,
  };
  const missionView = {
    service: mission.service,
    target_description: mission.target_description,
    offer_summary: mission.offer_summary,
    interpretation: mission.interpreted_json ? JSON.parse(mission.interpreted_json) : null,
  };

  let analysis;
  if (site?.ok) {
    analysis = await ai.analyzeSite(job.user_id, {
      lead: leadView, evidence: site.evidence, mission: missionView,
    });
    await leads.saveWebsiteAnalysis(lead.id, {
      ok: true, url: site.url, evidence: site.evidence,
      findings: analysis.findings, score: analysis.quality_score, method: site.method,
    });
    await recordEvidence(audit, auditId, lead, job, {
      kind: 'website_finding',
      source: lead.discovery_source,
      method: site.method,
      url: site.url,
      payload: { evidence: site.evidence, findings: analysis.findings, qualityScore: analysis.quality_score, model: analysis.model },
    });
  } else {
    // §13 — a business with no website is analysed from its public presence.
    analysis = await ai.analyzePresence(job.user_id, {
      lead: leadView,
      evidence: presence?.evidence || (site?.error ? { fetchError: site.error } : {}),
      mission: missionView,
    });
    await leads.savePresenceAnalysis(lead.id, {
      evidence: presence?.evidence || {},
      findings: analysis.findings,
      score: analysis.opportunity_score,
      method: presence?.method || 'discovery_metadata',
    });
    await recordEvidence(audit, auditId, lead, job, {
      kind: 'presence',
      source: lead.discovery_source,
      method: presence?.method || 'discovery_metadata',
      url: lead.website_url || null,
      payload: { evidence: presence?.evidence || {}, findings: analysis.findings, opportunityScore: analysis.opportunity_score, model: analysis.model },
    });
    await recordEvidence(audit, auditId, lead, job, {
      kind: 'recommendation',
      source: lead.discovery_source,
      method: 'ai_recommendation',
      payload: { findings: analysis.findings },
    });
  }

  // A contact route is adopted only when the page itself supplied the address.
  if (analysis.contact_route_found && !lead.contact_route) {
    const found = site?.evidence?.mailtoAddresses?.[0] || null;
    if (found) {
      await ctx.db.run(
        'UPDATE leads SET email_public = ?, contact_route = ?, contact_evidence = ? WHERE id = ?',
        found, 'email', site?.url || lead.discovery_source, lead.id
      );
    }
  }

  await leads.setStatus(lead.id, 'analyzed');
  if (audit && auditId) {
    await audit.finishAudit(auditId, {
      status: 'succeeded',
      method: site?.ok ? (site.method || 'website_analysis') : (presence?.method || 'discovery_metadata'),
    });
  }
  await ctx.heartbeat();
  await queue.enqueue({
    userId: job.user_id, missionId: lead.mission_id,
    stage: STAGE.QUALIFICATION, payload: { leadId: lead.id, auditId },
    idempotencyKey: `qualification:${lead.id}`,
  });
  return { leadId: lead.id, findings: analysis.findings.length, model: analysis.model };
}

/**
 * Best-effort evidence append. Recorded evidence must never break the pipeline,
 * so a missing service or audit is a no-op and write errors are swallowed after
 * a log line — the audit trail is valuable but not load-bearing.
 */
async function recordEvidence(audit, auditId, lead, job, item) {
  if (!audit || !auditId) return null;
  try {
    return await audit.record({
      auditId, leadId: lead.id, userId: job.user_id,
      kind: item.kind, source: item.source ?? null, method: item.method ?? null,
      url: item.url ?? null, payload: item.payload ?? null,
    });
  } catch (e) {
    return null;
  }
}

/** §14 — decide whether the prospect is relevant and has a real opportunity. */
export async function qualificationHandler(ctx) {
  const { services, payload, job, mission } = ctx;
  const { leads, ai, queue, notifications, missions, evidence: audit } = services;
  const lead = await leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');

  const bundle = await leads.evidenceFor(lead.id);
  const result = await ai.qualifyLead(job.user_id, {
    lead: bundle.lead,
    analysis: { website: bundle.website, presence: bundle.presence },
    mission: {
      offer_summary: mission.offer_summary,
      target_description: mission.target_description,
      interpretation: mission.interpreted_json ? JSON.parse(mission.interpreted_json) : null,
    },
    previousContact: lead.first_contacted_at ? 'already contacted' : 'never contacted',
  });

  await leads.saveQualification(lead.id, {
    qualified: result.qualified,
    confidence: result.confidence,
    reason: result.reason,
    observed: result.observed,
    opportunity: result.opportunity,
    relevantService: result.relevant_service,
    recommendedService: result.recommended_service,
    explanation: result.explanation,
    model: result.model,
  });
  await recordEvidence(audit, payload.auditId, lead, job, {
    kind: 'qualification',
    source: lead.discovery_source,
    method: 'ai_qualification',
    payload: {
      qualified: result.qualified,
      confidence: result.confidence,
      reason: result.reason,
      observed: result.observed,
      opportunity: result.opportunity,
      recommended_service: result.recommended_service,
      model: result.model,
    },
  });
  // §16: also record the structured recommendation as its own evidence kind so
  // the redesign decision is auditable independently of the qualification text.
  if (result.recommended_service) {
    await recordEvidence(audit, payload.auditId, lead, job, {
      kind: 'recommendation',
      source: lead.discovery_source,
      method: 'controlled_recommendation',
      payload: { recommended_service: result.recommended_service },
    });
  }

  if (!result.qualified) {
    // §14: do not contact every discovered business.
    await leads.setStatus(lead.id, 'closed');
    ctx.log.info(`lead ${lead.id} not qualified: ${result.reason || 'insufficient evidence'}`);
    return { leadId: lead.id, qualified: false, confidence: result.confidence };
  }

  await leads.setStatus(lead.id, 'qualified');
  // §25 — "high-priority lead found": the operator is told when a prospect is
  // worth looking at now, rather than having to watch the prospect list. A lead
  // is high priority when it sits in a target the user marked High, or when the
  // qualification confidence is very strong.
  await notifyHighPriority({ services, notifications, missions, mission, lead, result, job });
  await queue.enqueue({
    userId: job.user_id, missionId: lead.mission_id,
    stage: STAGE.OUTREACH, payload: { leadId: lead.id },
    idempotencyKey: `outreach:${lead.id}`,
  });
  return { leadId: lead.id, qualified: true, confidence: result.confidence, model: result.model };
}

/** §25 — raise the high-priority-lead signal; never fails the qualification itself. */
async function notifyHighPriority({ notifications, missions, mission, lead, result, job }) {
  if (!notifications) return;
  try {
    const confidence = Number(result.confidence ?? 0);
    const norm = (v) => String(v || '').trim().toLowerCase();
    let highPriorityTarget = false;
    if (mission) {
      const targets = await missions.locations(mission.id);
      highPriorityTarget = targets.some((t) =>
        t.priority === 'high'
        && norm(t.country) === norm(lead.country)
        && (!t.city || norm(t.city) === norm(lead.city)));
    }
    if (!highPriorityTarget && confidence < 0.85) return;
    await notifications.create(job.user_id, {
      kind: 'high_priority_lead', severity: 'info',
      title: `High-priority prospect: ${lead.business_name}`,
      body: result.opportunity || result.reason || 'Qualified with strong confidence.',
      missionId: mission?.id ?? null, leadId: lead.id,
    });
  } catch { /* a notification failure must never fail the pipeline stage */ }
}
