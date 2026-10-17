import { randomBytes } from 'node:crypto';

import { createTestDb } from '../../src/db/index.js';
import { createSystem } from '../../src/system.js';
import { err, AppError, ERROR_KIND } from '../../src/core/errors.js';
import { STAGE } from '../../src/workers/queue.js';

/**
 * Harness for the worker lifecycle tests.
 *
 * The pipeline, queue, state machine, suppression, idempotency, limits and
 * follow-up logic are all REAL. Only the outbound boundaries are replaced â€” AI
 * transport, email transport and outbound HTTP/discovery â€” so tests are
 * deterministic and offline.
 *
 * The AI stub sits BELOW `AITasks`, so every response still passes through the
 * real validators in ai/tasks.js. Real AI execution is verified separately by
 * scripts/probe-opencode.js.
 */

export const SITE_HTML = `<!DOCTYPE html><html><head>
<title>ABC Restaurant</title>
<meta name="description" content="Family restaurant in Austin">
</head><body>
<nav><a href="/">Home</a><a href="/menu">Menu</a></nav>
<h1>ABC Restaurant</h1>
<p>${'Welcome to our restaurant. '.repeat(20)}</p>
<a href="/reservations">Book a table</a>
<a href="mailto:hello@abcrestaurant.com">Email us</a>
<img src="/a.jpg">
</body></html>`;

export function makeFakeAI(overrides = {}) {
  const calls = [];
  const canned = {
    interpret_mission: {
      service: 'website_design',
      target_description: 'restaurants with weak websites',
      investigation_notes: 'check mobile layout and calls to action',
      offer_summary: 'free-first website redesign',
      outreach_instructions: { tone: 'friendly', max_words: 90, required_points: [], restrictions: [] },
      countries: ['US'],
      qualification_bar: ['has a website with no call to action'],
    },
    analyze_site: {
      has_website: true,
      findings: [{ issue: 'No viewport meta tag', evidence: '<head> has no meta viewport', severity: 'high' }],
      opportunities: ['mobile redesign'],
      contact_route_found: false,
      contact_evidence: '',
      quality_score: 42,
    },
    analyze_presence: {
      findings: [{ issue: 'No website listed', evidence: 'discovery source listed no website', severity: 'medium' }],
      opportunities: ['build a website'],
      contact_route_found: false,
      contact_route: '',
      contact_evidence: '',
      opportunity_score: 55,
    },
    qualify: {
      qualified: true,
      confidence: 0.82,
      reason: 'Site lacks a viewport meta tag and has no visible call to action.',
      observed: ['no viewport meta tag'],
      opportunity: 'Mobile-friendly redesign',
      relevant_service: 'website_design',
      recommended_service: 'mobile_improvement',
      explanation: 'The recorded evidence supports a clear redesign opportunity.',
    },
    write_outreach: {
      subject: 'Your website at ABC Restaurant',
      body: 'Hi, I noticed ABC Restaurant has no mobile viewport tag set, which can hide the booking button on phones. I can put together a free first pass at a cleaner mobile layout.',
      referenced_observations: ['no viewport meta tag'],
      checks: { mentions_real_observation: true, claims_nothing_unobserved: true, no_false_claims: true },
    },
    reply_triage: {
      intent: 'interested',
      summary: 'Asked for more details about the redesign.',
      should_stop_follow_up: true,
      is_opt_out: false,
    },
    ask_prospect: {
      answer: 'The recorded evidence shows no mobile viewport tag, so the site may render poorly on phones.',
      observed: ['no viewport meta tag'],
    },
  };

  const base = {
    calls,
    selection: () => ({ provider: 'opencode', model: 'opencode/test-model' }),
    async completeJson(userId, purpose) {
      calls.push(purpose);
      if (!(purpose in canned)) throw new Error(`fake AI has no canned response for ${purpose}`);
      const custom = overrides[purpose];
      return {
        data: typeof custom === 'function' ? custom(canned[purpose]) : canned[purpose],
        model: 'opencode/test-model',
        attempts: 1,
      };
    },
    async complete() { throw new Error('plain completion not expected in tests'); },
    async catalog() { return [{ id: 'opencode/test-model', provider: 'opencode', model: 'test-model' }]; },
    /** Validates like the real runtime: unknown models are rejected. */
    async setSelection(userId, model) {
      const catalog = await base.catalog();
      const found = catalog.find((m) => m.id === model);
      if (!found) {
        // A model the installed runtime does not offer is a user input error,
        // not a provider outage â€” the spec calls for a clear rejection.
        throw err.validation(`"${model}" is not offered by the installed OpenCode runtime.`);
      }
      base.selected = found.id;
      return { provider: found.provider, model: found.id, agent: null };
    },
    async diagnose() { return { ok: true, version: 'test' }; },
  };
  base.selected = null;
  base.selection = () => ({ provider: 'opencode', model: base.selected || 'opencode/test-model', agent: null });
  return base;
}

