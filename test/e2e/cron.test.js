import test from 'node:test';
import assert from 'node:assert/strict';

// config.cron.secret is read when config is imported, and node:test isolates
// each file in its own process — so set it before the dynamic import.
process.env.CRON_SECRET = 'cron-test-secret';

const { startTestServer } = await import('../helpers/api.js');
const { seedUser, seedMission, STAGE } = await import('../helpers/harness.js');

async function withServer(fn) {
  const ctx = await startTestServer();
  try { return await fn(ctx); } finally { await ctx.close(); }
}

test('cron: rejects a tick without the shared secret', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/cron/tick`);
    assert.equal(res.status, 401);
    const bad = await fetch(`${base}/api/cron/tick`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
  });
});

test('cron: an authenticated tick advances the scheduler and drains jobs', async () => {
  await withServer(async ({ base, system }) => {
    const { db } = system;
    const user = await seedUser(db);
    const mission = await seedMission(db, user.id);

    await system.queue.enqueue({
      userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
      payload: { location: { country: 'US', city: 'Austin' }, limit: 5 },
      idempotencyKey: `test:cron:${mission.id}`,
    });

    const res = await fetch(`${base}/api/cron/tick`, {
      headers: { Authorization: 'Bearer cron-test-secret' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.drained >= 1, 'a queued discovery job should have been drained');

    // The job really ran through the real pipeline against the fake discovery.
    const job = await db.get('SELECT status FROM automation_jobs WHERE mission_id = ?', mission.id);
    assert.equal(job.status, 'succeeded');
  });
});

test('cron: the same tick is safe to run twice (idempotent discoveries)', async () => {
  await withServer(async ({ base, system }) => {
    const { db } = system;
    const user = await seedUser(db);
    const mission = await seedMission(db, user.id);
    await system.queue.enqueue({
      userId: user.id, missionId: mission.id, stage: STAGE.DISCOVERY,
      payload: { location: { country: 'US', city: 'Austin' }, limit: 5 },
      idempotencyKey: `test:cron2:${mission.id}`,
    });
    const headers = { Authorization: 'Bearer cron-test-secret' };
    await fetch(`${base}/api/cron/tick`, { headers });
    const second = await fetch(`${base}/api/cron/tick`, { headers });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).ok, true);
  });
});

test('static: the single-page app and its assets are served, deep links fall back', async () => {
  await withServer(async ({ base }) => {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(await root.text(), /<div id="app"/);

    const js = await fetch(base + '/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const css = await fetch(base + '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    // An unknown client-side route serves the shell, not a 404.
    const deep = await fetch(base + '/missions/42');
    assert.equal(deep.status, 200);
    assert.match(deep.headers.get('content-type'), /text\/html/);

    // A missing asset is still a genuine 404.
    const missing = await fetch(base + '/nope.js');
    assert.equal(missing.status, 404);

    // /health stays JSON.
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'nexora-outreach');
  });
});