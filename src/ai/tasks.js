import { err } from '../core/errors.js';
import {
  buildMissionInterpretation, buildSiteAnalysis, buildPresenceAnalysis,
  buildQualification, buildOutreach, buildReplyTriage,
} from './prompts.js';

/**
 * High-level AI operations used by the worker handlers.
 *
 * Each function owns its output validation so a malformed model response
 * becomes a typed error instead of corrupt downstream state. None of these
 * functions know which provider runs them — that is the AI runtime's job
 * (spec §7).
 */

const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);

export const VALID_SERVICES = ['website_design', 'email_marketing', 'seo', 'social_media', 'branding', 'other'];
export const VALID_INTENTS = ['interested', 'not_interested', 'asks_for_more', 'asks_questions', 'unsubscribes', 'unknown'];
const ISO2 = /^[A-Z]{2}$/;
const pct = (v) => isNum(v) && v >= 0 && v <= 100;

export class AITasks {
  constructor({ ai }) {
    if (!ai) throw new Error('AITasks requires an AIRuntime');
    this.ai = ai;
  }

  /** Spec §8 — natural language to structured settings, shown for review. */
  async interpretMission(userId, { objective, existing = {} } = {}) {
    const text = String(objective || '').trim();
    if (text.length < 10) throw err.validation('Describe the mission in a little more detail.');
    if (text.length > 6000) throw err.validation('Mission description is too long.');

    const { system, prompt } = buildMissionInterpretation({ objective: text, existing });
    const { data, model } = await this.ai.completeJson(userId, 'interpret_mission', {
      system, prompt, maxRetries: 1,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!VALID_SERVICES.includes(d.service)) return `service must be one of ${VALID_SERVICES.join('|')}`;
        if (!isStrArray(d.countries)) return 'countries must be an array of strings';
        if (!d.countries.every((c) => ISO2.test(c))) {
          return 'countries must be ISO-3166 alpha-2 codes such as "US" (spec §9 forbids vague regions)';
        }
        if (!isStrArray(d.qualification_bar)) return 'qualification_bar must be an array of strings';
        if (!d.outreach_instructions || typeof d.outreach_instructions !== 'object') {
          return 'outreach_instructions must be an object';
        }
        return true;
      },
    });
    return { ...data, countries: data.countries.map((c) => c.toUpperCase()), model };
  }

  /** Spec §12 — website assessment from recorded HTTP evidence. */
  async analyzeSite(userId, { lead, evidence, mission }) {
    const { system, prompt } = buildSiteAnalysis({
      businessName: lead.businessName, url: lead.websiteUrl, evidence, mission,
    });
    const { data, model } = await this.ai.completeJson(userId, 'analyze_site', {
      system, prompt, maxRetries: 1,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!isBool(d.has_website)) return 'has_website must be a boolean';
        if (!isStrArray(d.opportunities)) return 'opportunities must be an array of strings';
        if (!isStrArray(d.findings)) return 'findings must be an array';
        if (d.findings.some((f) => !isStr(f.issue) || !isStr(f.evidence))) {
          return 'each finding needs an "issue" and an "evidence" string';
        }
        if (!isBool(d.contact_route_found)) return 'contact_route_found must be a boolean';
        if (!pct(d.quality_score)) return 'quality_score must be a number 0-100';
        return true;
      },
    });
    return { ...data, model };
  }

  /** Spec §13 — a business with no website of its own is still investigable. */
  async analyzePresence(userId, { lead, evidence, mission }) {
    const { system, prompt } = buildPresenceAnalysis({
      businessName: lead.businessName, evidence, mission,
    });
    const { data, model } = await this.ai.completeJson(userId, 'analyze_presence', {
      system, prompt, maxRetries: 1,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!isStrArray(d.opportunities)) return 'opportunities must be an array of strings';
        if (!isBool(d.contact_route_found)) return 'contact_route_found must be a boolean';
        if (!pct(d.opportunity_score)) return 'opportunity_score must be a number 0-100';
        return true;
      },
    });
    return { ...data, model };
  }

/** Spec §14 — relevance and opportunity judgement. */
  async qualifyLead(userId, { lead, analysis, mission, previousContact = 'never contacted' }) {
    const { system, prompt } = buildQualification({ lead, analysis, mission, previousContact });
    const { data, model } = await this.ai.completeJson(userId, 'qualify', {
      system, prompt, maxRetries: 1,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!isBool(d.qualified)) return 'qualified must be a boolean';
        if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 1) {
          return 'confidence must be a number between 0 and 1';
        }
        if (!isStrArray(d.observed)) return 'observed must be an array of strings';
        if (d.qualified && !isStr(d.reason)) return 'a qualified lead needs a "reason"';
        return true;
      },
    });
    return { ...data, model };
  }

  /** Spec §15/§16 — individualized outreach. */
  async writeOutreach(userId, { lead, analysis, mission, senderName, senderEmail, followUpNumber = 0 }) {
    const { system, prompt } = buildOutreach({
      lead, analysis, mission, senderName, senderEmail, followUpNumber,
    });
    const { data, model } = await this.ai.completeJson(userId, 'write_outreach', {
      system, prompt, maxRetries: 1,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!isStr(d.subject) || !d.subject.trim()) return 'subject is required';
        if (!isStr(d.body) || d.body.trim().length < 20) return 'body is required';
        if (!d.checks || typeof d.checks !== 'object') return 'checks object is required';
        if (d.checks.claims_nothing_unobserved !== true) {
          return 'the model reported an unobserved claim; regenerating (spec §15)';
        }
        return true;
      },
    });
    return { ...data, model };
  }

  /** Spec §18 — inbound reply interpretation. */
  async triageReply(userId, { lead, mission, replyText }) {
    const { system, prompt } = buildReplyTriage({ lead, mission, replyText });
    const { data, model } = await this.ai.completeJson(userId, 'reply_triage', {
      system, prompt, maxRetries: 0,
      validate: (d) => {
        if (!d || typeof d !== 'object') return 'response is not an object';
        if (!VALID_INTENTS.includes(d.intent)) return `intent must be one of ${VALID_INTENTS.join('|')}`;
        if (!isBool(d.is_opt_out)) return 'is_opt_out must be a boolean';
        return true;
      },
    });
    return { ...data, model };
  }
}

export default AITasks;