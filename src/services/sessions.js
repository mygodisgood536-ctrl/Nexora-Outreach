import { randomToken, sha256 } from '../core/crypto.js';
import { sqliteUtc } from '../core/time.js';

/**
 * Session store. Tokens are random and only ever returned to the client once;
 * the database holds a SHA-256 hash of each token (spec §5.3 secure sessions
 * with expiration and revocation).
 */
export class SessionStore {
  constructor({ db, sessionTtlHours = 72 } = {}) {
    this.db = db;
    this.sessionTtlMs = sessionTtlHours * 3600 * 1000;
  }

  create(userId, { ip = null, userAgent = null } = {}) {
    const raw = randomToken(32);
    const expiresAt = sqliteUtc(new Date(Date.now() + this.sessionTtlMs));
    this.db.run(
      `INSERT INTO sessions(id, user_id, expires_at, last_seen_at, user_agent, ip)
       VALUES(?,?,?,datetime('now'),?,?)`,
      sha256(raw), userId, expiresAt, userAgent, ip
    );
    return { token: raw, expiresAt };
  }

  static toMillis(sqliteUtcValue) {
    if (!sqliteUtcValue) return 0;
    return new Date(`${String(sqliteUtcValue).replace(' ', 'T')}Z`).getTime();
  }

  /** Returns the session row when the token is valid, unexpired and unrevoked. */
  findValid(token) {
    if (!token) return null;
    const row = this.db.get('SELECT * FROM sessions WHERE id = ?', sha256(token));
    if (!row) return null;
    if (row.revoked_at) return null;
    if (SessionStore.toMillis(row.expires_at) <= Date.now()) return null;
    return row;
  }

  touch(id) {
    this.db.run("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?", id);
  }

  revoke(token) {
    return this.db.run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
      sha256(token)
    ).changes > 0;
  }

  revokeAll(userId) {
    return this.db.run(
      "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      userId
    ).changes;
  }

  listActive(userId) {
    return this.db.all(
      `SELECT id, created_at, expires_at, last_seen_at, user_agent, ip
         FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      userId
    );
  }

  purgeExpired() {
    return this.db.run(
      'DELETE FROM sessions WHERE expires_at < ?', sqliteUtc(new Date(Date.now() - 7 * 86400000))
    ).changes;
  }
}

export default SessionStore;