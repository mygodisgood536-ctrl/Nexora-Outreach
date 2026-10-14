import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from '../../src/db/index.js';
import { translate, countPlaceholders } from '../../src/db/dialect.js';
import { createSystem } from '../../src/system.js';
import {
  makeFakeAI, makeFakeEmail, SITE_HTML, seedUser, seedMission, connectMailbox,
} from '../helpers/harness.js';

/**
 * Production runs on PostgreSQL while the test suite runs on SQLite, so a
 * statement that is valid on SQLite can still fail on Postgres. These tests
 * translate every statement a full pipeline executes and assert the Postgres
 * translator accepts it — a guard against SQLite-only placeholder bugs.
 */

test('dialect: datetime(\'now\') is replaced only when it starts at the cursor', () => {
  // Regression: a non-anchored match fired at the `d` inside `updated_at` and
  // under-advanced the scan, which then swallowed a later `?`.
  const sql = "UPDATE t SET a=?, b=?, c=?, d=updated_at=datetime('now') WHERE id=?";
  assert.equal(countPlaceholders(sql), 4);
  const out = translate(sql, 'postgres', [1, 2, 3, 4]);
  assert.equal(out.params.length, 4);
  assert.match(out.sql, /WHERE id=\$4/);
  assert.match(out.sql, /now\(\) at time zone 'utc'/);
});

test('dialect: strings and identifiers are not scanned for placeholders', () => {
  const sql = "SELECT ? AS x, 'a?b' AS y, \"c?d\" AS z WHERE a = ?";
  assert.equal(countPlaceholders(sql), 2);
  const out = translate(sql, 'postgres', ['p', 'q']);
  assert.equal(out.sql, "SELECT $1 AS x, 'a?b' AS y, \"c?d\" AS z WHERE a = $2");
});

test('dialect: a placeholder/param mismatch is rejected loudly', () => {
  assert.throws(() => translate('SELECT ? , ?', 'postgres', [1]), /placeholder mismatch/i);
});

test('dialect: every statement in a full pipeline run is valid PostgreSQL', async () => {
  const real = await createTestDb();
  await real.migrate();
  const mismatches = [];
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'run' || prop === 'get' || prop === 'all') {
        return (sql, ...params) => {
          try { translate(sql, 'postgres', params); }
          catch (e) { mismatches.push(`${prop}: ${e.message} :: ${String(sql).replace(/\s+/g, ' ').trim()}`); throw e; }
          return target[prop](sql, ...params);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const ai = makeFakeAI();
  const email = makeFakeEmail(db);
  const research = {
    fetchUrl: async (url) => ({ url, status: 200, contentType: 'text/html', body: SITE_HTML, bytes: SITE_HTML.length }),
    checkLinks: async (html, url) => ({ checked: 2, brokenCount: 1, unreachableCount: 0, broken: [{ url: `${url}/x`, status: 404 }], unreachable: [], method: 'x' }),
    pagespeed: async (url) => ({ ok: true, strategy: 'mobile', finalUrl: url, scores: { performance: 40 }, vitals: {}, screenshot: { dataUri: 'data:image/png;base64,AAAA', width: 400, height: 800, bytes: 20, strategy: 'mobile' } }),
  };
  const discovery = {
    discover: async ({ city, country }) => ({
      source: 'test', area: `${city}, ${country}`,
      candidates: [{ name: `Biz ${city}`, website: 'https://test.example', email: 'hi@example.com', city, country, source: 'test', sourceUrl: 'https://x' }],
    }),
  };

  const system = createSystem({ db, overrides: { ai, services: { email, research, discovery } } });
  try {
    const user = await seedUser(real);
    const mission = await seedMission(real, user.id);
    await connectMailbox(real, user.id);

    await system.queue.enqueue({
      userId: user.id, missionId: mission.id, stage: 'discovery',
      payload: { location: { country: 'US', city: 'Austin' }, limit: 5 },
      idempotencyKey: 'dialect:1',
    });
    await system.worker.drain({ maxJobs: 50 });
    await system.scheduler.tick();

    assert.deepEqual(mismatches, [], `these statements would fail on PostgreSQL:\n${mismatches.join('\n')}`);
  } finally {
    await real.close();
  }
});
