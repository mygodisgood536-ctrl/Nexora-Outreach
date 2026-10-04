import { err } from '../core/errors.js';
import { normalizeEmail, normalizeDomain } from '../core/normalize.js';
import { addDays, nowSqlite, sqliteUtc } from '../core/time.js';
import { recordAudit } from './audit.js';

export const CONVERSATION_STATUS = [
  'sent', 'delivered', 'opened', 'no_reply', 'reply_received',
  'follow_up_scheduled', 'follow_up_sent', 'suppressed', 'closed',
];

/**
 * Conversation and message lifecycle (§15, §17–19).
 *
 * This service owns the rules that make sending safe:
 *  - suppression is checked before anything is sent;
 *  - every message carries an idempotency key so a retry after an uncertain
 *    outcome cannot send twice (§30);
 *  - per-user and per-mission daily limits are enforced (§17);
 *  - a reply or opt-out cancels every pending follow-up (§18, §19).
 */
export class ConversationService {
  constructor({ db, suppression, config }) {
    this.db = db;
    this.suppression = suppression;
    this.config = config;
  }

  getFor(leadId, missionId) {
    return this.db.get(
      'SELECT * FROM conversations WHERE lead_id = ? AND mission_id = ?', leadId, missionId
    );
  }

  ensure(leadId, missionId, userId) {
    const existing = this.getFor(leadId, missionId);
    if (existing) return existing;
    const id = this.db.run(
      'INSERT INTO conversations(lead_id, mission_id, user_id, status) VALUES(?,?,?,?)',
      leadId, missionId, userId, 'sent'
    ).lastInsertRowid;
    return this.getById(id);
  }

  getById(id) { return this.db.get('SELECT * FROM conversations WHERE id = ?', id); }

  setStatus(conversationId, status) {
    if (!CONVERSATION_STATUS.includes(status)) throw err.validation(`Unknown conversation status: ${status}`);
    this.db.run(
      "UPDATE conversations SET status = ?, updated_at = datetime('now') WHERE id = ?",
      status, conversationId
    );
    return this.getById(conversationId);
  }

  /**
   * Suppression check only. Runs before the approval gate so an opted-out,
   * bounced or complained-about recipient is never even presented for
   * approval (spec §17, §29).
   */
  assertNotSuppressed(userId, lead, conversationId = null) {
    const email = normalizeEmail(lead.email_public);
    if (!email) {
      throw err.email('NO_CONTACT_ROUTE', `${lead.business_name} has no public email address to contact.`);
    }
    const blocked = this.suppression.isSuppressed(userId, {
      email,
      domain: normalizeDomain(lead.domain || lead.website_url),
      conversationId,
    });
    if (blocked) {
      throw err.suppressed(`${lead.business_name} is suppressed (${blocked.scope}).`);
    }
    return email;
  }

  /**
   * The single gate every send passes through. Throws rather than returning a
   * flag so a caller cannot accidentally ignore it.
   */
  assertSendable(userId, missionId, lead, conversationId = null) {
    const email = this.assertNotSuppressed(userId, lead, conversationId);
    this.assertWithinDailyLimit(userId, missionId);
    return email;
  }

  todayKey(tz = 'UTC') {
    // Local calendar day in the mission timezone, so limits reset at the
    // user's midnight rather than the server's.
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  }

  sentToday(userId, missionId, tz = 'UTC') {
    const row = this.db.get(
      'SELECT count FROM send_log WHERE user_id = ? AND mission_id = ? AND sent_on = ?',
      userId, missionId, this.todayKey(tz)
    );
    return row?.count || 0;
  }

  assertWithinDailyLimit(userId, missionId, tz = 'UTC') {
    const mission = this.db.get('SELECT daily_send_limit, timezone FROM missions WHERE id = ?', missionId);
    const missionLimit = mission?.daily_send_limit ?? 20;
    const used = this.sentToday(userId, missionId, mission?.timezone || tz);
    const globalLimit = this.config?.limits?.globalMaxSendsPerDay ?? 50;
    if (used >= missionLimit) {
      throw err.email('DAILY_LIMIT_REACHED', `This mission's daily limit of ${missionLimit} message(s) is reached.`);
    }
    if (used >= globalLimit) {
      throw err.email('DAILY_LIMIT_REACHED', `The daily sending limit of ${globalLimit} message(s) is reached.`);
    }
  }

