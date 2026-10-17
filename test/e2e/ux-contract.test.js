import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The single-page app is rendered by `public/app.js`, so there is no DOM to
 * inspect at runtime without a browser. These tests hold the frontend to the
 * contract the vision sets instead: every destination exists, every control is
 * wired to the real endpoint it claims, the layout carries the responsive and
 * reduced-motion rules §36 asks for, and nothing secret is shipped to the
 * browser (§38).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '../../public');
const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('ux: the navigation covers every area the vision suggests (spec 37)', () => {
  const nav = app.match(/const NAV = \[([\s\S]*?)\];/);
  assert.ok(nav, 'the navigation is declared in one place');
  const ids = [...nav[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const area of ['dashboard', 'missions', 'leads', 'inbox', 'email', 'activity', 'notifications', 'settings']) {
    assert.ok(ids.includes(area), `navigation is missing ${area}`);
  }
  // Every destination must be routed, or the nav item would render nothing.
  for (const area of ids) {
    assert.match(app, new RegExp(`case '${area}':`), `${area} has no route`);
  }
});

test('ux: the states the operator must see are distinguishable (spec 36)', () => {
  const tones = app.match(/const TONE = \{([\s\S]*?)\};/);
  assert.ok(tones, 'state tones are declared in one place');
  for (const state of [
    'running', 'paused', 'scheduled', 'failed', 'completed', 'queued',
    'awaiting_approval', 'reply_received', 'suppressed', 'archived',
  ]) {
    assert.match(tones[1], new RegExp(`\\b${state}:`), `no tone for the ${state} state`);
  }
});

test('ux: the autonomy controls are present and call the real endpoints (spec 26)', () => {
  const controls = [
    ['toggle-pause', '/api/auth/automation-paused'],
    ['mission-action', '/api/missions/${id}/${endpoint}'],
    ['mission-delete', '/api/missions/${el.dataset.id}'],
    ['retry-job', '/api/jobs/'],
    ['approve', '/api/messages/${el.dataset.id}/approve'],
    ['reject', '/api/messages/${el.dataset.id}/reject'],
    ['email-connect', '/api/email/${provider}/connect'],
    ['email-disconnect', '/api/email/${el.dataset.provider}/disconnect'],
    ['save-model', '/api/ai/settings'],
    ['gen-recovery', '/api/auth/recovery-code'],
  ];
  for (const [act, endpoint] of controls) {
    assert.ok(app.includes(`'${act}'`), `control ${act} is missing`);
    assert.ok(app.includes(endpoint), `${act} does not call ${endpoint}`);
  }
  // Every mission action in the map is one the API really exposes.
  const map = app.match(/const map = \{([^}]*)\}/);
  assert.ok(map, 'the mission action map exists');
  for (const action of ['activate', 'pause', 'resume', 'stop', 'run-now', 'duplicate']) {
    assert.match(map[1], new RegExp(`'?"?${action}'?:?\\s*'`), `mission action ${action} is not wired`);
  }
});

test('ux: the layout is responsive and respects reduced motion (spec 36)', () => {
  // Phone, tablet and laptop/desktop widths each get their own rules.
  for (const width of ['1100px', '980px', '760px']) {
    assert.match(css, new RegExp(`@media \\(max-width: ${width}\\)`), `no rules at ${width}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // A single source of truth for the palette keeps contrast consistent.
  for (const token of ['--bg', '--text', '--muted', '--faint', '--accent', '--line', '--line-strong']) {
    assert.ok(css.includes(`${token}:`), `design token ${token} is not defined`);
  }
});

test('ux: no secret ever reaches the browser (spec 38)', () => {
  const shipped = `${html}\n${app}`;
  for (const pattern of [
    /DATABASE_URL/i, /OPENCODE_API_KEY/i, /client_secret/i, /refresh_token_enc/i,
    /process\.env/i, /Bearer\s+[A-Za-z0-9._-]{20,}/,
  ]) {
    assert.equal(pattern.test(shipped), false, `the frontend must not contain ${pattern}`);
  }
  // Secrets are read server-side only, through the API.
  assert.ok(!app.includes('access_token'), 'the app never handles provider tokens itself');
});

test('ux: the shell is pre-rendered so the first paint is not blank', () => {
  assert.match(html, /<div id="splash"/);
  assert.match(html, /<div id="app"/);
  assert.match(html, /styles\.css/);
  assert.match(html, /app\.js/);
  assert.match(html, /rel="icon"/);
});