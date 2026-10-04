import { EmailProvider } from './provider.js';
import { err } from '../core/errors.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Minimal Graph scopes: send, read replies, offline refresh, identity (§6). */
export class MicrosoftEmailProvider extends EmailProvider {
  static id = 'microsoft';
  static label = 'Microsoft / Outlook';
  static scopes = ['offline_access', 'User.Read', 'Mail.Send', 'Mail.Read'];

  _base() {
    return `https://login.microsoftonline.com/${this.config.microsoft.tenant}/oauth2/v2.0`;
  }

  isConfigured() {
    return Boolean(this.config.microsoft.clientId && this.config.microsoft.clientSecret);
  }

  async getAuthUrl({ state, redirectUri }) {
    const params = new URLSearchParams({
      client_id: this.config.microsoft.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: MicrosoftEmailProvider.scopes.join(' '),
      state,
    });
    return `${this._base()}/authorize?${params.toString()}`;
  }

  async exchangeCode({ code, redirectUri }) {
    const res = await fetch(`${this._base()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: this.config.microsoft.clientId,
        client_secret: this.config.microsoft.clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
        scope: MicrosoftEmailProvider.scopes.join(' '),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw err.email('MAILBOX_AUTH_FAILED', `Microsoft token exchange failed: ${body.error_description || body.error || res.status}`);
    }
    return body;
  }

  async refresh(refreshToken) {
    const res = await fetch(`${this._base()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.microsoft.clientId,
        client_secret: this.config.microsoft.clientSecret,
        grant_type: 'refresh_token',
        scope: MicrosoftEmailProvider.scopes.join(' '),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw err.email('MAILBOX_AUTH_EXPIRED', `Microsoft refresh failed: ${body.error_description || body.error || res.status}`);
    }
    return body;
  }

  async getAccountEmail(accessToken) {
    const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw err.email('MAILBOX_AUTH_EXPIRED', `Microsoft profile request failed: ${res.status}`);
    const body = await res.json();
    return body.mail || body.userPrincipalName || null;
  }

  async sendMessage({ accessToken, to, subject, text, html }) {
    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: html ? 'HTML' : 'Text', content: html || text },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) throw mapGraphError(res.status, await res.json().catch(() => ({})));
    // sendMail returns 202 with no body; use the request id when present.
    const id = res.headers.get('request-id') || res.headers.get('client-request-id') || null;
    return { providerMessageId: id, threadKey: null };
  }

  async fetchReplies({ accessToken }) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
    const select = encodeURIComponent('id,conversationId,subject,from,receivedDateTime,body');
    const url = `${GRAPH}/me/messages?$filter=${filter}&$select=${select}&$orderby=receivedDateTime desc&$top=25`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw mapGraphError(res.status, await res.json().catch(() => ({})));
    const body = await res.json();
    return (body.value || []).map((m) => ({
      providerMessageId: m.id,
      threadKey: m.conversationId || null,
      from: m.from?.emailAddress?.address || null,
      to: m.toRecipients?.[0]?.emailAddress?.address || null,
      subject: m.subject || null,
      receivedAt: m.receivedDateTime || null,
      text: stripHtml(m.body?.content || ''),
    }));
  }
}

/** Graph returns HTML by default; reduce it to readable plain text. */
function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function mapGraphError(status, body) {
  const reason = body?.error?.message || '';
  if (status === 401) return err.email('MAILBOX_AUTH_EXPIRED', `Microsoft rejected the token: ${reason}`);
  if (status === 403) return err.email('PROVIDER_FORBIDDEN', `Microsoft refused the request: ${reason}`);
  if (status === 429) return err.email('PROVIDER_TEMPORARY', 'Microsoft Graph rate limit reached.');
  if (status >= 500) return err.email('PROVIDER_TEMPORARY', `Microsoft server error: ${status}`);
  return err.email('SEND_FAILED', `Microsoft send failed: ${reason || status}`);
}

export default MicrosoftEmailProvider;