  recordSend(userId, missionId, tz = 'UTC') {
    this.db.run(
      `INSERT INTO send_log(user_id, mission_id, sent_on, count) VALUES(?,?,?,1)
       ON CONFLICT(user_id, mission_id, sent_on) DO UPDATE SET count = count + 1`,
      userId, missionId, this.todayKey(tz)
    );
  }
/**
 * Store a generated message. `idempotencyKey` is unique, so replaying a stage
 * after a crash returns the original row instead of creating a second message
 * that could later be sent twice.
 */
  createMessage({ conversationId, leadId, missionId, kind = 'initial', subject, bodyText, model = null, idempotencyKey }) {
    const existing = this.db.get('SELECT * FROM outreach_messages WHERE idempotency_key = ?', idempotencyKey);
    if (existing) return { message: existing, created: false };
    const id = this.db.run(
      `INSERT INTO outreach_messages(conversation_id, lead_id, mission_id, kind, subject,
                                     body_text, model, send_status, idempotency_key)
       VALUES(?,?,?,?,?,?,?, 'draft', ?)`,
      conversationId, leadId, missionId, kind, subject, bodyText, model, idempotencyKey
    ).lastInsertRowid;
    return { message: this.message(id), created: true };
  }

  message(id) { return this.db.get('SELECT * FROM outreach_messages WHERE id = ?', id); }

  markApproved(messageId) {
    this.db.run(
      "UPDATE outreach_messages SET approved = 1, approved_at = datetime('now') WHERE id = ?",
      messageId
    );
    return this.message(messageId);
  }

  /**
   * Decline a drafted message (spec §21 user actions, §27 Review & Send).
   *
   * Without this, a draft the user disagrees with is indistinguishable from one
   * still awaiting review. A message that has already gone out cannot be
   * rejected after the fact, so that case is refused rather than silently
   * rewriting history.
   */
  markRejected(messageId, reason = null) {
    const message = this.message(messageId);
    if (!message) throw err.notFound('Message');
    if (message.send_status === 'sent') {
      throw err.conflict('That message has already been sent and cannot be rejected.', 'MESSAGE_ALREADY_SENT');
    }
    this.db.run(
      "UPDATE outreach_messages SET send_status = 'rejected', error = ? WHERE id = ?",
      reason ? String(reason).slice(0, 1000) : null, messageId
    );
    return this.message(messageId);
  }

  /** Follow-up schedule for one conversation (spec §19, §21). */
  followUpsFor(conversationId) {
    return this.db.all(
      'SELECT * FROM follow_ups WHERE conversation_id = ? ORDER BY sequence ASC, id ASC',
      conversationId
    );
  }

  /**
   * Non-throwing view of whether this lead may still be contacted
   * (spec §21 "suppression status"). `assertNotSuppressed` is the send gate;
   * this only reports, so a UI can explain why nothing was sent.
   */
  suppressionStatusFor(userId, lead, conversationId = null) {
    const blocked = this.suppression.isSuppressed(userId, {
      email: lead.email_public,
      domain: lead.domain || lead.website_url,
      conversationId,
    });
    if (!blocked) return { suppressed: false, scope: null, reason: null, source: null };
    return {
      suppressed: true, scope: blocked.scope, reason: blocked.reason, source: blocked.source,
    };
  }

  markSent(messageId, { provider, providerMessageId, idempotencyKey = null }) {
    this.db.run(
      `UPDATE outreach_messages
          SET send_status = 'sent', provider = ?, provider_message_id = ?, sent_at = datetime('now'),
              idempotency_key = COALESCE(?, idempotency_key), error = NULL
        WHERE id = ?`,
      provider, providerMessageId, idempotencyKey, messageId
    );
    return this.message(messageId);
  }

