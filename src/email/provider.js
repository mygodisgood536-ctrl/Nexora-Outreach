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

  /**
   * How the user authorizes this provider:
   *  - 'oauth'   → a browser redirect returns an authorization code.
   *  - 'api_key' → the user pastes a provider API key (no redirect).
   * The two are genuinely different flows and must not be conflated in the UI.
   */
  static authType = 'oauth';

  /**
   * What this provider can actually do. Not every provider is identical, so the
   * UI reads these flags instead of pretending all integrations are the same
   * (the vision explicitly forbids claiming identical capabilities).
   */
  static capabilities = {
    send: true,
    replies: false,          // can read inbound replies here
    senderIdentity: false,   // can identify/verify the sending address
    domainVerification: false, // can list/verify sending domains
    quotaReporting: false,   // can report remaining quota / rate-limit state
  };

  /** Official docs, linked from the setup UI. */
  static docsUrl = '';
  /** One-paragraph, plain-language description shown on the provider card. */
  static whatItDoes = '';
  /** Prerequisites the user must satisfy before connecting. */
  static requirements = [];
  /**
   * Inputs for the setup form. Only used by 'api_key' providers; OAuth
   * providers use the redirect flow. Each field:
   *   { name, label, type, required, placeholder, help, secret }
   */
  static fields = [];
  /** Honest limitations or warnings shown on the card. */
  static notes = [];

  constructor({ config }) { this.config = config; }

  /** False when required client credentials are absent, so the UI can hide it. */
  isConfigured() { return false; }

  /** Public, secret-free description used to build the connection UI. */
  describe() {
    const C = this.constructor;
    return {
      id: C.id,
      label: C.label,
      configured: this.isConfigured(),
      authType: C.authType,
      capabilities: { ...C.capabilities },
      docsUrl: C.docsUrl,
      whatItDoes: C.whatItDoes,
      requirements: [...C.requirements],
      fields: C.fields.map((f) => ({ ...f })),
      notes: [...C.notes],
      scopes: [...C.scopes],
    };
  }

  /** Provider authorization URL the browser redirects to. */
  async getAuthUrl() { throw new Error('not implemented'); }

  /** Exchange an authorization code for tokens. */
  async exchangeCode() { throw new Error('not implemented'); }

  /** Refresh an expired access token. */
  async refresh() { throw new Error('not implemented'); }

  /** The authorized mailbox address. */
  async getAccountEmail() { throw new Error('not implemented'); }

  /**
   * Validate a pasted credential for an 'api_key' provider. Returns structured,
   * secret-free detail (e.g. the visible sending domains). Throws a typed error
   * when the credential is rejected. OAuth providers do not implement this.
   */
  async validateCredential() {
    throw err.email('PROVIDER_UNSUPPORTED', `${this.constructor.label} does not support API-key connections.`);
  }

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
    return Object.values(this.providers).map((p) => p.describe());
  }

  async statusFor(userId) {
    const rows = await this.store.list(userId);
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
   * Connect a provider that uses a pasted API key (spec §6). The credential is
   * validated against the provider's own API before anything is persisted, so a
   * typo never becomes a "connected" mailbox that only fails at send time.
   */
  async connectApiKey(userId, providerId, { apiKey, fromEmail, ip = null } = {}) {
    const provider = this.get(providerId);
    if (provider.constructor.authType !== 'api_key') {
      throw err.validation(`${provider.constructor.label} is connected through an authorization redirect, not an API key.`);
    }
    const key = String(apiKey || '').trim();
    const from = String(fromEmail || '').trim();
    if (!key) throw err.validation('Paste the API key for this provider.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) throw err.validation('Enter a valid From email address.');

    const info = await provider.validateCredential(key);
    const domain = from.split('@')[1].toLowerCase();
    const domains = (info?.domains || []).map((d) => ({ name: d.name, status: d.status }));
    const verified = domains.some((d) => String(d.name).toLowerCase() === domain && d.status === 'verified');
    const testSender = domain === 'resend.dev';
    const senderReady = verified || testSender;
    const detail = senderReady
      ? null
      : `Sender domain "${domain}" is not verified yet. Verify it with ${provider.constructor.label}, or send from a test address, before activating a campaign.`;

    await this.store.save(userId, providerId, {
      accessToken: key,
      refreshToken: null,
      scopes: provider.constructor.scopes,
      expiresAt: null,
      accountEmail: from,
      ip,
    });
    if (detail) await this.store.markStatus(userId, providerId, CONNECTION_STATUS.CONNECTED, detail);

    return {
      ...this.store.toPublic(await this.store.raw(userId, providerId)),
      senderReady,
      domains,
    };
  }

  /** True when the active (or named) provider can read inbound replies here. */
  async replyCapable(userId, providerId = null) {
    const active = providerId ? { provider: providerId } : await this.store.activeFor(userId);
    const pid = providerId || active?.provider;
    if (!pid) return false;
    return Boolean(this.providers[pid]?.constructor?.capabilities?.replies);
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
    if (provider.constructor.authType !== 'oauth') {
      throw err.validation(`${provider.constructor.label} is connected by pasting an API key, not an authorization redirect.`);
    }
    if (!provider.isConfigured()) {
      throw err.email('PROVIDER_NOT_CONFIGURED', `${provider.constructor.label} is not configured on this server.`);
    }
    const state = randomBytes(32).toString('base64url');
    await this.db.run(
      `INSERT INTO oauth_states(state_hash, user_id, provider, expires_at)
       VALUES(?,?,?,?)`,
      hashState(state), userId, providerId, nowSqliteFrom(OAUTH_STATE_TTL_SECONDS)
    );
    // Opportunistic cleanup keeps the table small; a failure here is harmless.
    try {
      await this.db.run(`DELETE FROM oauth_states WHERE expires_at < datetime('now')`);
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
  async consumeState(providerId, state) {
    const hash = hashState(String(state));
    const row = await this.db.get(
      `SELECT * FROM oauth_states
        WHERE state_hash = ? AND provider = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
      hash, providerId
    );
    if (!row) {
      throw err.validation('This authorization link is invalid or has expired. Start again.');
    }
    const burned = await this.db.run(
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
    const active = await this.store.activeFor(userId);
    const provider = providerId || active?.provider;
    if (!provider) {
      throw err.email('MAILBOX_NOT_CONNECTED', 'Connect an authorized mailbox before sending outreach.');
    }
    const { row, accessToken, refreshToken } = await this.store.tokens(userId, provider);
    if (accessToken && !this.store.isExpired(row)) return { accessToken, provider };

    if (!refreshToken) {
      await this.store.markStatus(userId, provider, CONNECTION_STATUS.EXPIRED, 'Authorization expired. Reconnect your mailbox.');
      throw err.email('MAILBOX_AUTH_EXPIRED', 'Mailbox authorization expired. Reconnect it to resume sending.');
    }
    try {
      const fresh = await this.get(provider).refresh(refreshToken);
      await this.store.updateTokens(userId, provider, {
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token ?? null,
        expiresAt: fresh.expires_in ? nowSqliteFrom(fresh.expires_in) : null,
      });
      return { accessToken: fresh.access_token, provider };
    } catch (e) {
      await this.store.markStatus(userId, provider, CONNECTION_STATUS.EXPIRED, 'Authorization could not be refreshed.');
      throw err.email('MAILBOX_AUTH_EXPIRED', 'Mailbox authorization expired. Reconnect it to resume sending.');
    }
  }

  /** Send one message through the user's authorized mailbox. */
  async send(userId, { to, subject, text, html = null, idempotencyKey = null, providerId = null, from = null }) {
    const { accessToken, provider } = await this.accessTokenFor(userId, providerId);
    let sender = from;
    if (!sender) {
      const row = await this.store.raw(userId, provider);
      sender = row?.account_email || null;
    }
    const result = await this.get(provider).sendMessage({
      accessToken, from: sender, to, subject, text, html, idempotencyKey,
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