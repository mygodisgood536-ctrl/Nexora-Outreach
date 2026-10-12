import { EmailProvider } from './provider.js';
import { err } from '../core/errors.js';

const DEFAULT_BASE = 'https://api.resend.com';

/**
 * Resend provider (API-key flow, spec §6).
 *
 * Resend is deliberately different from the OAuth mailboxes: there is no
 * redirect, no refresh token, and no inbound reply stream. The user creates an
 * API key in the Resend dashboard and pastes it here; we validate it against
 * Resend's own API before storing it, then send from a verified domain.
 *
 * The capability flags on this class tell the UI the honest truth about that:
 * send = yes, inbound replies = no. Reply detection therefore requires a Gmail
 * or Microsoft mailbox connection — we never pretend Resend can do it.
 */
export class ResendEmailProvider extends EmailProvider {
  static id = 'resend';
  static label = 'Resend';
  static scopes = ['email.send'];
  static authType = 'api_key';
  static capabilities = {
    send: true,
    replies: false,
    senderIdentity: true,
    domainVerification: true,
    quotaReporting: false,
  };
  static docsUrl = 'https://resend.com/docs/dashboard/api-keys/introduction';
  static whatItDoes = 'Sends outreach email through Resend using an API key you create, from a domain you have verified with Resend.';
  static requirements = [
    'A Resend account.',
    'An API key (Resend dashboard → API Keys). A "Sending access" key is enough.',
    'A verified sending domain, or the resend.dev test sender for your own address.',
  ];
  static fields = [
    {
      name: 'apiKey',
      label: 'Resend API key',
      type: 'password',
      required: true,
      secret: true,
      placeholder: 're_...',
      help: 'Create one at resend.com/api-keys. Stored encrypted; never shown again.',
    },
    {
      name: 'fromEmail',
      label: 'From address',
      type: 'email',
      required: true,
      placeholder: 'team@yourdomain.com',
      help: 'Must be on a domain verified in Resend, or onboarding@resend.dev to test to your own account.',
    },
  ];
  static notes = [
    'Resend does not provide inbound replies here. Connect a Gmail or Microsoft mailbox if you want replies captured automatically.',
  ];

  constructor(opts) {
    super(opts);
    this.baseUrl = this.config?.resend?.baseUrl || DEFAULT_BASE;
  }

  /**
   * Resend needs no server-side client credentials — the user supplies the key
   * — so the provider is always offered in the catalogue.
   */
  isConfigured() { return true; }

  async _get(path, apiKey) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
    } catch (e) {
      throw err.network('Could not reach Resend. Check your connection and try again.', e);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw mapResendCredentialError(res.status, body);
    return body;
  }

  /**
   * Validate a pasted API key by listing the domains it can see. This proves
   * the key is live and lets us tell the user up front whether their From
   * domain is verified.
   */
  async validateCredential(apiKey) {
    const body = await this._get('/domains', apiKey);
    const domains = (Array.isArray(body?.data) ? body.data : []).map((d) => ({
      name: d.name,
      status: d.status,
    }));
    return { ok: true, domains };
  }

  async sendMessage({ accessToken, from, to, subject, text, html = null, idempotencyKey = null }) {
    if (!from) throw err.email('MAILBOX_NOT_CONNECTED', 'This Resend connection has no From address. Reconnect it.');

    const payload = { from, to: [to], subject, text };
    if (html) payload.html = html;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    // Resend honors Idempotency-Key: a retried request returns the original
    // message id instead of sending twice (spec §30). The value is derived from
    // the deterministic send key, not a random nonce, so retries collapse.
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);

    let res;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw err.network('Could not reach Resend while sending.', e);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw mapResendSendError(res.status, out);
    return { providerMessageId: out.id || null, threadKey: null };
  }

  /** Resend has no inbound reply stream in this integration. */
  async fetchReplies() { return []; }
}

/** Resend returns `{ statusCode, name, message }` on errors. */
function reasonOf(body) {
  return body?.message || body?.error || body?.name || '';
}

function mapResendSendError(status, body) {
  const reason = reasonOf(body);
  if (status === 401 || status === 403) {
    return err.email('MAILBOX_AUTH_FAILED', `Resend rejected the API key: ${reason}`.trim());
  }
  if (status === 429) {
    return err.email('PROVIDER_TEMPORARY', 'Resend rate limit reached; the send will be retried.');
  }
  if (status >= 500) {
    return err.email('PROVIDER_TEMPORARY', `Resend is unavailable (${status}); the send will be retried.`);
  }
  // 422 covers an unverified From domain / invalid recipient — not retryable.
  return err.email('SEND_FAILED', `Resend refused the message: ${reason || status}`.trim());
}

/** Errors from the credential check read differently from send failures. */
function mapResendCredentialError(status, body) {
  const reason = reasonOf(body);
  if (status === 401 || status === 403) {
    return err.email('MAILBOX_AUTH_FAILED', `Resend rejected the API key: ${reason || 'unauthorized'}`.trim());
  }
  if (status === 429) {
    return err.email('PROVIDER_TEMPORARY', 'Resend rate limit reached; try connecting again shortly.');
  }
  if (status >= 500) {
    return err.email('PROVIDER_TEMPORARY', `Resend is unavailable (${status}); try again shortly.`);
  }
  return err.validation(`Resend could not verify the API key: ${reason || status}`.trim());
}

export default ResendEmailProvider;