  markFailed(messageId, error) {
    this.db.run(
      "UPDATE outreach_messages SET send_status = 'failed', error = ? WHERE id = ?",
      String(error).slice(0, 1000), messageId
    );
    return this.message(messageId);
  }

  messagesFor(conversationId) {
    return this.db.all(
      'SELECT * FROM outreach_messages WHERE conversation_id = ? ORDER BY id ASC', conversationId
    );
  }

  // ── Follow-ups (§19) ─────────────────────────────────────────────

  /**
   * Schedule the next follow-up only when the mission allows it. Returns null
   * when the policy forbids it rather than creating a doomed row.
   */
  scheduleFollowUp({ conversationId, leadId, missionId, mission }) {
    const existing = this.db.get(
      "SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending'", conversationId
    );
    if (existing) return { followUp: existing, created: false };

    if (mission.max_follow_ups <= 0) return null;
    const conversation = this.getById(conversationId);
    if (conversation.followups_sent >= mission.max_follow_ups) return null;

    const sequence = conversation.followups_sent + 1;
    const dueAt = sqliteUtc(addDays(new Date(), mission.follow_up_delay_days));
    const id = this.db.run(
      `INSERT INTO follow_ups(conversation_id, lead_id, mission_id, sequence, due_at, status)
       VALUES(?,?,?,?,?,'pending')`,
      conversationId, leadId, missionId, sequence, dueAt
    ).lastInsertRowid;
    this.setStatus(conversationId, 'follow_up_scheduled');
    return { followUp: this.followUp(id), created: true };
  }

  followUp(id) { return this.db.get('SELECT * FROM follow_ups WHERE id = ?', id); }

  dueFollowUps(userId, now = new Date()) {
    return this.db.all(
      `SELECT f.* FROM follow_ups f
         JOIN missions m ON m.id = f.mission_id
        WHERE f.status = 'pending' AND f.due_at <= ? AND m.status = 'scheduled'
        ORDER BY f.due_at ASC`,
      sqliteUtc(now)
    );
  }

  cancelFollowUps(conversationId, reason) {
    return this.db.run(
      `UPDATE follow_ups SET status = 'cancelled', reason_cancelled = ?
        WHERE conversation_id = ? AND status = 'pending'`,
      reason, conversationId
    ).changes;
  }

  /**
   * Record an inbound reply: update state, cancel automation, audit (§18).
   * Returns the updated conversation.
   */
  recordReply(conversationId, { providerMessageId = null, threadKey = null } = {}) {
    const conversation = this.getById(conversationId);
    const cancelled = this.cancelFollowUps(conversationId, 'prospect replied');
    this.db.run(
      `UPDATE conversations
          SET status = 'reply_received', reply_count = reply_count + 1,
              last_inbound_at = datetime('now'), remote_message_id = COALESCE(?, remote_message_id),
              thread_key = COALESCE(?, thread_key), updated_at = datetime('now')
        WHERE id = ?`,
      providerMessageId, threadKey, conversationId
    );
    recordAudit(this.db, {
      userId: conversation.user_id, actor: 'system', action: 'conversation.reply_received',
      entityType: 'conversation', entityId: conversationId, detail: { cancelledFollowUps: cancelled },
    });
    return { conversation: this.getById(conversationId), cancelledFollowUps: cancelled };
  }

  recordOptOut(conversationId, email) {
    const conversation = this.getById(conversationId);
    this.suppression.addEmail(conversation.user_id, email, 'opted out', 'opt_out');
    this.cancelFollowUps(conversationId, 'recipient opted out');
    this.setStatus(conversationId, 'suppressed');
    return this.getById(conversationId);
  }

  listForUser(userId, { status = null, limit = 50 } = {}) {
    if (status) {
      return this.db.all(
        'SELECT * FROM conversations WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT ?',
        userId, status, limit
      );
    }
    return this.db.all('SELECT * FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit);
  }
}

export default ConversationService;