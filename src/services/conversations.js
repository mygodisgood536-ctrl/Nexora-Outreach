import { err } from '../core/errors.js';
import { normalizeEmail, normalizeDomain } from '../core/normalize.js';
import { addDays, nowSqlite, sqliteUtc } from '../core/time.js';
import { recordAudit } from './audit.js';

export const CONVERSATION_STATUS = [
  'sent', 'delivered', 'opened', 'no_reply', 'reply_received',
  'follow_up_scheduled', 'follow_up_sent', 'suppressed', 'closed',
];

export class ConversationService {
  constructor({ db, suppression, config }) {
    this.db = db;
    this.suppression = suppression;
    this.config = config;
  }

  async getFor(leadId, missionId) {
    return this.db.get(
      'SELECT * FROM conversations WHERE lead_id = ? AND mission_id = ?', leadId, missionId
    );
  }

  async ensure(leadId, missionId, userId) {
    const existing = await this.getFor(leadId, missionId);
    if (existing) return existing;
    const result = await this.db.run(
      'INSERT INTO conversations(lead_id, mission_id, user_id, status) VALUES(?,?,?,?) RETURNING id',
      leadId, missionId, userId, 'sent'
    );
    const id = result.lastInsertRowid;
    return this.getById(id);
  }

  async getById(id) { return this.db.get('SELECT * FROM conversations WHERE id = ?', id); }

  async setStatus(conversationId, status) {
    if (!CONVERSATION_STATUS.includes(status)) throw err.validation(`Unknown conversation status: ${status}`);
    await this.db.run(
      "UPDATE conversations SET status = ?, updated_at = datetime('now') WHERE id = ?",
      status, conversationId
    );
    return this.getById(conversationId);
  }

  async assertNotSuppressed(userId, lead, conversationId = null) {
    const email = normalizeEmail(lead.email_public);
    if (!email) {
      throw err.email('NO_CONTACT_ROUTE', `${lead.business_name} has no public email address to contact.`);
    }
    const blocked = await this.suppression.isSuppressed(userId, {
      email,
      domain: normalizeDomain(lead.domain || lead.website_url),
      conversationId,
    });
    if (blocked) {
      throw err.suppressed(`${lead.business_name} is suppressed (${blocked.scope}).`);
    }
    return email;
  }

  async assertSendable(userId, missionId, lead, conversationId = null) {
    const email = await this.assertNotSuppressed(userId, lead, conversationId);
    await this.assertWithinDailyLimit(userId, missionId);
    return email;
  }