/** Records sends; mirrors a provider rejecting a duplicate idempotency key. */
export function makeFakeEmail(db = null) {
  const sent = [];
  const state = { failNext: null, replies: [] };
  const email = {
    state,
    sent,
    async send(userId, { to, subject, text, idempotencyKey }) {
      if (state.failNext) {
        const e = state.failNext;
        state.failNext = null;
        // Tests choose the taxonomy; defaults mirror the real send failure.
        // `retryable` is a getter derived from the code, so it must not be
        // assigned â€” the code alone decides retry vs permanent.
        const error = new AppError(e.code || 'SEND_FAILED', e.message || 'send failed', {
          kind: e.kind || ERROR_KIND.EMAIL,
          status: e.status || 502,
        });
        throw error;
      }
      if (sent.some((s) => s.idempotencyKey === idempotencyKey)) {
        throw err.conflict('duplicate idempotency key', 'DUPLICATE_SEND');
      }
      sent.push({ userId, to, subject, text, idempotencyKey });
      return { providerMessageId: `msg-${sent.length}`, threadKey: `thread-${to}`, provider: 'test' };
    },
    async replies() { return state.replies; },
    /** Rejects unknown providers and actually drops the connection. */
    async disconnect(userId, providerId) {
      if (!['google', 'microsoft', 'resend'].includes(providerId)) {
        throw err.email('PROVIDER_UNSUPPORTED', `No email provider named "${providerId}".`);
      }
      if (db) await db.run('DELETE FROM email_connections WHERE user_id = ? AND provider = ?', userId, providerId);
      return db_connections.delete(`${userId}:${providerId}`);
    },
    /** Mirrors the real catalogue: every registered provider, never secrets. */
    async statusFor(userId) {
      const catalogue = [
        { id: 'google', label: 'Google', authType: 'oauth', capabilities: { send: true, replies: true } },
        { id: 'microsoft', label: 'Microsoft', authType: 'oauth', capabilities: { send: true, replies: true } },
        { id: 'resend', label: 'Resend', authType: 'api_key', capabilities: { send: true, replies: false } },
      ].map((meta) => {
        const row = db_connections.get(`${userId}:${meta.id}`) || null;
        return {
          ...meta,
          configured: meta.authType === 'api_key' ? true : !unconfigured.has(meta.id),
          scopes: ['https://www.googleapis.com/auth/gmail.modify'],
          connection: row
            ? { provider: meta.id, status: 'connected', accountEmail: row.accountEmail }
            : { provider: meta.id, status: 'disconnected', accountEmail: null },
        };
      });
      // The real service reads persisted connections; tests may attach a mailbox
      // by writing `email_connections` directly (connectMailbox), so the fake
      // has to see that state too or the dashboard lies about being connected.
      if (!db) return catalogue;
      const rows = await db.all(
        'SELECT provider, account_email, status FROM email_connections WHERE user_id = ?', userId,
      );
      const persisted = new Map(rows.map((r) => [r.provider, r]));
      return catalogue.map((meta) => {
        const row = persisted.get(meta.id);
        if (!row) return meta;
        return {
          ...meta,
          connection: { provider: meta.id, status: row.status, accountEmail: row.account_email },
        };
      });
    },
  };
  const db_connections = new Map();
  const issuedStates = new Map();
  // Tests run without OAuth client credentials, so nothing is configured by
  // default â€” exactly like a fresh deployment.
  const unconfigured = new Set(['google', 'microsoft']);
  email.issuedStates = issuedStates;
  email.configure = (id) => unconfigured.delete(id);
  email.connect = (userId, provider, accountEmail) => {
    db_connections.set(`${userId}:${provider}`, { accountEmail });
  };
  /**
   * The real EmailService writes the connection to the database, and the rest
   * of the system (sending, monitoring, the connections view) reads it from
   * there. Tests that connect through the real routes must therefore persist
   * too, or the pipeline would believe the mailbox is still unconnected.
   */
  const persistConnection = async (userId, provider, accountEmail) => {
    email.connect(userId, provider, accountEmail);
    if (!db) return;
    await db.run(
      `INSERT INTO email_connections(user_id, provider, account_email, access_token_enc, status, updated_at)
       VALUES(?,?,?, 'v1:a:b:c', 'connected', datetime('now'))
       ON CONFLICT(user_id, provider) DO UPDATE SET account_email = excluded.account_email,
                                                   status = 'connected',
                                                   updated_at = excluded.updated_at`,
      userId, provider, accountEmail,
    );
  };
  // â”€â”€ OAuth, so the connect/callback route pair is exercised for real â”€â”€
  email.beginAuth = async (userId, providerId) => {
    if (!['google', 'microsoft'].includes(providerId)) {
      throw err.email('PROVIDER_UNSUPPORTED', `No email provider named "${providerId}".`);
    }
    if (unconfigured.has(providerId)) {
      throw err.email('PROVIDER_NOT_CONFIGURED', `${providerId} is not configured on this server.`);
    }
    const state = randomBytes(16).toString('hex');
    issuedStates.set(state, { userId, providerId, used: false });
    return { url: `https://oauth.example/${providerId}?state=${state}`, state };
  };
  /** Same one-time semantics as the real service: single use, user-bound. */
  email.consumeState = (providerId, state) => {
    const record = issuedStates.get(String(state));
    if (!record || record.providerId !== providerId || record.used) {
      throw err.validation('This authorization link is invalid or has expired. Start again.');
    }
    record.used = true;
    return { userId: record.userId, provider: record.providerId };
  };
  email.completeAuth = async (userId, providerId, { code }) => {
    if (code === 'bad-code') {
      throw err.email('MAILBOX_AUTH_FAILED', 'The provider rejected the authorization code.');
    }
    await persistConnection(userId, providerId, `${providerId}@example.com`);
    return { provider: providerId, status: 'connected', accountEmail: `${providerId}@example.com` };
  };
  // ── API-key providers (Resend), mirroring EmailService.connectApiKey ──
  email.connectApiKey = async (userId, providerId, { apiKey, fromEmail } = {}) => {
    if (!['google', 'microsoft', 'resend'].includes(providerId)) {
      throw err.email('PROVIDER_UNSUPPORTED', `No email provider named "${providerId}".`);
    }
    if (providerId !== 'resend') {
      throw err.validation(`${providerId} is connected through an authorization redirect, not an API key.`);
    }
    if (!String(apiKey || '').trim()) throw err.validation('Paste the API key for this provider.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(fromEmail || '').trim())) {
      throw err.validation('Enter a valid From email address.');
    }
    await persistConnection(userId, 'resend', String(fromEmail).trim());
    return { provider: 'resend', status: 'connected', accountEmail: String(fromEmail).trim(), senderReady: true, domains: [] };
  };
  email.replyCapable = async (_userId, providerId = null) =>
    (providerId ? ['google', 'microsoft'].includes(providerId) : true);
  return email;
}
const ALLOWED_SETUP_OPTIONS = ['discoveryCandidates', 'aiOverrides', 'emailState'];

