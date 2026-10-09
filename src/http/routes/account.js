import { err } from '../../core/errors.js';
import {
  readJson, requireUser, clientIp,
  buildSessionCookie, clearSessionCookie, csrfTokenFor, crypto,
} from '../middleware.js';
import { normalizeEmail } from '../../core/normalize.js';
import config from '../../config.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('http');

/** Anonymous-friendly: a JSON-only content type defeats form-based CSRF. */
const PUBLIC = { auth: false, csrf: false };

export function registerAccountRoutes(router, system) {
  const { auth, aiRuntime, email } = system;

  router.get('/api/health', (ctx) => {
    ctx.json(200, { ok: true, service: 'nexora-outreach', time: new Date().toISOString() });
  }, PUBLIC);

  router.get('/api/auth/username-available', async (ctx) => {
    ctx.json(200, await auth.isUsernameAvailable(String(ctx.query.username || '')));
  }, PUBLIC);

  router.post('/api/auth/signup', async (ctx) => {
    const body = await ctx.body();
    const { userId, recoveryCode } = await auth.signup({
      fullName: body.fullName,
      username: body.username,
      securityQuestion: body.securityQuestion,
      securityAnswer: body.securityAnswer,
      timezone: body.timezone || 'UTC',
      ip: clientIp(ctx.req),
    });
    // Issue a session so the new account lands authenticated.
    const session = await auth.sessions.create(userId, {
      ip: clientIp(ctx.req), userAgent: ctx.req.headers['user-agent'] || null,
    });
    ctx.setCookie(buildSessionCookie(session.token, {
      maxAgeSeconds: config.sessionTtlHours * 3600,
    }));
    // Shown once, here, and never again — the server only keeps a hash.
    ctx.json(201, { user: await auth.publicUser(userId), recoveryCode });
  }, PUBLIC);

  /**
   * Recover access with a one-time recovery code (spec §5.3).
   *
   * Every existing session is revoked, a new security answer is set, and a
   * fresh session is issued. All of the recovery codes for the account are
   * burned, so a captured code cannot be reused.
   */
  router.post('/api/auth/recover', async (ctx) => {
    const body = await ctx.body();
    const result = await auth.recover({
      username: body.username,
      recoveryCode: body.recoveryCode,
      newSecurityAnswer: body.newSecurityAnswer,
      newSecurityQuestion: body.newSecurityQuestion,
      ip: clientIp(ctx.req),
      userAgent: ctx.req.headers['user-agent'] || null,
    });
    ctx.setCookie(buildSessionCookie(result.token, {
      maxAgeSeconds: config.sessionTtlHours * 3600,
    }));
    ctx.json(200, { user: result.user });
  }, PUBLIC);

  /** The stored security question, so the client can prompt for the answer. */
  router.get('/api/auth/security-question', async (ctx) => {
    const row = await system.db.get(
      'SELECT security_question FROM users WHERE username_lower = ? AND deleted_at IS NULL',
      String(ctx.query.username || '').toLowerCase()
    );
    ctx.json(200, { securityQuestion: row?.security_question ?? null });
  }, PUBLIC);

  router.post('/api/auth/login', async (ctx) => {
    const body = await ctx.body();
    const result = await auth.login({
      username: body.username,
      securityAnswer: body.securityAnswer,
      ip: clientIp(ctx.req),
      userAgent: ctx.req.headers['user-agent'] || null,
    });
    ctx.setCookie(buildSessionCookie(result.token, {
      maxAgeSeconds: config.sessionTtlHours * 3600,
    }));
    ctx.json(200, { user: result.user });
  }, PUBLIC);

  router.post('/api/auth/logout', async (ctx) => {
    if (ctx.token) await auth.logout(ctx.token);
    ctx.setCookie(clearSessionCookie());
    ctx.json(200, { ok: true });
  });

  router.get('/api/auth/me', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      user,
      csrfToken: csrfTokenFor({ id: ctx.sessionRowId }),
      email: await email.statusFor(user.id),
    });
  });

  router.patch('/api/auth/profile', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    ctx.json(200, {
      user: await auth.updateProfile(user.id, { fullName: body.fullName, timezone: body.timezone }),
    });
  });

  /**
   * Issue a fresh one-time recovery code (spec §5.3).
   *
   * Without this a user who loses their recovery code can never regain access.
   * Issuing a new one also burns every previously issued code, so a code leaked
   * earlier stops working the moment the user rotates.
   */
  router.post('/api/auth/recovery-code', async (ctx) => {
    const user = requireUser(ctx);
    await system.db.run(
      "UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
      user.id
    );
    const recoveryCode = await auth.issueRecoveryCode(user.id);
    log.info(`recovery code re-issued for user ${user.id}`);
    ctx.json(200, { recoveryCode });
  });

  router.post('/api/auth/automation-paused', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    ctx.json(200, { user: await auth.setAutomationPaused(user.id, Boolean(body.paused)) });
  });
