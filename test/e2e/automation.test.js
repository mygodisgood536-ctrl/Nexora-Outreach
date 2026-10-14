import test from 'node:test';
import assert from 'node:assert/strict';

// Read when config is imported; node:test isolates each file in its own process.
process.env.CRON_SECRET = 'automation-status-secret';

const { startTestServer, createClient } = await import('../helpers/api.js');
const { seedMission } = await import('../helpers/harness.js');

async function withServer(fn) {
  const ctx = await startTestServer();
  try { return await fn(ctx); } finally { await ctx.close(); }
}

test('health reports automation configuration without leaking secrets', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.automation.cronConfigured, true);
    assert.equal(typeof body.automation.autoTick, 'boolean');
    assert.equal('secret' in body.automation, false, 'never leaks the cron secret');
  });
});

test('automation status proves the worker state to the signed-in owner', async () => {
  await withServer(async ({ base, system }) => {
    const client = createClient(base);
    const { created, me } = await client.signupAndLogin({
      fullName: 'Auto Owner', username: `auto_${Date.now()}`,
      securityQuestion: 'City?', securityAnswer: 'Lagos', timezone: 'UTC',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await seedMission(system.db, me.body.user.id);

    const status = await client.get('/api/automation/status');
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(typeof status.body.cron.configured, 'boolean');
    assert.equal(status.body.runningMissions, 1);
    assert.ok(status.body.queue, 'queue depth is reported');
    assert.ok(status.body.worker.workerId, 'the worker identity is reported');
    assert.equal(status.body.connectedMailbox, false);
  });
});

test('a cron tick is recorded so its execution is provable afterwards', async () => {
  await withServer(async ({ base }) => {
    const before = await (await fetch(`${base}/api/health`)).json();
    assert.equal(before.automation.lastRunAt, null, 'no run yet');

    const tick = await fetch(`${base}/api/cron/tick`, {
      headers: { Authorization: 'Bearer automation-status-secret' },
    });
    assert.equal(tick.status, 200);

    const after = await (await fetch(`${base}/api/health`)).json();
    assert.ok(after.automation.lastRunAt, 'the run is now observable');
  });
});
