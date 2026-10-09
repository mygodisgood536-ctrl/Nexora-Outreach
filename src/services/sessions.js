import { randomToken, sha256 } from '../core/crypto.js';
import { sqliteUtc } from '../core/time.js';

/**
 * Session store. Tokens are random and only ever returned to the client once;
 * the database holds a SHA-256 hash of each token (spec §5.3 secure sessions
 * with expiration and revocation).
 *
 * All methods are async: they sit on top of the asynchronous database layer.
 */
export class SessionStore {
  constructor({ db, sessionTtlHours = 72 } = {}) {
    this.db = db;
    this.sessionTtlMs = sessionTtlHours * 3600 * 1000;
  }

  async create(userId, { ip = null, userAgent = null } = {}) {
    const raw = randomToken(32);
    const expiresAt = sqliteUtc(new Date(Date.now() + this.sessionTtlMs));
    await this.db.run(
      `INSERT INTO sessions(id, user_id, expires_at, last_seen_at, user_agent, ip)
       VALUES(?,?,?,datetime('now'),?,?)`,
      sha256(raw), userId, expiresAt, userAgent, ip,
    );
    return { token: raw, expiresAt };
  }

  static toMillis(sqliteUtcValue) {
    if (!sqliteUtcValue) return 0;
    return new Date(`${String(sqliteUtcValue).replace(' ', 'T')}Z`).getTime();
  }

  /** Returns the session row when the token is valid, unexpired and unrevoked. */
  async findValid(token) {
    if (!token) return null;
    const row = await this.db.get('SELECT * FROM sessions WHERE id = ?', sha256(token));
    if (!row) return null;
    if (row.revoked_at) return null;
    if (SessionStore.toMillis(row.expires_at) <= Date.now()) return null;
    return row;
  }

  async touch(id) {
    await this.db.run("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?", id);
  }

  async revoke(token) {
    const r = await this.db.run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
      sha256(token),
    );
    return r.changes > 0;
  }

  async revokeAll(userId) {
    const r = await this.db.run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      userId,
    );
    return r.changes;
  }

  /** Revoke a single session by its stored id (owner checked by the caller). */
  async revokeById(sessionId) {
    const r = await this.db.run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
      sessionId,
    );
    return r.changes > 0;
  }

  async listActive(userId) {
    return this.db.all(
      `SELECT id, created_at, expires_at, last_seen_at, user_agent, ip
         FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      userId,
    );
  }

  /** Housekeeping: drop sessions that expired more than a week ago. */
  async purgeExpired() {
    const r = await this.db.run(
      'DELETE FROM sessions WHERE expires_at < ?',
      sqliteUtc(new Date(Date.now() - 7 * 86400000)),
    );
    return r.changes;
  }
}

export default SessionStore;
