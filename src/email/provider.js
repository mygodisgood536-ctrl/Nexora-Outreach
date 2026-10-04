import { randomBytes, createHash } from 'node:crypto';

import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { nowSqlite } from '../core/time.js';
import { CONNECTION_STATUS } from '../services/email-store.js';

const log = createLogger('email');

/** How long an authorization link stays usable. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Only the digest is stored, so a database copy cannot be replayed. */
function hashState(state) {
  return createHash('sha256').update(String(state)).digest('hex');
}

export function nowSqliteFrom(seconds) {
  return nowSqlite(new Date(Date.now() + seconds * 1000));
}

/**
 * Contract every email provider must implement (spec §6: "Keep email
 * integrations behind a provider abstraction so more providers can be added
 * later").
 *
 * Implementations talk to real OAuth/API endpoints. None of them accept an
 * ordinary mailbox password.
 */
export class EmailProvider {
  static id = 'base';
  static label = 'Base';
  /** Kept minimal (spec §6 "minimum required authorization"). */
  static scopes = [];

  constructor({ config }) { this.config = config; }

  /** False when required client credentials are absent, so the UI can hide it. */
  isConfigured() { return false; }

  /** Provider authorization URL the browser redirects to. */
  async getAuthUrl() { throw new Error('not implemented'); }

  /** Exchange an authorization code for tokens. */
  async exchangeCode() { throw new Error('not implemented'); }

  /** Refresh an expired access token. */
  async refresh() { throw new Error('not implemented'); }

  /** The authorized mailbox address. */
  async getAccountEmail() { throw new Error('not implemented'); }

  /**
   * Send one message. Must return { providerMessageId } and must honour an
   * idempotency key so an uncertain outcome cannot produce a duplicate send
   * (spec §30).
   */
  async sendMessage() { throw new Error('not implemented'); }

  /**
   * List inbound replies since `sinceIso`, newest first.
   * Returns [{ providerMessageId, threadKey, from, subject, text, receivedAt }].
   */
  async fetchReplies() { throw new Error('not implemented'); }
}
/**
 * Orchestrates token lifecycle, provider selection and transport so callers
 * never handle raw tokens or provider specifics.
 */
export class EmailService {
  constructor({ db, store, providers = {} }) {
    this.db = db;
    this.store = store;
    this.providers = providers;
  }

  register(provider) { this.providers[provider.constructor.id] = provider; }

  get(providerId) {
    const p = this.providers[providerId];
    if (!p) throw err.email('PROVIDER_UNSUPPORTED', `No email provider named "${providerId}".`);
    return p;
  }

  /** Public list for the UI — configured state only, never credentials. */
  catalogue() {
    return Object.values(this.providers).map((p) => ({
      id: p.constructor.id,
      label: p.constructor.label,
      configured: p.isConfigured(),
      scopes: p.constructor.scopes,
    }));
  }

  statusFor(userId) {
    const rows = this.store.list(userId);
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return this.catalogue().map((meta) => {
      const row = byProvider.get(meta.id);
      return {
        ...meta,
        connection: row
          ? this.store.toPublic(row)
          : { provider: meta.id, status: 'disconnected', accountEmail: null },
      };
    });
  }

  /**
   * Step 1 of OAuth: hand the browser the provider's consent URL.
   *
   * The `state` value is a cryptographically random nonce that is persisted
   * (hashed) so the callback can prove this server issued it. A caller cannot
   * guess or forge one, and it is accepted at most once.
   */
  async beginAuth(userId, providerId, { redirectUri }) {
    const provider = this.get(providerId);
    if (!provider.isConfigured()) {
      throw err.email('PROVIDER_NOT_CONFIGURED', `${provider.constructor.label} is not configured on this server.`);
    }
    const state = randomBytes(32).toString('base64url');
    this.db.run(
      `INSERT INTO oauth_states(state_hash, user_id, provider, expires_at)
       VALUES(?,?,?,?)`,
      hashState(state), userId, providerId, nowSqliteFrom(OAUTH_STATE_TTL_SECONDS)
    );
    // Opportunistic cleanup keeps the table small; a failure here is harmless.
    try {
      this.db.run(`DELETE FROM oauth_states WHERE expires_at < datetime('now')`);
    } catch { /* best-effort cleanup */ }

    const url = await provider.getAuthUrl({ state, redirectUri });
    return { url, state };
  }

