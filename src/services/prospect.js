import { err } from '../core/errors.js';

/**
 * Per-prospect workspace actions (spec §21).
 *
 * These are the user-initiated AI operations that sit alongside the automated
 * pipeline: asking a grounded question about one business, drafting a message
 * for manual review, and re-running evidence collection. Each enforces
 * ownership through LeadService before touching any record.
 */
export class ProspectService {
  constructor({ db, leads, conversations, ai, emailStore, queue }) {
    this.db = db;
    this.leads = leads;
    this.conversations = conversations;
    this.ai = ai;
    this.emailStore = emailStore;
    this.queue = queue;
  }

  /** §21 — answer a question about one prospect from its recorded evidence only. */
  async ask(userId, leadId, question) {
    const text = String(question || '').trim();
    if (text.length < 3) throw err.validation('Ask a question about this prospect.');
    if (text.length > 2000) throw err.validation('That question is too long.');

    const lead = await this.leads.getForUser(leadId, userId);
    const evidence = await this.leads.evidenceFor(lead.id);
    return this.ai.askProspect(userId, {
      lead: evidence.lead,
      analysis: {
        website: evidence.website,
        presence: evidence.presence,
        qualification: evidence.qualification,
      },
      question: text,
    });
  }

  /**
   * §15/§21 — draft a message for one prospect on demand.
   *
   * The draft is stored as an ordinary message in `draft` status, so it flows
   * through the same review/approve path as pipeline-generated outreach and is
   * never sent without approval.
   */
  async draft(userId, leadId, { followUpNumber = 0, senderName = null } = {}) {
    const lead = await this.leads.getForUser(leadId, userId);
    const connection = await this.emailStore.activeFor(userId);
    if (!connection) {
      throw err.email('MAILBOX_NOT_CONNECTED', 'Connect an authorized mailbox before drafting outreach.');
    }
    const mission = await this.db.get('SELECT * FROM missions WHERE id = ?', lead.mission_id);
    if (!mission) throw err.notFound('Mission');

    const evidence = await this.leads.evidenceFor(lead.id);
    const draft = await this.ai.writeOutreach(userId, {
      lead: evidence.lead,
      analysis: { website: evidence.website, presence: evidence.presence },
      mission: {
        service: mission.service,
        offer_summary: mission.offer_summary,
        outreach_instructions: mission.outreach_instructions,
        target_description: mission.target_description,
      },
      senderName: senderName || 'Nexora Outreach',
      senderEmail: connection.account_email || 'outreach',
      followUpNumber: Number(followUpNumber) || 0,
    });

    const conversation = await this.conversations.ensure(lead.id, mission.id, userId);
    const kind = Number(followUpNumber) > 0 ? 'follow_up' : 'initial';
    const { message } = await this.conversations.createMessage({
      conversationId: conversation.id,
      leadId: lead.id,
      missionId: mission.id,
      kind,
      subject: draft.subject,
      bodyText: draft.body,
      model: draft.model,
      // A manual draft is always a fresh artefact, so the key is unique per
      // request rather than derived from the lead.
      idempotencyKey: `manual:${mission.id}:${lead.id}:${kind}:${Date.now()}`,
    });
    return { message, lead: this.leads.toPublic(lead), referenced: draft.referenced_observations || [] };
  }

  /** §12/§13 — collect fresh evidence for one prospect again. */
  async refresh(userId, leadId) {
    const lead = await this.leads.getForUser(leadId, userId);
    const { job, created } = await this.queue.enqueue({
      userId,
      missionId: lead.mission_id,
      stage: 'research',
      payload: { leadId: lead.id },
      idempotencyKey: `research:manual:${lead.id}:${Date.now()}`,
    });
    return { job, created, lead: this.leads.toPublic(lead) };
  }
}

export default ProspectService;
