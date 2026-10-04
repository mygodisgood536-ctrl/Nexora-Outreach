import { hashSecret, verifySecret, randomBytes } from '../core/crypto.js';
import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { sqliteUtc } from '../core/time.js';
import { SessionStore } from './sessions.js';
import { recordAudit } from './audit.js';
import { registerAttempt, recentFailures, lockMinutesFor } from './rate-limit.js';

const log = createLogger('auth');
export const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/**
 * Recovery-code alphabet: unambiguous characters only.
 *
 * I, L, O and U are excluded because they are easily confused with 1, 1, 0
 * and V when a code is written down and typed back. 32 symbols keeps the
 * entropy high (5 bits per character).
 */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LEN = 5;

/**
 * Mint a human-typeable recovery code, e.g. `K3P7Q-M2XB9-T4WCR-H8ZD5`.
 * Uses rejection sampling so every character is equally likely.
 */
function formatRecoveryCode() {
  const total = RECOVERY_GROUPS * RECOVERY_GROUP_LEN;
  let out = '';
  while (out.length < total) {
    for (const byte of randomBytes(total)) {
      // 248 = 31 * 8, the largest multiple of 32 that fits in a byte. Bytes at
      // or above it are discarded rather than folded, which would skew the
      // distribution towards the first symbols.
      if (byte >= RECOVERY_ALPHABET.length * 8) continue;
      out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      if (out.length === total) break;
    }
  }
  return out.match(new RegExp(`.{1,${RECOVERY_GROUP_LEN}}`, 'g')).join('-');
}

/** Progressive lockout: recent failures -> minutes locked (spec 5.3). */
const LOCKOUT_SCHEDULE = [0, 0, 0, 1, 5, 15, 60, 240];
const MAX_FAILURES = LOCKOUT_SCHEDULE.length - 1;

export class AuthService {
  constructor({ db, sessionTtlHours = 72 } = {}) {
    this.db = db;
    this.sessions = new SessionStore({ db, sessionTtlHours });
  }

  static validateUsername(username) {
    if (!username) return 'Username is required.';
    if (!USERNAME_RE.test(username)) {
      return 'Username must be 3-32 characters using letters, numbers, dot, dash or underscore.';
    }
    return null;
  }

  /** Live availability check for the sign-up form (spec 5.1). */
  isUsernameAvailable(username) {
    const problem = AuthService.validateUsername(username);
    if (problem) return { available: false, reason: problem };
    const existing = this.db.get(
      'SELECT id FROM users WHERE username_lower = ? AND deleted_at IS NULL',
      String(username).toLowerCase()
    );
    return existing
      ? { available: false, reason: 'That username is already taken.' }
      : { available: true };
  }

  /**
   * Create an account. The security answer is only ever stored as a scrypt
   * hash (spec 5.2). A recovery secret is derived so recovery never depends
   * solely on a guessable security question (spec 5.3).
   */
  signup({ fullName, username, securityQuestion, securityAnswer, timezone = 'UTC', ip = null }) {
    if (!fullName || String(fullName).trim().length < 2) throw err.validation('Full name is required.');
    const problem = AuthService.validateUsername(username);
    if (problem) throw err.validation(problem);
    if (!securityQuestion || !securityAnswer) throw err.validation('A security question and answer are required.');
    if (String(securityAnswer).trim().length < 3) throw err.validation('Security answer must be at least 3 characters.');

    const available = this.isUsernameAvailable(username);
    if (!available.available) throw err.conflict(available.reason, 'DUPLICATE_USERNAME');

    const recovery = hashSecret(`${username.toLowerCase()}:${securityAnswer.toLowerCase()}`);
    const userId = this.db.tx(() => {
      const r = this.db.run(
        `INSERT INTO users(full_name, username, username_lower, security_question,
                           recovery_code_hash, timezone, created_ms)
         VALUES(?,?,?,?,?,?,?)`,
        String(fullName).trim(), username, username.toLowerCase(), securityQuestion,
        recovery.hash_hex, timezone, Date.now()
      );
      const id = r.lastInsertRowid;
      const cred = hashSecret(securityAnswer);
      this.db.run(
        `INSERT INTO security_credentials(user_id, algo, salt_hex, hash_hex, params) VALUES(?,?,?,?,?)`,
        id, cred.algo, cred.salt_hex, cred.hash_hex, cred.params
      );
      return id;
    });

    recordAudit(this.db, { userId, actor: 'user', action: 'account.created', entityType: 'user', entityId: userId, detail: { username }, ip });
    // Recovery is issued at creation and shown exactly once — it is never
    // emailed or re-displayable, and never stored in the clear.
    const recoveryCode = this.issueRecoveryCode(userId);
    log.info(`account created: ${username}`);
    return { userId, username, recoveryCode };
  }

  /**
   * Mint a fresh one-time recovery code (spec 5.3).
   *
   * Returns the plaintext code for display; only a scrypt hash is stored, with
   * a fresh salt per code so codes cannot be compared with each other.
   */
  issueRecoveryCode(userId) {
    const code = formatRecoveryCode();
    const cred = hashSecret(code);
    this.db.run(
      `INSERT INTO recovery_codes(user_id, code_hash, algo, salt_hex, params) VALUES(?,?,?,?,?)`,
      userId, cred.hash_hex, cred.algo, cred.salt_hex, cred.params
    );
    return code;
  }

