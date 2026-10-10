import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vercel evaluates `rewrites` in order and the first matching source wins, so
// the SPA catch-all `/((?!api/).*)` swallows any non-API path before it can
// reach the function. `/health` must therefore have its own rewrite placed
// before the catch-all, and the catch-all must exclude it — otherwise the
// liveness probe returns the SPA shell in production instead of JSON, even
// though src/http/server.js serves JSON for it locally.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
}

test('vercel.json routes /health to the function before the SPA fallback', () => {
  const cfg = loadConfig();
  const rewrites = cfg.rewrites || [];

  const healthIndex = rewrites.findIndex((r) => r.source === '/health');
  assert.notEqual(healthIndex, -1, 'vercel.json must rewrite /health');
  assert.match(rewrites[healthIndex].destination, /api\/index\.js$/);

  const fallbackIndex = rewrites.findIndex((r) => r.destination === '/index.html');
  assert.notEqual(fallbackIndex, -1, 'vercel.json must keep the SPA fallback rewrite');
  assert.ok(
    healthIndex < fallbackIndex,
    `the /health rewrite must come before the SPA fallback (got ${healthIndex} vs ${fallbackIndex})`,
  );

  const fallback = rewrites[fallbackIndex].source;
  assert.ok(
    fallback.includes('health'),
    `the SPA fallback source must exclude "health" so it cannot swallow the probe (got "${fallback}")`,
  );
});
