import http from 'node:http';
import { createTestDb } from '../../src/db/index.js';
import { createSystem } from '../../src/system.js';
import { createServer } from '../../src/http/server.js';
import { start } from '../../src/app.js';
import { makeFakeAI, makeFakeEmail } from './harness.js';

/**
 * Spins up the real HTTP server against an in-memory database with only the
 * outbound boundaries (AI, email, HTTP/discovery) replaced.
 *
 * The router, session handling, CSRF checks, ownership checks and every
 * service underneath are the real implementations.
 */
export async function startTestServer(options = {}) {
  const parts = await createTestSystem(options);
  const { db, system, ai, email, discovery } = parts;
  const server = createServer(system);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    db, system, server, ai, email, port, discovery,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

/**
 * Build the system and its fakes WITHOUT opening a listener.
 *
 * Kept separate from serving so `startTestApp` can hand the system to the real
 * `src/app.js` entry point, which creates the one and only HTTP listener.
 * Opening two listeners on one system would keep the test process alive.
 */
export async function createTestSystem(options = {}) {
  const db = await createTestDb();
  // The async database layer applies the schema explicitly; every test system
  // must start against a migrated database (migrate() is idempotent).
  await db.migrate();
  const ai = makeFakeAI(options.aiOverrides || {});
  const email = makeFakeEmail(db);
  Object.assign(email.state, options.emailState || {});

  const research = {
    fetchUrl: async (url) => ({
      url, status: 200, contentType: 'text/html',
      body: `<!DOCTYPE html><html><head><title>Site</title></head><body><h1>Hi</h1>
        <p>${'content '.repeat(80)}</p><a href="mailto:hi@example.com">mail</a></body></html>`,
      bytes: 120,
    }),
  };
  // Discovery returns one candidate per requested location, in that location.
  // `discovery.calls` records exactly what the pipeline asked for, so a test
  // can prove geographic filtering rather than infer it from the results.
  const calls = [];
  const discovery = {
    calls,
    discover: async ({ country, city, types, limit }) => {
      calls.push({ country, city, types: types.map((t) => t.key), limit });
      const where = city ? `${city}, ${country}` : country;
      // Each call returns a distinct business, so a second run discovers new
      // leads instead of hitting the duplicate guard.
      const n = calls.length;
      return {
        source: 'test', area: where,
        candidates: [{
          name: `Test Biz ${where} #${n}`, website: `https://test-${n}.example`,
          email: `hi+${n}@${String(country).toLowerCase()}.example`,
          city: city || null, country, source: 'test', sourceUrl: 'https://example.org/x',
        }],
      };
    },
  };

  const system = createSystem({
    db, config: options.config,
    overrides: { ai, services: { email, research, discovery } },
  });
  return { db, system, ai, email, discovery };
}

/**
 * Boot the REAL application entry point (src/app.js) â€” API, scheduler and
 * worker together â€” against an in-memory database, so `npm start`'s real
 * startup and shutdown paths are covered rather than assumed.
 */
export async function startTestApp() {
  const parts = await createTestSystem();
  const app = await start({ system: parts.system, cfg: { port: 0 } });
  // Capture the address now: once the app stops, `server.address()` is null.
  const { port } = app.server.address();
  return {
    ...parts,
    app,
    server: app.server,
    port,
    base: `http://127.0.0.1:${port}`,
  };
}

/** Attach an authorized mailbox so the pipeline can reach the email stage. */
export async function connectMailbox(db, userId, provider = 'google') {
  const { lastInsertRowid } = await db.run(
    `INSERT INTO email_connections(user_id, provider, account_email, access_token_enc, status, updated_at)
     VALUES(?,?,?, 'v1:a:b:c', 'connected', datetime('now'))`,
    userId, provider, `${provider}@example.com`
  );
  return lastInsertRowid;
}

/** Minimal cookie-jar client so session behaviour is exercised for real. */
export function createClient(base) {
  const jar = new Map();
  let csrf = null;

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorb(res) {
    const raw = res.headers.getSetCookie?.() || [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function call(method, path, body, { withCsrf = true, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (jar.size) init.headers.Cookie = cookieHeader();
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (method !== 'GET' && withCsrf && csrf) init.headers['X-CSRF-Token'] = csrf;

    const res = await fetch(`${base}${path}`, init);
    absorb(res);
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    jar,
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    setCsrf: (t) => { csrf = t; },
    clearCsrf: () => { csrf = null; },
    /** Sign up, then fetch and store the CSRF token for later writes. */
    async signupAndLogin(account) {
      const created = await this.post('/api/auth/signup', account);
      const me = await this.get('/api/auth/me');
      csrf = me.body?.csrfToken ?? null;
      return { created, me };
    },
  };
}