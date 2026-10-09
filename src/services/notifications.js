import { nowSqlite } from '../core/time.js';

export const NOTIFICATION_KIND = {
  REPLY: 'reply',
  MAILBOX_EXPIRED: 'mailbox_expired',
  SENDING_PAUSED: 'sending_paused',
  HIGH_PRIORITY_LEAD: 'high_priority_lead',
  FOLLOW_UP_DUE: 'follow_up_due',
  AI_ERROR: 'ai_error',
  JOB_FAILED: 'job_failed',
};

const SEVERITY = { info: 'info', warning: 'warning', critical: 'critical' };

export class NotificationService {
  constructor({ db }) { this.db = db; }

  async create(userId, { kind, title, body = null, severity = 'info', missionId = null, leadId = null }) {
    if (!Object.values(NOTIFICATION_KIND).includes(kind)) {
      throw new Error(`Unknown notification kind: ${kind}`);
    }
    const existing = await this.db.get(
      `SELECT id FROM notifications
        WHERE user_id = ? AND kind = ? AND read_at IS NULL
          AND (lead_id IS ? OR lead_id = ?)
        LIMIT 1`,
      userId, kind, leadId, leadId
    );
    if (existing) return { id: existing.id, created: false };

    const result = await this.db.run(
      `INSERT INTO notifications(user_id, kind, severity, title, body, mission_id, lead_id)
       VALUES(?,?,?,?,?,?,?)`,
      userId, kind, SEVERITY[severity] || 'info', title, body, missionId, leadId
    );
    const id = result.lastInsertRowid;
    return { id, created: true };
  }

  async list(userId, { unreadOnly = false, limit = 50 } = {}) {
    const where = unreadOnly ? 'AND read_at IS NULL' : '';
    return this.db.all(
      `SELECT * FROM notifications WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ?`,
      userId, limit
    );
  }

  async unreadCount(userId) {
    const row = await this.db.get(
      'SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId
    );
    return row.n;
  }

  async markRead(userId, id) {
    const res = await this.db.run(
      "UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL",
      nowSqlite(), userId, id
    );
    return res.changes > 0;
  }

  async markAllRead(userId) {
    const res = await this.db.run(
      "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
      nowSqlite(), userId
    );
    return res.changes;
  }

  toPublic(row) {
    return {
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      missionId: row.mission_id,
      leadId: row.lead_id,
      read: Boolean(row.read_at),
      createdAt: row.created_at,
    };
  }

  async listForUser(userId, { unreadOnly, limit }) {
    const items = await this.list(userId, { unreadOnly, limit });
    const unread = await this.unreadCount(userId);
    return { items: items.map((r) => this.toPublic(r)), unread };
  }
}

export default NotificationService;