  /**
   * Validate and burn a callback `state`.
   *
   * Rejects anything this server did not issue, anything expired, and
   * anything already used. Consuming is a single conditional UPDATE, so two
   * concurrent replays cannot both succeed.
   */
  consumeState(providerId, state) {
    const hash = hashState(String(state));
    const row = this.db.get(
      `SELECT * FROM oauth_states
        WHERE state_hash = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
      hash, providerId
    );
    if (!row) {
      throw err.validation('This authorization link is invalid or has expired. Start again.');
    }
    const burned = this.db.run(
      `UPDATE oauth_states SET consumed_at = datetime('now')
        WHERE id = ? AND consumed_at IS NULL`,
      row.id
    );
    if (burned.changes !== 1) {
      throw err.validation('This authorization link has already been used.');
    }
    return { userId: row.user_id, provider: row.provider };
  }

  /** Step 2 of OAuth: exchange the code, then store encrypted tokens. */
  async completeAuth(userId, providerId, { code, redirectUri, ip = null }) {
    const provider = this.get(providerId);
    const tokens = await provider.exchangeCode({ code, redirectUri });
    if (!tokens?.access_token) {
      throw err.email('MAILBOX_AUTH_FAILED', 'Authorization did not return an access token.');
    }
    let accountEmail = null;
    try {
      accountEmail = await provider.getAccountEmail(tokens.access_token);
    } catch (e) {
      log.warn('could not read authorized mailbox address', { provider: providerId, error: e.message });
    }
    return this.store.save(userId, providerId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      scopes: tokens.scope ? String(tokens.scope).split(/[\s,]+/).filter(Boolean) : provider.constructor.scopes,
      expiresAt: tokens.expires_in ? nowSqliteFrom(tokens.expires_in) : null,
      accountEmail,
      ip,
    });
  }

  /**
   * Return a usable access token, refreshing and re-persisting when needed.
   * Throws MAILBOX_AUTH_EXPIRED when the grant can no longer be refreshed,
   * which the worker turns into a user notification (spec §25).
   */
  async accessTokenFor(userId, providerId = null) {
    const provider = providerId || this.store.activeFor(userId)?.provider;
    if (!provider) {
      throw err.email('MAILBOX_NOT_CONNECTED', 'Connect an authorized mailbox before sending outreach.');
    }
    const { row, accessToken, refreshToken } = this.store.tokens(userId, provider);
    if (accessToken && !this.store.isExpired(row)) return { accessToken, provider };

    if (!refreshToken) {
      this.store.markStatus(userId, provider, CONNECTION_STATUS.EXPIRED, 'Authorization expired. Reconnect your mailbox.');
      throw err.email('MAILBOX_AUTH_EXPIRED', 'Mailbox authorization expired. Reconnect it to resume sending.');
    }
    try {
      const fresh = await this.get(provider).refresh(refreshToken);
      this.store.updateTokens(userId, provider, {
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token ?? null,
        expiresAt: fresh.expires_in ? nowSqliteFrom(fresh.expires_in) : null,
      });
      return { accessToken: fresh.access_token, provider };
    } catch (e) {
      this.store.markStatus(userId, provider, CONNECTION_STATUS.EXPIRED, 'Authorization could not be refreshed.');
      throw err.email('MAILBOX_AUTH_EXPIRED', 'Mailbox authorization expired. Reconnect it to resume sending.');
    }
  }

  /** Send one message through the user's authorized mailbox. */
  async send(userId, { to, subject, text, html = null, idempotencyKey = null, providerId = null }) {
    const { accessToken, provider } = await this.accessTokenFor(userId, providerId);
    const result = await this.get(provider).sendMessage({
      accessToken, to, subject, text, html, idempotencyKey,
    });
    return { ...result, provider };
  }

  /** Poll the authorized mailbox for new replies. */
  async replies(userId, { sinceIso = null, providerId = null } = {}) {
    const { accessToken, provider } = await this.accessTokenFor(userId, providerId);
    return this.get(provider).fetchReplies({ accessToken, sinceIso });
  }

  disconnect(userId, providerId, opts = {}) {
    return this.store.disconnect(userId, providerId, opts);
  }
}

export default EmailService;