import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../../src/config.js';
import { createTestSystem } from '../helpers/api.js';
import { seedUser, seedMission, STAGE } from '../helpers/harness.js';

/**
 * §10/§26 — the opportunistic automation driver. On a serverless host the Cron
 * may run only once a day, so request-driven ticks keep window-driven scouting
 * alive. The tick must really run the pipeline and must be throttled.
 */
test('automation: the opportunistic tick drains real work then throttles itself', async () => {
  const parts = await createTestSystem({
    config: {
      ...config,
      automation: { autoTick: true, autoTickIntervalMs: 60_000, autoTickMaxJobs: 5 },
    },
  });
  const { db, system } = parts;
  try {
    const user = await seedUser(db);
    const mission = await seedMission(db, user.id);
    await system.queue.enqueue({
      userId: user.id,
      missionId: mission.id,
      stage: STAGE.DISCOVERY,
      payload: { location: { country: 'US', city: 'Austin' }, limit: 5 },
      idempotencyKey: `auto:${mission.id}`,
    });

    const first = await system.opportunisticTick();
    assert.ok(first, 'the first tick runs');
    assert.ok(first.drained >= 1, 'it drains real queued work');

    const second = await system.opportunisticTick();
    assert.equal(second, null, 'a second tick within the interval is throttled');
  } finally {
    await db.close();
  }
});

test('opportunistic tick is entirely off when disabled', async () => {
  const parts = await createTestSystem({
    config: { ...config, automation: { autoTick: false, autoTickIntervalMs: 1000, autoTickMaxJobs: 5 } },
  });
  try {
    assert.equal(await parts.system.opportunisticTick(), null);
  } finally {
    await parts.db.close();
  }
});
