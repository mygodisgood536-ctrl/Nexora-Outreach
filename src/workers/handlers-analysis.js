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
  const { leads, ai, queue } = services;
  const lead = leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');

  const site = leads.websiteAnalysis(lead.id);
  const presence = leads.presenceAnalysis(lead.id);

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
    leads.saveWebsiteAnalysis(lead.id, {
      ok: true, url: site.url, evidence: site.evidence,
      findings: analysis.findings, score: analysis.quality_score, method: site.method,
    });
  } else {
    // §13 — a business with no website is analysed from its public presence.
    analysis = await ai.analyzePresence(job.user_id, {
      lead: leadView,
      evidence: presence?.evidence || (site?.error ? { fetchError: site.error } : {}),
      mission: missionView,
    });
    leads.savePresenceAnalysis(lead.id, {
      evidence: presence?.evidence || {},
      findings: analysis.findings,
      score: analysis.opportunity_score,
      method: presence?.method || 'discovery_metadata',
    });
  }

  // A contact route is adopted only when the page itself supplied the address.
  if (analysis.contact_route_found && !lead.contact_route) {
    const found = site?.evidence?.mailtoAddresses?.[0] || null;
    if (found) {
      ctx.db.run(
        'UPDATE leads SET email_public = ?, contact_route = ?, contact_evidence = ? WHERE id = ?',
        found, 'email', site?.url || lead.discovery_source, lead.id
      );
    }
  }

  leads.setStatus(lead.id, 'analyzed');
  ctx.heartbeat();
  queue.enqueue({
    userId: job.user_id, missionId: lead.mission_id,
    stage: STAGE.QUALIFICATION, payload: { leadId: lead.id },
    idempotencyKey: `qualification:${lead.id}`,
  });
  return { leadId: lead.id, findings: analysis.findings.length, model: analysis.model };
}

/** §14 — decide whether the prospect is relevant and has a real opportunity. */
export async function qualificationHandler(ctx) {
  const { services, payload, job, mission } = ctx;
  const { leads, ai, queue } = services;
  const lead = leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');

  const evidence = leads.evidenceFor(lead.id);
  const result = await ai.qualifyLead(job.user_id, {
    lead: evidence.lead,
    analysis: { website: evidence.website, presence: evidence.presence },
    mission: {
      offer_summary: mission.offer_summary,
      target_description: mission.target_description,
      interpretation: mission.interpreted_json ? JSON.parse(mission.interpreted_json) : null,
    },
    previousContact: lead.first_contacted_at ? 'already contacted' : 'never contacted',
  });

  leads.saveQualification(lead.id, {
    qualified: result.qualified,
    confidence: result.confidence,
    reason: result.reason,
    observed: result.observed,
    opportunity: result.opportunity,
    relevantService: result.relevant_service,
    explanation: result.explanation,
    model: result.model,
  });

  if (!result.qualified) {
    // §14: do not contact every discovered business.
    leads.setStatus(lead.id, 'closed');
    ctx.log.info(`lead ${lead.id} not qualified: ${result.reason || 'insufficient evidence'}`);
    return { leadId: lead.id, qualified: false, confidence: result.confidence };
  }

  leads.setStatus(lead.id, 'qualified');
  queue.enqueue({
    userId: job.user_id, missionId: lead.mission_id,
    stage: STAGE.OUTREACH, payload: { leadId: lead.id },
    idempotencyKey: `outreach:${lead.id}`,
  });
  return { leadId: lead.id, qualified: true, confidence: result.confidence, model: result.model };
}