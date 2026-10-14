import { AppError, ERROR_KIND } from '../core/errors.js';

/**
 * Deterministic message quality checks (spec §15/§16).
 *
 * The model is asked to self-report quality, but a self-report is not a
 * guarantee. These checks are the server-side authority: they run before a
 * draft is stored (regenerating it when it fails) and again at the send
 * boundary, so no retry, queued job, manual approval or alternate send path can
 * push a message that breaks the outreach rules. Every check is deterministic
 * and offline — no model call, no network — so the result is reproducible and
 * testable.
 */

/** Controlled vocabulary for the structured redesign recommendation (spec §16). */
export const RECOMMENDED_SERVICES = [
  'full_redesign',
  'homepage_improvement',
  'mobile_improvement',
  'other',
  'not_applicable',
];

export const QUALITY_ISSUE = {
  MISSING_RECIPIENT: 'MISSING_RECIPIENT',
  MISSING_SUBJECT: 'MISSING_SUBJECT',
  MISSING_BODY: 'MISSING_BODY',
  BODY_TOO_SHORT: 'BODY_TOO_SHORT',
  BODY_TOO_LONG: 'BODY_TOO_LONG',
  SUBJECT_TOO_LONG: 'SUBJECT_TOO_LONG',
  PLACEHOLDER: 'PLACEHOLDER',
  BANNED_SEPARATOR: 'BANNED_SEPARATOR',
  EMOJI: 'EMOJI',
  BANNED_FILLER: 'BANNED_FILLER',
  GUARANTEE_CLAIM: 'GUARANTEE_CLAIM',
  FALSE_OBSERVATION: 'UNSUPPORTED_CLAIM',
  NO_PERSONALIZATION: 'NO_PERSONALIZATION',
  UNSUPPORTED_REFERENCE: 'UNSUPPORTED_CLAIM',
  DUPLICATE_TEMPLATE: 'DUPLICATE_TEMPLATE',
  MISSING_RECIPIENT_ADDRESS: 'MISSING_RECIPIENT',
};

/** Phrases that mark generic corporate filler rather than specific outreach. */
const BANNED_FILLER = [
  'i hope this email finds you well',
  'i hope this message finds you well',
  'hope this finds you well',
  'i hope this email finds you well',
  'i hope you are doing well',
  'i wanted to reach out',
  'i wanted to reach out to',
  'i am reaching out',
  'i am reaching out to',
  'touching base',
  'touch base',
  'circle back',
  'i wanted to follow up',
  'just following up',
  'just checking in',
  'touch base',
  'game-changer',
  'game changer',
  'take it to the next level',
  'next level',
  'synergy',
  'circle back',
  'at the end of the day',
  'think outside the box',
  'low-hanging fruit',
  'low hanging fruit',
  'move the needle',
  'dive deep',
  'cutting-edge',
  'state-of-the-art',
  'revolutionary',
  'world-class',
  'best-in-class',
  'unlock your potential',
  'take your business to',
  'skyrocket',
];

/** Promises no honest cold email can make. */
const GUARANTEE_PATTERNS = [
  /\bguarantee(d|s)?\b/i,
  /\b100\s*%\s*(satisfaction|results?|placement|guaranteed)\b/i,
  /\bpromise (you|guaranteed)\b/i,
  /\bensure (you|inbox|placement)\b/i,
  /\bwill (definitely|surely|100%)\b/i,
  /\brank(s|ing)?\s+(#?\s*1|number one|first page)\b/i,
  /\btriple your\b/i,
  /\bdouble your (revenue|sales|traffic|leads)\b/i,
];

/**
 * Claims that imply first-hand inspection the pipeline never performed. The
 * workspace only reads public pages, so it must never claim otherwise.
 */
const FALSE_OBSERVATION_PATTERNS = [
  /\bi (personally )?(visited|tested|tried|used|audited|tested out)\b/i,
  /\bwe (visited|tested|tried|used|audited)\b/i,
  /\bwhen i (went|called|visited|tested|checked out)\b/i,
  /\bi (called|rang|phoned) (your|the)\b/i,
  /\bi (looked|looks) at your (site|website) (personally|myself|in person)\b/i,
];

/** Unfilled template tokens that must never reach a recipient. */
const PLACEHOLDER_PATTERNS = [
  /\{\{[^{}]+\}\}/,
  /\{[A-Za-z_][A-Za-z0-9_ ]*\}/,
  /\[(first name|name|company|business|insert[^\]]*|your name|business name)\]/i,
  /\b(lorem ipsum|xxx+|tbd|todo|<[a-z_]+>)\b/i,
];

