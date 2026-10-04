import crypto from 'node:crypto';
import { AppError, err } from '../core/errors.js';
import config from '../config.js';

const MAX_BODY_BYTES = 1024 * 512;   // 512 KB is plenty for this API

/** Parse cookies from a Cookie header. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * CSRF token derived from the session id with a server-side key. No storage is
 * needed and the token cannot be forged without the key.
 */
export function csrfTokenFor(sessionRow) {
  return crypto
    .createHmac('sha256', config.tokenEncryptionKey)
    .update(`csrf:${sessionRow.id}`)
    .digest('base64url');
}

export function buildSessionCookie(token, { maxAgeSeconds }) {
  const bits = [
    `${config.sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (config.isProd) bits.push('Secure');
  if (maxAgeSeconds !== undefined) bits.push(`Max-Age=${maxAgeSeconds}`);
  return bits.join('; ');
}

export function clearSessionCookie() {
  return buildSessionCookie('', { maxAgeSeconds: 0 });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(err.validation('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const raw = await readBody(req);
  if (!raw.length) return {};
  const type = String(req.headers['content-type'] || '');
  if (type && !type.includes('application/json')) {
    throw err.validation('Expected application/json.');
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw err.validation('Request body must be a JSON object.');
    }
    return parsed;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw err.validation('Request body is not valid JSON.');
  }
}

/**
 * Resolves the caller's session, or throws 401.
 * Every protected route runs through this, so no handler can forget to check.
 */
export function requireUser(ctx) {
  if (!ctx.user) throw err.unauthorized('Sign in to continue.');
  return ctx.user;
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export { crypto };