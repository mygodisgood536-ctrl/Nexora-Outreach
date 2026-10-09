import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AppError, err } from '../core/errors.js';
import { Router } from './router.js';
import {
  parseCookies, readJson, csrfTokenFor, clientIp,
} from './middleware.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerSystemRoutes } from './routes/system.js';
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
  return tuneKeepAlive(http.createServer(createHandler(system)));
}

/**
 * The request listener on its own, with no socket attached.
 *
 * Serverless runtimes (Vercel) and tests both want the raw `(req, res)`
 * function; `createServer` is only the local/socket wrapper around it.
 */
export function createHandler(system) {
  const router = new Router();
  registerAccountRoutes(router, system);
  registerWorkspaceRoutes(router, system);
  registerSystemRoutes(router, system);

  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.sessionCookieName] || null;

    let user = null;
    let sessionRowId = null;
    if (token) {
      const row = await system.auth.sessions.findValid(token);
      if (row) {
        sessionRowId = row.id;
        await system.auth.sessions.touch(row.id);
        user = await system.auth.publicUser(row.user_id);
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
      // Liveness probe stays a tiny JSON payload, never the SPA shell.
      if (pathname === '/health') {
        return ctx.json(200, { ok: true, service: 'nexora-outreach' });
      }
      if (!pathname.startsWith('/api/')) {
        // The front end is a static app; unknown non-file paths fall back to
        // its shell so client-side routes survive a refresh.
        if (await serveStatic(req, res, pathname)) return;
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
  };
}

/** Extensions the static app is allowed to serve, mapped to their MIME type. */
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * Serves the single-page app from `public/`.
 *
 * Only GET/HEAD are honoured. Anything that looks like a file but is missing
 * returns false (a real 404); extension-less paths fall back to the shell so
 * client-side routes can be deep-linked. Path traversal is impossible because
 * the resolved path must stay inside `public/`.
 */
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const root = path.resolve(config.root, 'public');
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return false; }
  if (rel === '' || rel === '/') rel = 'index.html';

  const candidate = path.resolve(root, rel);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return false;

  let file = candidate;
  try {
    if ((await fs.promises.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    if (path.extname(rel)) return false; // a missing asset is a genuine 404
    file = path.join(root, 'index.html'); // otherwise: client-side route
  }

  try {
    const body = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
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

/**
 * Keep-alive must outlive a client's stale-socket check.
 *
 * Node's default is 5s, while the fetch client only validates idle sockets
 * every 30s — so a request issued between 5s and 30s of idleness rides a socket
 * the server already closed and dies with ECONNRESET (especially visible on
 * Windows). Holding sockets for longer than that check window removes the race
 * without keeping them open unbounded.
 */
function tuneKeepAlive(server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

export default createServer;
export { err };