/**
   * AI runtime (spec §7 / §31).
   * The provider/model catalog is always read live from the installed
   * OpenCode — there is no second, hard-coded list anywhere.
   */
  router.get('/api/ai/settings', async (ctx) => {
    const user = requireUser(ctx);
    const catalog = await aiRuntime.catalog({ refresh: ctx.query.refresh === '1' });
    ctx.json(200, {
      selection: await aiRuntime.selection(user.id),
      catalog,
      providers: [...new Set(catalog.map((m) => m.provider))],
    });
  });

  router.put('/api/ai/settings', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    if (!body.model) throw err.validation('model is required.');
    const selection = await aiRuntime.setSelection(user.id, String(body.model), body.agent || null);
    ctx.json(200, { selection });
  });

  router.get('/api/ai/diagnostics', async (ctx) => {
    requireUser(ctx);
    ctx.json(200, await aiRuntime.diagnose());
  });

  // ── Email connections (spec §6) ────────────────────────────────
  router.get('/api/email/connections', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { providers: await email.statusFor(user.id) });
  });

  router.get('/api/email/redirect-uri', (ctx) => {
    requireUser(ctx);
    const provider = String(ctx.query.provider || 'google');
    ctx.json(200, { redirectUri: `${config.publicBaseUrl}/api/email/${provider}/callback` });
  });

  /** Step 1: hand back the provider's consent URL. */
  router.post('/api/email/:provider/connect', async (ctx) => {
    const user = requireUser(ctx);
    const provider = ctx.params.provider;
    const { url } = await email.beginAuth(user.id, provider, {
      redirectUri: `${config.publicBaseUrl}/api/email/${provider}/callback`,
    });
    ctx.json(200, { authorizeUrl: url });
  });

  /** Step 2: the provider redirects here with ?code=...&state=... */
  router.get('/api/email/:provider/callback', async (ctx) => {
    const provider = ctx.params.provider;
    const code = ctx.query.code;
    const state = ctx.query.state;
    if (!code || !state) throw err.validation('The provider did not return an authorization code.');

    // The state must be one this server issued, unused and unexpired.
    // It is consumed before the code exchange, so a captured link is dead.
    const { userId } = await email.consumeState(provider, String(state));
    // Re-check the session so a callback cannot be finished by another user.
    if (!ctx.user || ctx.user.id !== userId) {
      throw err.unauthorized('Sign in again to finish connecting your mailbox.');
    }

    const connection = await email.completeAuth(userId, provider, {
      code: String(code),
      redirectUri: `${config.publicBaseUrl}/api/email/${provider}/callback`,
      ip: clientIp(ctx.req),
    });
    await system.db.run(
      'INSERT INTO audit_events(user_id, actor, action, entity_type, entity_id) VALUES(?,?,?,?,?)',
      userId, 'user', 'email.connected_via_api', 'email_connection', provider
    );
    ctx.json(200, { connection });
  }, { csrf: false });

  router.post('/api/email/:provider/disconnect', async (ctx) => {
    const user = requireUser(ctx);
    const ok = await email.disconnect(user.id, ctx.params.provider, { ip: clientIp(ctx.req) });
    ctx.json(200, { disconnected: ok });
  });

  /**
   * §17 — bounce and complaint ingestion.
   *
   * Two kinds of caller share this endpoint: an authenticated user (or their
   * automation) reporting a delivery result, and a provider webhook carrying
   * the shared secret. Both funnel into the same per-user suppression list
   * that every send checks first, so a bounced or complaining recipient is
   * never contacted again.
   */
  router.post('/api/email/events', async (ctx) => {
    const body = await ctx.body();
    const type = String(body.type || '').toLowerCase();
    if (type !== 'bounce' && type !== 'complaint') {
      throw err.validation('type must be "bounce" or "complaint".');
    }
    const recipient = normalizeEmail(body.email);
    if (!recipient) throw err.validation('A recipient email address is required.');

    const secret = config.webhook.secret;
    const provided = String(ctx.req.headers['x-nexora-webhook-secret'] || '');
    const webhook = Boolean(secret) && provided.length === secret.length
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ctx.user && !webhook) {
      throw err.unauthorized('A session or the webhook secret is required.');
    }

    // A logged-in caller only ever affects their own account. A webhook has no
    // user to trust, so it resolves the owners of the lead with that address.
    const userIds = ctx.user
      ? [ctx.user.id]
      : (await system.db.all(
          'SELECT DISTINCT user_id FROM leads WHERE email_public = ?', recipient
        )).map((r) => r.user_id);
    if (!userIds.length) throw err.notFound('Recipient');

    const provider = body.provider ? String(body.provider).slice(0, 60) : null;
    const hard = body.hard === undefined ? true : Boolean(body.hard);
    const reason = body.reason ? String(body.reason).slice(0, 200) : 'bounced';
    let suppressed = 0;
    let leadsUpdated = 0;

    for (const userId of userIds) {
      const record = type === 'complaint'
        ? await system.suppression.recordComplaint(userId, recipient, provider)
        : await system.suppression.recordBounce(userId, recipient, { hard, reason, provider });
      // A soft bounce is recorded in the audit trail but must not blacklist an
      // address that may simply have been temporarily full (§17).
      if (!record) continue;
      suppressed++;

      // §17/§29: a suppressed prospect is never contacted again, so the lead
      // is closed out in the same breath.
      const rows = await system.db.all(
        "SELECT id FROM leads WHERE user_id = ? AND email_public = ? AND status NOT IN ('suppressed', 'closed')",
        userId, recipient
      );
      for (const row of rows) {
        await system.leads.setStatus(row.id, 'suppressed', { error: type });
        leadsUpdated++;
      }
    }

    log.info(`email ${type} recorded`, { recipient, suppressed, leadsUpdated, webhook: webhook && !ctx.user });
    ctx.json(200, { ok: true, type, email: recipient, suppressed, leadsUpdated });
  }, { auth: false });
}

export { readJson };