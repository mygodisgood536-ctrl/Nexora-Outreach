import http from 'node:http';
import { AppError, err } from '../core/errors.js';
import { Router } from './router.js';
import {
  parseCookies, readJson, csrfTokenFor, clientIp,
} from './middleware.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import config from '../config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('http');

/**
 * Builds the HTTP server around an existing system.
 *
 * The server never reaches into the database directly for business rules; it
 * resolves the session, enforces auth and CSRF, then delegates to the same
 * services the worker pipeline uses.
 */
export function createServer(system) {
  const router = new Router();
  registerAccountRoutes(router, system);
  registerWorkspaceRoutes(router, system);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.sessionCookieName] || null;

    let user = null;
    let sessionRowId = null;
    if (token) {
      const row = system.auth.sessions.findValid(token);
      if (row) {
        sessionRowId = row.id;
        system.auth.sessions.touch(row.id);
        user = system.auth.publicUser(row.user_id);
      }
    }

    const setCookies = [];
    const ctx = {
      req,
      res,
      user,
      token,
      sessionRowId,
      query: Object.fromEntries(url.searchParams.entries()),
      params: {},
      setCookie: (value) => setCookies.push(value),
      body: () => readJson(req),
      json: (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
        });
        res.end(text);
      },
    };

    try {
      if (pathname === '/' || pathname === '/health') {
        return ctx.json(200, { ok: true, service: 'nexora-outreach' });
      }
      if (!pathname.startsWith('/api/')) {
        return ctx.json(404, { error: 'NOT_FOUND', message: 'Unknown endpoint.' });
      }

      const match = router.match(req.method, pathname);
      if (!match) return ctx.json(404, { error: 'NOT_FOUND', message: 'Unknown endpoint.' });
      if (match.allowed) {
        res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
        return ctx.json(405, { error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed for this endpoint.' });
      }

      ctx.params = match.params;
      const { route } = match;

      // Auth first, so an unauthenticated caller learns nothing about the route.
      if (route.auth && !ctx.user) {
        return ctx.json(401, { error: 'UNAUTHENTICATED', message: 'Sign in to continue.' });
      }

      // CSRF: a state-changing request must echo the session CSRF token.
      if (route.csrf && ctx.user) {
        const supplied = String(req.headers['x-csrf-token'] || '');
        const expected = csrfTokenFor({ id: sessionRowId });
        if (!supplied || !timingSafeEqual(supplied, expected)) {
          return ctx.json(403, { error: 'CSRF_FAILED', message: 'Missing or invalid CSRF token.' });
        }
      }

      await route.handler(ctx);
      if (!res.writableEnded) ctx.json(204, null);
    } catch (e) {
      handleError(ctx, e);
    }
  });

  return server;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Structured error responses with sensible status codes (§30). */
function handleError(ctx, error) {
  const ip = clientIp(ctx.req);
  if (error instanceof AppError) {
    if (error.status >= 500) log.error(`${error.code}: ${error.message}`, { ip });
    const payload = { error: error.code, message: error.message };
    if (error.detail) payload.detail = error.detail;
    return ctx.json(error.status, payload);
  }
  log.error('unhandled request error', { message: error?.message, ip });
  // Never leak internals to the client.
  return ctx.json(500, { error: 'INTERNAL_ERROR', message: 'Something went wrong handling that request.' });
}

export default createServer;
export { err };