/**
 * Prompt construction for every AI reasoning step in the pipeline.
 *
 * Two rules shape all of these prompts (spec §15, §29):
 *  1. The model may only assert what appears in the supplied evidence.
 *  2. It must never invent contact details or claim to have observed
 *     something it was not given.
 *
 * Prompts carry NO secrets and no provider-specific instructions — execution
 * is handled by the OpenCode adapter.
 */

/** Shared guardrails applied to every reasoning call. */
export const EVIDENCE_DISCIPLINE = [
  'You are a reasoning engine inside Nexora Outreach, an autonomous prospecting system.',
  'You may ONLY assert facts that appear in the EVIDENCE provided to you.',
  'Never invent facts, observations, contact details, phone numbers or email addresses.',
  'If the evidence does not support a conclusion, say so explicitly by returning empty arrays or false.',
  'Never claim to have personally viewed, visited or tested anything.',
  'Never state that you are a human. Do not claim to have "seen" a website; refer to the recorded evidence.',
  'Be concise and specific. Generic filler is a failure.',
].join(' ');

/** Converts an evidence object into a stable, compact text block. */
export function evidenceBlock(evidence) {
  const lines = [];
  const walk = (obj, prefix = '') => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${prefix}[${i}]`));
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}.${k}` : k);
      return;
    }
    const value = String(obj).slice(0, 300);
    if (value.trim() !== '') lines.push(`- ${prefix}: ${value}`);
  };
  walk(evidence);
  return lines.join('\n') || '- (no evidence recorded)';
}

/**
 * Spec §8: turn a natural-language objective into structured settings the
 * user can review before activation.
 */
export function buildMissionInterpretation({ objective, existing = {} }) {
  return {
    system: `${EVIDENCE_DISCIPLINE} You convert a user's plain-language business objective into structured scouting settings.`,
    prompt: `The user described a scouting mission in their own words.

USER OBJECTIVE:
"""
${objective}
"""

Return JSON with exactly these keys:
{
  "service": one of ["website_design","email_marketing","seo","social_media","branding","other"],
  "target_description": who they are looking for (business type + traits),
  "investigation_notes": what should be checked on each candidate,
  "offer_summary": the offer the user makes, in one sentence,
  "outreach_instructions": {
    "tone": string,
    "max_words": integer,
    "required_points": array of strings,
    "restrictions": array of strings
  },
  "countries": array of ISO-3166 alpha-2 codes ONLY (for example ["US","DE"]). Never return a vague region such as "Middle East"; list real countries instead.
  "qualification_bar": array of concrete conditions a lead must meet
}

EXISTING SETTINGS (may be empty):
${evidenceBlock(existing)}

Only list countries the objective actually mentions or clearly implies. If none are stated, return an empty array.`,
  };
}

/** Spec §12: turn raw HTTP evidence into concrete, observable findings. */
export function buildSiteAnalysis({ businessName, url, evidence, mission }) {
  return {
    system: `${EVIDENCE_DISCIPLINE} You assess a business website from recorded technical evidence only.`,
    prompt: `Assess this website for a "${mission?.service || 'general'}" scouting mission.

BUSINESS: ${businessName}
WEBSITE: ${url || '(none)'}
MISSION BRIEF: ${mission?.target_description || 'not specified'}
SERVICE OFFERED: ${mission?.offer_summary || 'not specified'}

RECORDED EVIDENCE (HTTP-level; note this analysis did not render JavaScript):
${evidenceBlock(evidence)}

Return JSON:
{
  "has_website": boolean,
  "findings": array of {"issue": string, "evidence": string, "severity": "low"|"medium"|"high"},
  "opportunities": array of string,
  "contact_route_found": boolean,
  "contact_evidence": string,
  "quality_score": integer 0-100
}

Every entry in "findings" MUST cite a specific string from the evidence above. Never describe a visual quality you cannot verify from the evidence (for example, do not claim a layout "looks dated"). If evidence is thin, return fewer findings.`,
  };
}