  todayKey(tz = 'UTC') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  }

  async sentToday(userId, missionId, tz = 'UTC') {
    const row = await this.db.get(
      'SELECT count FROM send_log WHERE user_id = ? AND mission_id = ? AND sent_on = ?',
      userId, missionId, this.todayKey(tz)
    );
    return row?.count || 0;
  }

  async assertWithinDailyLimit(userId, missionId, tz = 'UTC') {
    const mission = await this.db.get('SELECT daily_send_limit, timezone FROM missions WHERE id = ?', missionId);
    const missionLimit = mission?.daily_send_limit ?? 20;
    const used = await this.sentToday(userId, missionId, mission?.timezone || tz);
    const globalLimit = this.config?.limits?.globalMaxSendsPerDay ?? 50;
    if (used >= missionLimit) {
      throw err.email('DAILY_LIMIT_REACHED', `This mission's daily limit of ${missionLimit} message(s) is reached.`);
    }
    if (used >= globalLimit) {
      throw err.email('DAILY_LIMIT_REACHED', `The daily sending limit of ${globalLimit} message(s) is reached.`);
    }
  }

  async recordSend(userId, missionId, tz = 'UTC') {
    await this.db.run(
      `INSERT INTO send_log(user_id, mission_id, sent_on, count) VALUES(?,?,?,1)
       ON CONFLICT(user_id, mission_id, sent_on) DO UPDATE SET count = count + 1`,
      userId, missionId, this.todayKey(tz)
    );
  }

  async createMessage({ conversationId, leadId, missionId, kind = 'initial', subject, bodyText, model = null, idempotencyKey }) {
    const existing = await this.db.get('SELECT * FROM outreach_messages WHERE idempotency_key = ?', idempotencyKey);
    if (existing) return { message: existing, created: false };
    const result = await this.db.run(
      `INSERT INTO outreach_messages(conversation_id, lead_id, mission_id, kind, subject,
                                     body_text, model, send_status, idempotency_key)
       VALUES(?,?,?,?,?,?,?, 'draft', ?) RETURNING id`,
      conversationId, leadId, missionId, kind, subject, bodyText, model, idempotencyKey
    );
    const id = result.lastInsertRowid;
    return { message: await this.message(id), created: true };
  }

  async message(id) { return this.db.get('SELECT * FROM outreach_messages WHERE id = ?', id); }

  async markApproved(messageId) {
    await this.db.run(
      "UPDATE outreach_messages SET approved = 1, approved_at = datetime('now') WHERE id = ?",
      messageId
    );
    return this.message(messageId);
  }

  async approveMessage(userId, messageId) {
    const message = await this.message(messageId);
    if (!message) throw err.notFound('Message');
    const conversation = await this.getById(message.conversation_id);
    if (!conversation || conversation.user_id !== userId) {
      throw err.notFound('Message');
    }
    if (message.send_status === 'sent') {
      throw err.conflict('This message has already been sent.', 'ALREADY_SENT');
    }
    if (message.send_status === 'rejected') {
      throw err.conflict('This message was rejected and cannot be approved.', 'ALREADY_REJECTED');
    }
    if (!message.approved) {
      await this.db.run(
        "UPDATE outreach_messages SET approved = 1, approved_at = datetime('now') WHERE id = ?",
        messageId
      );
    }
    return this.message(messageId);
  }

  async markRejected(messageId, reason = null) {
    const message = await this.message(messageId);
    if (!message) throw err.notFound('Message');
    if (message.send_status === 'sent') {
      throw err.conflict('That message has already been sent and cannot be rejected.', 'MESSAGE_ALREADY_SENT');
    }
    await this.db.run(
      "UPDATE outreach_messages SET send_status = 'rejected', error = ? WHERE id = ?",
      reason ? String(reason).slice(0, 1000) : null, messageId
    );
    return this.message(messageId);
  }

  async followUpsFor(conversationId) {
    return this.db.all(
      'SELECT * FROM follow_ups WHERE conversation_id = ? ORDER BY sequence ASC, id ASC',
      conversationId
    );
  }

  async suppressionStatusFor(userId, lead, conversationId = null) {
    const blocked = await this.suppression.isSuppressed(userId, {
      email: lead.email_public,
      domain: lead.domain || lead.website_url,
      conversationId,
    });
    if (!blocked) return { suppressed: false, scope: null, reason: null, source: null };
    return {
      suppressed: true, scope: blocked.scope, reason: blocked.reason, source: blocked.source,
    };
  }

  async markSent(messageId, { provider, providerMessageId, idempotencyKey = null }) {
    await this.db.run(
      `UPDATE outreach_messages
          SET send_status = 'sent', provider = ?, provider_message_id = ?, sent_at = datetime('now'),
              idempotency_key = COALESCE(?, idempotency_key), error = NULL
        WHERE id = ?`,
      provider, providerMessageId, idempotencyKey, messageId
    );
    return this.message(messageId);
  }

  async markFailed(messageId, error) {
    await this.db.run(
      "UPDATE outreach_messages SET send_status = 'failed', error = ? WHERE id = ?",
      String(error).slice(0, 1000), messageId
    );
    return this.message(messageId);
  }

  async messagesFor(conversationId) {
    return this.db.all(
      'SELECT * FROM outreach_messages WHERE conversation_id = ? ORDER BY id ASC', conversationId
    );
  }

  async scheduleFollowUp({ conversationId, leadId, missionId, mission }) {
    const existing = await this.db.get(
      "SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending'", conversationId
    );
    if (existing) return { followUp: existing, created: false };

    if (mission.max_follow_ups <= 0) return null;
    const conversation = await this.getById(conversationId);
    if (conversation.followups_sent >= mission.max_follow_ups) return null;

    const sequence = conversation.followups_sent + 1;
    const dueAt = sqliteUtc(addDays(new Date(), mission.follow_up_delay_days));
    const result = await this.db.run(
      `INSERT INTO follow_ups(conversation_id, lead_id, mission_id, sequence, due_at, status)
       VALUES(?,?,?,?,?,'pending') RETURNING id`,
      conversationId, leadId, missionId, sequence, dueAt
    );
    const id = result.lastInsertRowid;
    await this.setStatus(conversationId, 'follow_up_scheduled');
    return { followUp: await this.followUp(id), created: true };
  }

  async followUp(id) { return this.db.get('SELECT * FROM follow_ups WHERE id = ?', id); }

  async dueFollowUps(userId, now = new Date()) {
    return this.db.all(
      `SELECT f.* FROM follow_ups f
         JOIN missions m ON m.id = f.mission_id
        WHERE f.status = 'pending' AND f.due_at <= ? AND m.status = 'scheduled'
        ORDER BY f.due_at ASC`,
      sqliteUtc(now)
    );
  }

  async cancelFollowUps(conversationId, reason) {
    const result = await this.db.run(
      `UPDATE follow_ups SET status = 'cancelled', reason_cancelled = ?
        WHERE conversation_id = ? AND status = 'pending'`,
      reason, conversationId
    );
    return result.changes;
  }

  async recordReply(conversationId, { providerMessageId = null, threadKey = null } = {}) {
    const conversation = await this.getById(conversationId);
    const cancelled = await this.cancelFollowUps(conversationId, 'prospect replied');
    await this.db.run(
      `UPDATE conversations
          SET status = 'reply_received', reply_count = reply_count + 1,
              last_inbound_at = datetime('now'), remote_message_id = COALESCE(?, remote_message_id),
              thread_key = COALESCE(?, thread_key), updated_at = datetime('now')
        WHERE id = ?`,
      providerMessageId, threadKey, conversationId
    );
    await recordAudit(this.db, {
      userId: conversation.user_id, actor: 'system', action: 'conversation.reply_received',
      entityType: 'conversation', entityId: conversationId, detail: { cancelledFollowUps: cancelled },
    });
    return { conversation: await this.getById(conversationId), cancelledFollowUps: cancelled };
  }

  async recordOptOut(conversationId, email) {
    const conversation = await this.getById(conversationId);
    await this.suppression.addEmail(conversation.user_id, email, 'opted out', 'opt_out');
    await this.cancelFollowUps(conversationId, 'recipient opted out');
    await this.setStatus(conversationId, 'suppressed');
    return this.getById(conversationId);
  }

  async listForUser(userId, { status = null, limit = 50 } = {}) {
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
