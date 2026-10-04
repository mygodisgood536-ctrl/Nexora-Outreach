import { err } from '../../core/errors.js';
import {
  readJson, requireUser, clientIp,
  buildSessionCookie, clearSessionCookie, csrfTokenFor,
} from '../middleware.js';
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

  router.get('/api/auth/username-available', (ctx) => {
    ctx.json(200, auth.isUsernameAvailable(String(ctx.query.username || '')));
  }, PUBLIC);

  router.post('/api/auth/signup', async (ctx) => {
    const body = await ctx.body();
    const { userId, recoveryCode } = auth.signup({
      fullName: body.fullName,
      username: body.username,
      securityQuestion: body.securityQuestion,
      securityAnswer: body.securityAnswer,
      timezone: body.timezone || 'UTC',
      ip: clientIp(ctx.req),
    });
    // Issue a session so the new account lands authenticated.
    const session = auth.sessions.create(userId, {
      ip: clientIp(ctx.req), userAgent: ctx.req.headers['user-agent'] || null,
    });
    ctx.setCookie(buildSessionCookie(session.token, {
      maxAgeSeconds: config.sessionTtlHours * 3600,
    }));
    // Shown once, here, and never again — the server only keeps a hash.
    ctx.json(201, { user: auth.publicUser(userId), recoveryCode });
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
    const result = auth.recover({
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
  router.get('/api/auth/security-question', (ctx) => {
    const row = system.db.get(
      'SELECT security_question FROM users WHERE username_lower = ? AND deleted_at IS NULL',
      String(ctx.query.username || '').toLowerCase()
    );
    ctx.json(200, { securityQuestion: row?.security_question ?? null });
  }, PUBLIC);

  router.post('/api/auth/login', async (ctx) => {
    const body = await ctx.body();
    const result = auth.login({
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

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.token) auth.logout(ctx.token);
    ctx.setCookie(clearSessionCookie());
    ctx.json(200, { ok: true });
  });

  router.get('/api/auth/me', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      user,
      csrfToken: csrfTokenFor({ id: ctx.sessionRowId }),
      email: email.statusFor(user.id),
    });
  });

  router.patch('/api/auth/profile', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    ctx.json(200, {
      user: auth.updateProfile(user.id, { fullName: body.fullName, timezone: body.timezone }),
    });
  });

  /**
   * Issue a fresh one-time recovery code (spec §5.3).
   *
   * Without this a user who loses their recovery code can never regain access.
   * Issuing a new one also burns every previously issued code, so a code leaked
   * earlier stops working the moment the user rotates.
   */
  router.post('/api/auth/recovery-code', (ctx) => {
    const user = requireUser(ctx);
    system.db.run(
      "UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL",
      user.id
    );
    const recoveryCode = auth.issueRecoveryCode(user.id);
    log.info(`recovery code re-issued for user ${user.id}`);
    ctx.json(200, { recoveryCode });
  });

  router.post('/api/auth/automation-paused', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    ctx.json(200, { user: auth.setAutomationPaused(user.id, Boolean(body.paused)) });
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
      selection: aiRuntime.selection(user.id),
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
  router.get('/api/email/connections', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { providers: email.statusFor(user.id) });
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
    const { userId } = email.consumeState(provider, String(state));
    // Re-check the session so a callback cannot be finished by another user.
    if (!ctx.user || ctx.user.id !== userId) {
      throw err.unauthorized('Sign in again to finish connecting your mailbox.');
    }

    const connection = await email.completeAuth(userId, provider, {
      code: String(code),
      redirectUri: `${config.publicBaseUrl}/api/email/${provider}/callback`,
      ip: clientIp(ctx.req),
    });
    system.db.run(
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
}

export { readJson };