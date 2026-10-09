import { STAGE } from './queue.js';
import { err } from '../core/errors.js';
import { discoverViaOverpass, resolveBusinessTypes } from '../discovery/overpass.js';
import { fetchUrl } from '../research/fetcher.js';
import { extractWebsiteEvidence, heuristicScore } from '../research/website-analysis.js';
import { nowSqlite } from '../core/time.js';

/**
 * §11 Discovery and §12/§13 Research.
 *
 * Businesses come from a real discovery source and website facts come from
 * really fetched HTML. Nothing here is invented.
 */

/** §11 — find candidate businesses for a mission location. */
export async function discoveryHandler(ctx) {
  const { services, mission, payload, job } = ctx;
  const { missions, leads, queue } = services;
  // Marks the mission visibly as running for the duration of this pass.
  const runDiscovery = mission.status === 'scheduled';

  const location = payload.location || (await missions.locations(mission.id))[0];
  if (!location) throw err.discovery('NO_TARGET', 'The mission has no target location configured.');

  const types = resolveBusinessTypes(
    [mission.target_description, mission.investigation_notes, payload.hint].filter(Boolean).join(' ')
  );
  if (!types.length) {
    throw err.discovery(
      'DISCOVERY_NO_TYPE_MATCH',
      'No business type matched this mission. Name the type to scout for, or configure a paid discovery provider.'
    );
  }

  const limit = Math.min(payload.limit || mission.max_leads_per_run, 100);
  // The discovery source is injectable so the pipeline can be exercised
  // without a network round trip; the default is the real Overpass client.
  const discover = services.discovery?.discover ?? discoverViaOverpass;
  const { candidates, source, area } = await discover({
    country: location.country,
    region: location.region,
    city: location.city,
    types,
    limit,
  });

  // Mark the mission visibly as running for the duration of this pass.
  if (runDiscovery) await ctx.db.run("UPDATE missions SET status = 'running' WHERE id = ?", mission.id);

  let created = 0;
  let duplicates = 0;
  const leadIds = [];
  for (const candidate of candidates) {
    const result = await leads.createFromCandidate(job.user_id, mission.id, candidate);
    if (!result.created) {
      if (result.reason === 'duplicate') duplicates++;
      continue;
    }
    created++;
    leadIds.push(result.lead.id);
    await queue.enqueue({
      userId: job.user_id,
      missionId: mission.id,
      stage: STAGE.RESEARCH,
      payload: { leadId: result.lead.id },
      idempotencyKey: `research:${result.lead.id}`,
    });
  }

  await ctx.db.run(
    `UPDATE missions
        SET last_run_at = ?,
            next_run_at = ?,
            -- The run is finished; the scheduler owns the next one, so a
            -- recurring mission returns to 'scheduled' rather than sitting in
            -- 'running' forever (which would block its own follow-ups).
            status = CASE WHEN status = 'running' THEN 'scheduled' ELSE status END
      WHERE id = ?`,
    nowSqlite(), await missions.computeNextRun(mission, new Date()), mission.id
  );

  ctx.log.info(`discovery: ${created} new, ${duplicates} duplicate, ${candidates.length} returned`);
  return { source, area, returned: candidates.length, created, duplicates, leadIds };
}

/** §12/§13 — investigate a lead: fetch its website, or record that it has none. */
export async function researchHandler(ctx) {
  const { services, payload, job } = ctx;
  const { leads, queue } = services;
  const lead = await leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');

  const enqueueAnalysis = (extra = {}) => queue.enqueue({
    userId: job.user_id,
    missionId: lead.mission_id,
    stage: STAGE.SITE_ANALYSIS,
    payload: { leadId: lead.id, ...extra },
    idempotencyKey: `site_analysis:${lead.id}`,
  });

  // §13: a missing website must not disqualify a business.
  if (!lead.website_url) {
    await leads.savePresenceAnalysis(lead.id, {
      evidence: {
        hasWebsite: false,
        discoverySource: lead.discovery_source,
        publicPhone: lead.phone_public,
        publicEmail: lead.email_public,
        contactRoute: lead.contact_route,
        contactEvidence: lead.contact_evidence,
        address: lead.address,
      },
      findings: {
        websiteListed: false,
        contactRouteFound: Boolean(lead.contact_route),
        analysisMethod: 'discovery_metadata_only',
      },
      score: null,
      method: 'discovery_metadata',
    });
    await leads.setStatus(lead.id, 'investigated');
    await enqueueAnalysis();
    return { leadId: lead.id, hasWebsite: false };
  }

  const startedAt = Date.now();
  let page = null;
  let failure = null;
  // Injectable so the pipeline can run without outbound HTTP; the default is
  // the polite, robots-respecting fetcher.
  const fetchPage = services.research?.fetchUrl ?? fetchUrl;
  try {
    page = await fetchPage(lead.website_url);
  } catch (e) {
    failure = e;
  }

  if (!page) {
    await leads.saveWebsiteAnalysis(lead.id, {
      ok: false,
      url: lead.website_url,
      error: failure?.message || 'fetch failed',
      fetchedMs: Date.now() - startedAt,
    });
    await leads.setStatus(lead.id, 'investigated', { error: failure?.message });
    // The lead is still analysed so the AI can judge it from what we recorded.
    await enqueueAnalysis({ fetchFailed: true });
    throw failure || new Error('fetch failed');
  }

  const evidence = extractWebsiteEvidence(page.body, {
    url: page.url, bytes: page.bytes, contentType: page.contentType,
  });
  const score = heuristicScore(evidence);
  await leads.saveWebsiteAnalysis(lead.id, {
    ok: true, url: page.url, evidence,
    findings: { heuristicScore: score },
    score, method: evidence.analysisMethod,
    fetchedMs: Date.now() - startedAt,
  });
  await leads.setStatus(lead.id, 'investigated');
  await ctx.heartbeat();
  await enqueueAnalysis();

  return { leadId: lead.id, hasWebsite: true, bytes: page.bytes, score };
}
