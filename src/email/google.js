import { EmailProvider } from './provider.js';
import { err } from '../core/errors.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Minimal scopes: send mail, read/label replies, identify the mailbox (§6). */
export class GoogleEmailProvider extends EmailProvider {
  static id = 'google';
  static label = 'Google / Gmail';
  static scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
  ];

  isConfigured() { return Boolean(this.config.google.clientId && this.config.google.clientSecret); }

  async getAuthUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: this.config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GoogleEmailProvider.scopes.join(' '),
      access_type: 'offline',       // request a refresh token
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode({ code, redirectUri }) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: this.config.google.clientId,
        client_secret: this.config.google.clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw err.email('MAILBOX_AUTH_FAILED', `Google token exchange failed: ${body.error_description || body.error || res.status}`);
    }
    return body;
  }

  async refresh(refreshToken) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.google.clientId,
        client_secret: this.config.google.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw err.email('MAILBOX_AUTH_EXPIRED', `Google refresh failed: ${body.error_description || body.error || res.status}`);
    }
    return body;
  }

  async getAccountEmail(accessToken) {
    const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw err.email('MAILBOX_AUTH_EXPIRED', `Google userinfo failed: ${res.status}`);
    const body = await res.json();
    return body.email || null;
  }

  async sendMessage({ accessToken, to, subject, text, html }) {
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
      '',
      html || text,
    ].join('\r\n');

    const res = await fetch(`${GMAIL}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw mapGoogleError(res.status, out);
    return { providerMessageId: out.id, threadKey: out.threadId };
  }

  async fetchReplies({ accessToken }) {
    const listUrl = `${GMAIL}/messages?q=${encodeURIComponent('in:inbox newer_than:7d -from:me')}&maxResults=25`;
    const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listRes.ok) throw mapGoogleError(listRes.status, await listRes.json().catch(() => ({})));
    const list = await listRes.json();
    const messages = list.messages || [];
    if (!messages.length) return [];

    const replies = [];
    for (const m of messages.slice(0, 25)) {
      const detail = await fetch(`${GMAIL}/messages/${m.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!detail.ok) continue;
      const full = await detail.json();
      const headers = full.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value || null;
      replies.push({
        providerMessageId: full.id,
        threadKey: full.threadId || null,
        from: get('From'),
        to: get('To'),
        subject: get('Subject'),
        receivedAt: full.internalDate
          ? new Date(Number(full.internalDate)).toISOString()
          : get('Date'),
        text: extractBody(full.payload),
      });
    }
    return replies;
  }
}

/** Walk Gmail's nested MIME tree to find the first usable text part. */
function extractBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts || []) {
    const found = extractBody(child);
    if (found) return found;
  }
  if (part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  return '';
}

/** Translate Gmail errors into our taxonomy so retries behave correctly. */
function mapGoogleError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.message || '';
  if (status === 401) return err.email('MAILBOX_AUTH_EXPIRED', `Google rejected the token: ${reason}`);
  if (status === 403) return err.email('PROVIDER_FORBIDDEN', `Google refused the request: ${reason}`);
  if (status === 429) return err.email('PROVIDER_TEMPORARY', 'Gmail rate limit reached.');
  if (status >= 500) return err.email('PROVIDER_TEMPORARY', `Gmail server error: ${status}`);
  return err.email('SEND_FAILED', `Gmail send failed: ${reason || status}`);
}

export default GoogleEmailProvider;