const SEPARATOR_PATTERN = /(?:^|\n)\s*(?:[-=_*~•·]{3,}|[|/\\]{3,})\s*(?:\n|$)/;
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2049}\u{203C}]/u;

const DEFAULT_MAX_WORDS = 220;
const FOLLOW_UP_MAX_WORDS = 140;
const MIN_WORDS = 15;

const STOPWORDS_SET = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'have',
  'has', 'are', 'was', 'were', 'our', 'their', 'they', 'them', 'its', 'it',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'is', 'be', 'as', 'or',
  'we', 'us', 'but', 'not', 'can', 'will', 'would', 'could', 'should', 'may',
  'site', 'website', 'page', 'pages', 'business', 'company', 'more', 'most',
  'also', 'just', 'very', 'into', 'over', 'about', 'than', 'then', 'when',
  'which', 'while', 'where', 'what', 'here', 'there', 'been', 'being', 'do',
  'does', 'did', 'so', 'if', 'out', 'up', 'down', 'off', 'no', 'any', 'all',
]);

const words = (text) => String(text || '').toLowerCase().match(/[a-z][a-z0-9'-]*/g) || [];

const wordCount = (text) => words(text).length;

function normalize(input) {
  return String(input == null ? '' : input).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The distinctive terms present in a prospect's recorded evidence. A message is
 * "grounded" when it reuses at least one of these, which is a cheap and honest
 * proxy for "mentions a real observation".
 */
export function evidenceTerms(analysis) {
  const raw = typeof analysis === 'string' ? analysis : JSON.stringify(analysis || {});
  const out = new Set();
  for (const token of words(raw)) {
    if (token.length >= 4 && !STOPWORDS_SET.has(token)) out.add(token);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function maxWordsFor(mission, followUpNumber) {
  const instr = mission?.outreach_instructions;
  const configured = (instr && typeof instr === 'object' ? instr.max_words : null)
    ?? mission?.interpretation?.outreach_instructions?.max_words;
  const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_WORDS;
  return followUpNumber > 0 ? Math.min(base, FOLLOW_UP_MAX_WORDS) : base;
}

function leadName(lead) {
  return lead?.businessName || lead?.business_name || '';
}

/**
 * Assess one draft against the outreach rules.
 *
 * @returns {{ok: boolean, issues: Array<{code:string,detail:string,action:string}>, checks: object}}
 */
export function assessMessage(draft, {
  lead = {},
  analysis = null,
  mission = {},
  followUpNumber = 0,
  priorBodies = [],
} = {}) {
  const issues = [];
  const add = (code, detail, action) => issues.push({ code, detail, action });

  const subject = String(draft?.subject ?? '');
  const body = String(draft?.body ?? draft?.bodyText ?? '');
  const subjectTrim = subject.trim();
  const bodyTrim = body.trim();
  const combined = `${subject}\n${body}`;
  const combinedNorm = normalize(combined);

  if (!leadName(lead)) {
    add('MISSING_RECIPIENT', 'The message has no named recipient business.', 'Regenerate with the prospect record loaded.');
  }
  if (!subjectTrim) {
    add('MISSING_SUBJECT', 'The message has no subject line.', 'Write a specific subject line.');
  } else if (subject.length > 140) {
    add('SUBJECT_TOO_LONG', 'The subject line is longer than 140 characters.', 'Shorten the subject line.');
  }
  if (!bodyTrim) {
    add('MISSING_BODY', 'The message body is empty.', 'Write a short, specific message body.');
  } else {
    const wc = wordCount(bodyTrim);
    if (wc < MIN_WORDS) {
      add('BODY_TOO_SHORT', `The body is only ${wc} words, which is too thin to be useful.`, 'Write a fuller, specific message.');
    }
    const maxWords = maxWordsFor(mission, followUpNumber);
    if (wc > maxWords) {
      add('BODY_TOO_LONG', `The body is ${wc} words, over the ${maxWords}-word limit.`, 'Trim the message to the limits in the mission instructions.');
    }
  }

  if (PLACEHOLDER_PATTERNS.some((re) => re.test(combined))) {
    add('PLACEHOLDER', 'The message still contains an unfilled template placeholder.', 'Regenerate without placeholder tokens.');
  }
  if (SEPARATOR_PATTERN.test(body)) {
    add('BANNED_SEPARATOR', 'The message contains a decorative separator line.', 'Remove decorative separators.');
  }
  if (EMOJI_PATTERN.test(combined)) {
    add('EMOJI', 'The message contains an emoji.', 'Remove emoji from outreach.');
  }

  const filler = BANNED_FILLER.find((phrase) => combinedNorm.includes(phrase));
  if (filler) {
    add('BANNED_FILLER', `The message contains generic filler ("${filler}").`, 'Replace filler with a specific, evidence-based reason.');
  }
  if (GUARANTEE_PATTERNS.some((re) => re.test(combined))) {
    add('GUARANTEE_CLAIM', 'The message makes a guarantee or promised result.', 'Remove promises and guarantees.');
  }
  if (FALSE_OBSERVATION_PATTERNS.some((re) => re.test(combined))) {
    add('FALSE_OBSERVATION', 'The message claims a first-hand visit or test that never happened.', 'Refer only to the recorded public evidence.');
  }

  const terms = evidenceTerms(analysis);
  const bodyTokens = new Set(words(combined));
  let grounded = 0;
  for (const t of terms) if (bodyTokens.has(t)) grounded++;

  if (followUpNumber === 0 && terms.size > 0 && grounded === 0) {
    add('NO_PERSONALIZATION', 'The message does not mention any recorded evidence for this business.', 'Reference a specific observed detail from the evidence.');
  }

  // Any observation the draft claims to have referenced must be traceable to the
  // recorded evidence, so the model cannot smuggle in invented detail (spec §15).
  const refs = Array.isArray(draft?.referenced_observations) ? draft.referenced_observations : [];
  const evidenceText = normalize(typeof analysis === 'string' ? analysis : JSON.stringify(analysis || {}));
  for (const ref of refs) {
    const tokens = words(ref).filter((w) => w.length >= 4 && !STOPWORDS_SET.has(w));
    if (!tokens.length) continue;
    if (!tokens.some((t) => evidenceText.includes(t))) {
      add('UNSUPPORTED_CLAIM', `The referenced observation "${String(ref).slice(0, 80)}" is not supported by the recorded evidence.`, 'Drop the unsupported claim or cite a recorded observation.');
      break;
    }
  }

  if (Array.isArray(priorBodies) && priorBodies.length) {
    const bodySet = new Set(words(body));
    for (const prior of priorBodies) {
      const priorTokens = new Set(words(String(prior || '')));
      if (wordCount(prior) >= MIN_WORDS && jaccard(bodyTokens, priorTokens) >= 0.8) {
        add('DUPLICATE_TEMPLATE', 'This message is nearly identical to a previous message.', 'Regenerate a message specific to this prospect.');
        break;
      }
    }
  }

  const checks = {
    has_recipient: Boolean(leadName(lead)),
    has_subject: Boolean(subjectTrim),
    has_body: bodyTrim.length >= 20,
    within_length: !issues.some((i) => i.code === 'BODY_TOO_LONG' || i.code === 'BODY_TOO_SHORT' || i.code === 'SUBJECT_TOO_LONG'),
    references_evidence: followUpNumber > 0 || terms.size === 0 || grounded > 0,
    no_placeholders: !issues.some((i) => i.code === 'PLACEHOLDER'),
    no_banned_content: !issues.some((i) => ['BANNED_FILLER', 'BANNED_SEPARATOR', 'EMOJI'].includes(i.code)),
    no_false_claims: !issues.some((i) => ['GUARANTEE_CLAIM', 'FALSE_OBSERVATION'].includes(i.code)),
  };

  return { ok: issues.length === 0, issues, checks };
}

/** Human-readable feedback passed back to the model so it can regenerate. */
export function qualityFeedback(report) {
  if (!report || report.ok) return true;
  return report.issues.map((i) => `${i.code}: ${i.detail}`).join(' ');
}

/**
 * Hard gate for the send boundary. Throws a permanent, typed error when a
 * stored message fails the checks, so a retry cannot bypass validation.
 */
export function assertMessageQuality(message, ctx = {}) {
  const report = assessMessage(
    {
      subject: message?.subject,
      body: message?.body_text ?? message?.body,
      referenced_observations: message?.referenced_observations,
    },
    ctx,
  );
  if (!report.ok) {
    const summary = report.issues.map((i) => `${i.code}: ${i.detail}`).join('; ');
    throw new AppError('MESSAGE_QUALITY_REJECTED', `This message failed outreach quality checks: ${summary}`, {
      kind: ERROR_KIND.VALIDATION,
      status: 422,
      detail: { issues: report.issues, checks: report.checks },
    });
  }
  return report;
}

function parseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Send-boundary gate wired into the worker services.
 *
 * It loads the same context the checks need (the prospect, its recorded
 * evidence, its mission, and prior message bodies) and refuses to let a message
 * through when it breaks the outreach rules. Because it lives at the send
 * boundary, it applies uniformly to pipeline sends, approved manual drafts,
 * retries and queued jobs.
 */
export class MessageQualityService {
  constructor({ db, leads }) {
    this.db = db;
    this.leads = leads;
  }

  /**
   * Bodies already written for OTHER prospects in the same mission. Cross-lead
   * comparison is what the spec means by a "mass template"; a follow-up
   * naturally shares context with its own thread, so only compare across leads.
   */
  async priorBodies(missionId, leadId) {
    if (!missionId || !leadId) return [];
    const rows = await this.db.all(
      `SELECT body_text FROM outreach_messages
        WHERE mission_id = ? AND lead_id <> ? AND body_text IS NOT NULL
        ORDER BY id DESC LIMIT 50`,
      missionId, leadId,
    );
    return rows.map((r) => r.body_text);
  }

  async contextFor(message) {
    const lead = message?.lead_id ? await this.leads.get(message.lead_id) : null;
    const evidence = lead ? await this.leads.evidenceFor(lead.id) : null;
    const mission = message?.mission_id
      ? await this.db.get('SELECT * FROM missions WHERE id = ?', message.mission_id)
      : null;
    const priorBodies = await this.priorBodies(message?.mission_id, message?.lead_id);
    return {
      lead: evidence?.lead || { businessName: lead?.business_name || null },
      analysis: evidence ? { website: evidence.website, presence: evidence.presence } : null,
      mission: mission || {},
      followUpNumber: message?.kind === 'follow_up' ? 1 : 0,
      priorBodies,
    };
  }

  /** Assess without throwing (used for review surfaces). */
  async assess(message) {
    return assessMessage(
      {
        subject: message?.subject,
        body: message?.body_text ?? message?.body,
        referenced_observations: message?.referenced_observations,
      },
      await this.contextFor(message),
    );
  }

  /** Throws MESSAGE_QUALITY_REJECTED when the message must not be sent. */
  async assertSendable(message) {
    const ctx = await this.contextFor(message);
    return assertMessageQuality(message, ctx);
  }
}

export default {
  assessMessage, assertMessageQuality, evidenceTerms, qualityFeedback,
  MessageQualityService, RECOMMENDED_SERVICES,
};