  /**
   * Redeem a recovery code and take over the account (spec 5.3).
   *
   * Sets a new security answer, burns every existing session so a thief who
   * had a session loses access, and returns a new session for the caller.
   * The redeemed code is marked used, so a captured code cannot be reused.
   */
  recover({ username, recoveryCode, newSecurityAnswer, newSecurityQuestion = null, ip = null, userAgent = null }) {
    const key = String(username || '').toLowerCase();
    if (!newSecurityAnswer || String(newSecurityAnswer).trim().length < 3) {
      throw err.validation('The new security answer must be at least 3 characters.');
    }
    if (!recoveryCode) throw err.validation('A recovery code is required.');

    const user = this.db.get('SELECT * FROM users WHERE username_lower = ? AND deleted_at IS NULL', key);
    // The same message for an unknown user, a wrong code or an empty code, so
    // this endpoint cannot be used to discover which usernames exist.
    const reject = () => err.unauthorized('That recovery code is not valid.');
    if (!user) throw reject();

    const candidates = this.db.all(
      'SELECT * FROM recovery_codes WHERE user_id = ? AND used_at IS NULL ORDER BY id DESC',
      user.id
    );
    const match = candidates.find((row) => verifySecret(recoveryCode, {
      salt_hex: row.salt_hex, hash_hex: row.code_hash, params: row.params,
    }));
    if (!match) throw reject();

    this.db.tx(() => {
      // Burn every code: recovery is a one-time takeover.
      this.db.run(
        "UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
        user.id
      );
      const cred = hashSecret(newSecurityAnswer);
      this.db.run(
        `UPDATE security_credentials
            SET algo = ?, salt_hex = ?, hash_hex = ?, params = ?, updated_at = datetime('now')
          WHERE user_id = ?`,
        cred.algo, cred.salt_hex, cred.hash_hex, cred.params, user.id
      );
      if (newSecurityQuestion) {
        this.db.run('UPDATE users SET security_question = ? WHERE id = ?', newSecurityQuestion, user.id);
      }
      // A stolen session must not survive an account takeover.
      this.db.run(
        'UPDATE sessions SET revoked_at = datetime(\'now\') WHERE user_id = ? AND revoked_at IS NULL',
        user.id
      );
      this.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id);
    });

    recordAudit(this.db, { userId: user.id, actor: 'user', action: 'auth.recovered', entityId: user.id, ip });
    log.info(`account recovered: ${user.username}`);
    const session = this.sessions.create(user.id, { ip, userAgent });
    return { token: session.token, user: this.publicUser(user.id), expiresAt: session.expiresAt };
  }

  /** Login with username + security answer (spec 5.2), progressive lockout (spec 5.3). */
  login({ username, securityAnswer, ip = null, userAgent = null }) {
    const key = String(username || '').toLowerCase();
    const user = this.db.get('SELECT * FROM users WHERE username_lower = ? AND deleted_at IS NULL', key);

    if (user?.locked_until) {
      const until = SessionStore.toMillis(user.locked_until);
      if (until > Date.now()) {
        throw err.locked(`Too many failed attempts. Try again in ${Math.ceil((until - Date.now()) / 60000)} minute(s).`);
      }
    }
    // Limit unknown usernames too, so the endpoint cannot be enumerated.
    if (!user && recentFailures(this.db, key) >= MAX_FAILURES) {
      throw err.locked('Too many failed attempts. Try again later.');
    }

    const cred = user ? this.db.get('SELECT * FROM security_credentials WHERE user_id = ?', user.id) : null;
    const ok = Boolean(user && cred && verifySecret(securityAnswer, cred));
    registerAttempt(this.db, key, ok);

    if (!ok) {
      if (user) {
        const failures = recentFailures(this.db, key);
        const lockMinutes = lockMinutesFor(failures, LOCKOUT_SCHEDULE);
        this.db.run(
          'UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?',
          (user.failed_attempts || 0) + 1,
          lockMinutes > 0 ? sqliteUtc(new Date(Date.now() + lockMinutes * 60000)) : null,
          user.id
        );
        recordAudit(this.db, { userId: user.id, actor: 'user', action: 'auth.login_failed', entityId: user.id, detail: { failures }, ip });
        if (lockMinutes > 0) throw err.locked(`Too many failed attempts. Try again in ${lockMinutes} minute(s).`);
      }
      throw err.unauthorized('Incorrect username or security answer.');
    }

    this.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id);
    const session = this.sessions.create(user.id, { ip, userAgent });
    recordAudit(this.db, { userId: user.id, actor: 'user', action: 'auth.login', entityId: user.id, ip });
    return { token: session.token, user: this.publicUser(user.id), expiresAt: session.expiresAt };
  }
/** Resolve a bearer token to a user, honouring expiry and revocation. */
  resolveSession(token) {
    const row = this.sessions.findValid(token);
    if (!row) return null;
    this.sessions.touch(row.id);
    return this.publicUser(row.user_id);
  }

  logout(token) { return this.sessions.revoke(token); }
  revokeAllSessions(userId) { return this.sessions.revokeAll(userId); }

  publicUser(userId) {
    const u = this.db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u) return null;
    return {
      id: u.id, fullName: u.full_name, username: u.username,
      securityQuestion: u.security_question, timezone: u.timezone,
      automationPaused: Boolean(u.automation_paused),
    };
  }

  updateProfile(userId, { fullName, timezone }) {
    this.db.run(
      'UPDATE users SET full_name = COALESCE(?, full_name), timezone = COALESCE(?, timezone) WHERE id = ?',
      fullName ?? null, timezone ?? null, userId
    );
    return this.publicUser(userId);
  }

  /** "Pause All Automation" (spec 26). */
  setAutomationPaused(userId, paused) {
    this.db.run('UPDATE users SET automation_paused = ? WHERE id = ?', paused ? 1 : 0, userId);
    return this.publicUser(userId);
  }
}

export default AuthService;