/** Spec §13: investigate a business that has no website of its own. */
export function buildPresenceAnalysis({ businessName, evidence, mission }) {
  return {
    system: `${EVIDENCE_DISCIPLINE} You assess a business that has no website of its own, using only public presence evidence.`,
    prompt: `This business has no website listed. Assess its online presence.

BUSINESS: ${businessName}
MISSION BRIEF: ${mission?.target_description || 'not specified'}
SERVICE OFFERED: ${mission?.offer_summary || 'not specified'}

RECORDED EVIDENCE:
${evidenceBlock(evidence)}

Return JSON:
{
  "findings": array of {"issue": string, "evidence": string, "severity": "low"|"medium"|"high"},
  "opportunities": array of string,
  "contact_route_found": boolean,
  "contact_route": string,
  "contact_evidence": string,
  "opportunity_score": integer 0-100
}

A missing website does NOT by itself disqualify a business. Set contact_route_found to false rather than guessing an address or email.`,
  };
}
/** Spec §14: decide whether a prospect is relevant and has a concrete opportunity. */
export function buildQualification({ lead, analysis, mission, previousContact }) {
  return {
    system: `${EVIDENCE_DISCIPLINE} You decide whether a discovered business is worth contacting for a specific offer.`,
    prompt: `Decide if this prospect should be contacted.

BUSINESS: ${lead.businessName}
${lead.websiteUrl ? `WEBSITE: ${lead.websiteUrl}` : 'WEBSITE: none listed'}
LOCATION: ${[lead.city, lead.region, lead.country].filter(Boolean).join(', ') || 'unknown'}
DISCOVERY SOURCE: ${lead.discoverySource}
OBSERVED CONTACT ROUTE: ${lead.contactRoute || 'none recorded'}
PREVIOUS CONTACT STATE: ${previousContact || 'never contacted'}

WHAT THE USER SELLS: ${mission.offer_summary || 'not specified'}
WHO THEY TARGET: ${mission.target_description || 'not specified'}
MISSION QUALIFICATION BAR:
${(mission.interpretation?.qualification_bar || []).map((c) => `- ${c}`).join('\n') || '- not specified'}

RECORDED ANALYSIS EVIDENCE:
${evidenceBlock(analysis)}

Return JSON:
{
  "qualified": boolean,
  "confidence": number between 0 and 1,
  "reason": one sentence explaining why this lead was selected,
  "observed": array of concrete things actually observed,
  "opportunity": string describing the opportunity,
  "relevant_service": string,
  "explanation": string justifying the decision against the evidence
}

If the evidence is too thin to justify contact, return qualified=false and explain what is missing. Do not qualify a business merely because it exists.`,
  };
}

/** Spec §15/§16: individualized outreach for one specific prospect. */
export function buildOutreach({ lead, analysis, mission, senderName, senderEmail, followUpNumber = 0 }) {
  const isFollowUp = followUpNumber > 0;
  return {
    system: `${EVIDENCE_DISCIPLINE} You write short, natural, individualized business outreach.`,
    prompt: `Write ONE message to this specific business.

${isFollowUp
      ? `This is follow-up #${followUpNumber}. There has been NO reply yet. Do not repeat the original message; add one short, genuine new reason to reply, and keep it shorter than the first message.`
      : 'This is the first contact.'}

FROM: ${senderName} <${senderEmail}>
TO: ${lead.businessName}${lead.contactRoute ? ` via ${lead.contactRoute}` : ''}
LOCATION: ${[lead.city, lead.region, lead.country].filter(Boolean).join(', ') || 'unknown'}

WHAT THE USER OFFERS: ${mission.offer_summary || 'not specified'}
USER'S OUTREACH INSTRUCTIONS:
${mission.outreach_instructions || 'Write short, friendly, natural outreach. Do not sound like a generic sales pitch.'}

EVIDENCE ACTUALLY RECORDED FOR THIS BUSINESS (this is all you may refer to):
${evidenceBlock(analysis)}

Return JSON:
{
  "subject": string,
  "body": string,
  "referenced_observations": array of strings,
  "checks": {
    "mentions_real_observation": boolean,
    "claims_nothing_unobserved": boolean,
    "no_false_claims": boolean
  }
}

HARD RULES:
- Refer to at least one specific thing from the recorded evidence. If the evidence is empty, set referenced_observations to an empty array rather than inventing detail.
- Do not use a mass template with only the business name swapped.
- Do not claim to have visited or tested the site personally.
- Do not promise inbox placement or guaranteed results.
- No decorative separators, no emoji, no generic corporate filler.
- Keep it short unless the instructions say otherwise.`,
  };
}

/** Spec §18: interpret an inbound reply. */
export function buildReplyTriage({ lead, mission, replyText }) {
  return {
    system: `${EVIDENCE_DISCIPLINE} You read a prospect's reply and summarise what it means.`,
    prompt: `A prospect replied to outreach sent by ${mission.name || 'a Nexora mission'}.

BUSINESS: ${lead.businessName}
REPLY TEXT:
"""
${String(replyText || '').slice(0, 4000)}
"""

Return JSON:
{
  "intent": "interested"|"not_interested"|"asks_for_more"|"asks_questions"|"unsubscribes"|"unknown",
  "summary": one sentence,
  "should_stop_follow_up": boolean,
  "is_opt_out": boolean
}

Set is_opt_out to true only when the message clearly asks to stop receiving messages. Set should_stop_follow_up to true for any reply, because a human has taken over.`,
  };
}