/** Guard against tests passing mission/user config where it is ignored. */
function throwOnUnknownOptions(options) {
  if (!options) return;
  const unknown = Object.keys(options).filter((k) => !ALLOWED_SETUP_OPTIONS.includes(k));
  if (unknown.length) {
    throw new Error(
      `setup() does not accept ${unknown.join(', ')}. `
      + 'Pass mission options to seedMission and user options to seedUser.'
    );
  }
}

export async function setup({ discoveryCandidates = null, aiOverrides = {}, emailState = {} } = {}) {
  // Mission configuration belongs to seedMission via `stack(db, { mission })`.
  // Failing loudly prevents tests from silently running with default settings.
  throwOnUnknownOptions(arguments[0]);
  const db = await createTestDb();
  // The async database layer applies the schema explicitly; the harness must
  // hand every test a migrated database (migrate() is idempotent).
  await db.migrate();
  const ai = makeFakeAI(aiOverrides);
  const email = makeFakeEmail(db);
  Object.assign(email.state, emailState);

  const research = {
    fetchUrl: async (url) => {
      if (url.includes('dead')) {
        const e = new Error('site unreachable');
        e.code = 'HTTP_5XX';
        e.kind = 'browser';
        e.retryable = true;
        throw e;
      }
      return { url, status: 200, contentType: 'text/html', body: SITE_HTML, bytes: SITE_HTML.length };
    },
    // §12 enrichment fakes: deterministic, offline, but shaped exactly like the
    // real clients so the handler merge is exercised for real.
    checkLinks: async (html, url) => ({
      checked: 3, brokenCount: 1, unreachableCount: 0,
      broken: [{ url: `${url}/menu`, status: 404 }], unreachable: [],
      method: 'http_link_probe_without_javascript',
    }),
    pagespeed: async (url) => ({
      ok: true, strategy: 'mobile', finalUrl: url, fetchTime: '2026-01-01T00:00:00.000Z',
      scores: { performance: 38, accessibility: 90, bestPractices: 83, seo: 92 },
      vitals: {
        firstContentfulPaint: '2.1 s', largestContentfulPaint: '4.8 s',
        cumulativeLayoutShift: '0.12', totalBlockingTime: '410 ms', speedIndex: '5.4 s',
      },
      hasRenderedScreenshot: true, fieldDataAvailable: false,
      screenshot: { dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', width: 412, height: 823, bytes: 40, strategy: 'mobile' },
      method: 'pagespeed_insights_lighthouse',
    }),
  };

  const discovery = {
    discover: async () => ({
      source: 'test_source',
      area: 'Austin',
      candidates: discoveryCandidates ?? [
        {
          name: 'ABC Restaurant',
          website: 'https://abcrestaurant.com',
          email: 'hello@abcrestaurant.com',
          phone: '+1 512 555 0100',
          city: 'Austin', region: 'Texas', country: 'US',
          source: 'test_source', sourceUrl: 'https://example.org/a',
        },
      ],
    }),
  };

  const system = createSystem({
    db,
    overrides: { ai, services: { email, research, discovery } },
  });
  return { db, system, ai, email, research, discovery };
}

export async function seedUser(db, { username = 'ada', automationPaused = false } = {}) {
  const { lastInsertRowid: id } = await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, automation_paused, created_ms)
     VALUES('Ada Lovelace', ?, ?, 'q?', ?, 0)`,
    username, username.toLowerCase(), automationPaused ? 1 : 0
  );
  return db.get('SELECT * FROM users WHERE id = ?', id);
}

export async function seedMission(db, userId, {
  name = 'Restaurant Website Redesign',
  sending_mode = 'autopilot',
  status = 'scheduled',
  windows = [{ dayOfWeek: 1, startMin: 600, endMin: 780 }],
  locations = [{ country: 'US', city: 'Austin', priority: 'high' }],
  timezone = 'UTC',
  followUpDelayDays = 2,
  maxFollowUps = 3,
  dailySendLimit = 20,
} = {}) {
  const { lastInsertRowid: id } = await db.run(
    `INSERT INTO missions(user_id, name, service, offer_summary, target_description, sending_mode,
                          timezone, follow_up_delay_days, max_follow_ups, daily_send_limit, status)
     VALUES(?,?, 'website_design', 'free-first website redesign', 'restaurants with weak websites', ?,?,?,?,?,?)`,
    userId, name, sending_mode, timezone, followUpDelayDays, maxFollowUps, dailySendLimit, status
  );
  await db.run('DELETE FROM mission_windows WHERE mission_id = ?', id);
  for (const w of windows) {
    await db.run(
      'INSERT INTO mission_windows(mission_id, day_of_week, start_min, end_min) VALUES(?,?,?,?)',
      id, w.dayOfWeek, w.startMin, w.endMin
    );
  }
  await db.run('DELETE FROM target_locations WHERE mission_id = ?', id);
  for (const l of locations) {
    await db.run(
      'INSERT INTO target_locations(mission_id, country, region, city, priority) VALUES(?,?,?,?,?)',
      id, l.country, l.region || null, l.city || null, l.priority || 'medium'
    );
  }
  return db.get('SELECT * FROM missions WHERE id = ?', id);
}

export async function connectMailbox(db, userId, provider = 'google') {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO email_connections(user_id, provider, account_email, access_token_enc, status, updated_at)
     VALUES(?,?,?, 'v1:a:b:c', 'connected', datetime('now'))`,
    userId, provider, `${provider}@example.com`
  );
  return lastInsertRowid;
}

export { STAGE };