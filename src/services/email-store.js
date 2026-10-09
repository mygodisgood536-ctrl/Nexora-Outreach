import { encrypt, decrypt } from '../core/crypto.js';
import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { nowSqlite } from '../core/time.js';
import { recordAudit } from './audit.js';

const log = createLogger('email.store');

export const CONNECTION_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTED: 'connected',
  EXPIRED: 'expired',
  ERROR: 'error',
};

export class EmailConnectionStore {
  constructor({ db }) { this.db = db; }

  async raw(userId, provider) {
    return this.db.get(
      'SELECT * FROM email_connections WHERE user_id = ? AND provider = ?', userId, provider
    );
  }

  async list(userId) {
    return this.db.all('SELECT * FROM email_connections WHERE user_id = ? ORDER BY provider', userId);
  }

  toPublic(row) {
    if (!row) {
      return { provider: null, status: CONNECTION_STATUS.DISCONNECTED, accountEmail: null };
    }
    return {
      provider: row.provider,
      status: row.status,
      accountEmail: row.account_email,
      statusDetail: row.status_detail,
      expiresAt: row.token_expires_at,
      connectedAt: row.updated_at,
    };
  }

  async save(userId, provider, { accessToken, refreshToken = null, scopes = [], expiresAt = null, accountEmail = null, ip = null }) {
    if (!accessToken) throw err.email('MAILBOX_AUTH_FAILED', 'Authorization did not return an access token.');
    const now = nowSqlite();
    await this.db.run(
      `INSERT INTO email_connections
         (user_id, provider, account_email, access_token_enc, refresh_token_enc,
          scopes, token_expires_at, status, status_detail, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,'connected',NULL,?,?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         account_email=excluded.account_email,
         access_token_enc=excluded.access_token_enc,
         refresh_token_enc=COALESCE(excluded.refresh_token_enc, email_connections.refresh_token_enc),
         scopes=excluded.scopes,
         token_expires_at=excluded.token_expires_at,
         status='connected', status_detail=NULL, updated_at=excluded.updated_at`,
      userId, provider, accountEmail,
      encrypt(accessToken),
      refreshToken ? encrypt(refreshToken) : null,
      JSON.stringify(scopes ?? []),
      expiresAt, now, now
    );
    await recordAudit(this.db, { userId, actor: 'user', action: 'email.connected', entityType: 'email_connection', entityId: provider, ip });
    log.info(`mailbox connected: ${provider} for user ${userId}`);
    return this.toPublic(await this.raw(userId, provider));
  }

  async tokens(userId, provider) {
    const row = await this.raw(userId, provider);
    if (!row) throw err.email('MAILBOX_NOT_CONNECTED', 'No mailbox is connected for this account.');
    let accessToken = null;
    let refreshToken = null;
    try {
      accessToken = decrypt(row.access_token_enc);
      refreshToken = decrypt(row.refresh_token_enc);
    } catch (e) {
      throw err.email('MAILBOX_TOKEN_CORRUPT', 'Stored mailbox credentials could not be decrypted.');
    }
    return {
      row, accessToken, refreshToken,
      accountEmail: row.account_email,
      scopes: row.scopes ? JSON.parse(row.scopes) : [],
      expiresAt: row.token_expires_at,
      status: row.status,
    };
  }

  isExpired(row, skewSeconds = 120) {
    if (!row?.token_expires_at) return false;
    const t = new Date(`${String(row.token_expires_at).replace(' ', 'T')}Z`).getTime();
    return Number.isFinite(t) && t - skewSeconds * 1000 <= Date.now();
  }

  async updateTokens(userId, provider, { accessToken, refreshToken = null, expiresAt = null }) {
    const sets = ["access_token_enc = ?", "status = 'connected'", "updated_at = datetime('now')"];
    const params = [encrypt(accessToken)];
    if (refreshToken) { sets.push('refresh_token_enc = ?'); params.push(encrypt(refreshToken)); }
    if (expiresAt) { sets.push('token_expires_at = ?'); params.push(expiresAt); }
    await this.db.run(
      `UPDATE email_connections SET ${sets.join(', ')} WHERE user_id = ? AND provider = ?`,
      ...params, userId, provider
    );
  }

  async markStatus(userId, provider, status, detail = null) {
    await this.db.run(
      'UPDATE email_connections SET status = ?, status_detail = ?, updated_at = datetime(\'now\') WHERE user_id = ? AND provider = ?',
      status, detail, userId, provider
    );
  }

  async disconnect(userId, provider, { ip = null } = {}) {
    const res = await this.db.run(
      `UPDATE email_connections
          SET access_token_enc = NULL, refresh_token_enc = NULL, status = 'disconnected',
              status_detail = NULL, updated_at = datetime('now')
        WHERE user_id = ? AND provider = ?`,
      userId, provider
    );
    if (res.changes > 0) {
      await recordAudit(this.db, { userId, actor: 'user', action: 'email.disconnected', entityType: 'email_connection', entityId: provider, ip });
      log.info(`mailbox disconnected: ${provider} for user ${userId}`);
    }
    return res.changes > 0;
  }

  async activeFor(userId) {
    return this.db.get(
      `SELECT * FROM email_connections
        WHERE user_id = ? AND status = 'connected'
        ORDER BY updated_at DESC LIMIT 1`,
      userId
    );
  }
}

export default EmailConnectionStore;
