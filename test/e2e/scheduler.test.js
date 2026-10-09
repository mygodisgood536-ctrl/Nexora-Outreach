import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';
import { minutesInTz, sqliteUtc } from '../../src/core/time.js';

/** Monday 2026-02-09 at a given UTC time. */
const MONDAY = (utcHour, utcMinute = 0) =>
  new Date(Date.UTC(2026, 1, 9, utcHour, utcMinute));

async function withMission(system, opts = {}) {
  const { db } = system;
  const user = await seedUser(db, opts.user);
  const mission = await seedMission(db, user.id, opts.mission);
  return { user, mission };
}

test('scheduler: nothing is scheduled outside the mission windows', async () => {
  const { system } = await setup();
  // Monday 10:00-13:00 UTC
  const { mission } = await withMission(system, {
    mission: { windows: [{ dayOfWeek: 1, startMin: 600, endMin: 780 }] },
  });

  assert.equal((await system.scheduler.dueMissions(MONDAY(8))).length, 0, 'before the window');
  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 1, 'inside the window');
  assert.equal((await system.scheduler.dueMissions(MONDAY(14))).length, 0, 'after the window');
  assert.equal((await system.scheduler.tick(MONDAY(11))).length, 1);
  assert.equal((await system.scheduler.tick(MONDAY(14))).length, 0);
  assert.ok(mission.id);
});

test('scheduler: multiple windows on the same day are honoured', async () => {
  const { system } = await setup();
  await withMission(system, {
    mission: {
      windows: [
        { dayOfWeek: 1, startMin: 600, endMin: 780 },    // 10:00-13:00
        { dayOfWeek: 1, startMin: 1020, endMin: 1200 },  // 17:00-20:00
      ],
    },
  });

  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 1, 'morning window');
  assert.equal((await system.scheduler.dueMissions(MONDAY(18))).length, 1, 'evening window');
  assert.equal((await system.scheduler.dueMissions(MONDAY(15))).length, 0, 'between windows');
});

test('scheduler: the mission timezone, not the server, decides (spec 10)', async () => {
  const { system } = await setup();
  // 14:00-18:00 Africa/Lagos (UTC+1) == 13:00-17:00 UTC.
  await withMission(system, {
    mission: {
      timezone: 'Africa/Lagos',
      windows: [{ dayOfWeek: 1, startMin: 14 * 60, endMin: 18 * 60 }],
    },
  });

  assert.equal((await system.scheduler.dueMissions(MONDAY(12))).length, 0, '12:00 UTC is 13:00 Lagos');
  assert.equal((await system.scheduler.dueMissions(MONDAY(13))).length, 1, '13:00 UTC is 14:00 Lagos');
  assert.equal((await system.scheduler.dueMissions(MONDAY(16, 59))).length, 1, '16:59 UTC is 17:59 Lagos');
  assert.equal((await system.scheduler.dueMissions(MONDAY(17))).length, 0, '17:00 UTC is 18:00 Lagos â€” window end is exclusive');
  assert.equal((await system.scheduler.dueMissions(MONDAY(18))).length, 0, '18:00 UTC is 19:00 Lagos');
});

test('scheduler: timezone conversion is exercised directly', () => {
  // 13:00 UTC on a Monday is 14:00 in Lagos (UTC+1).
  const lagos = minutesInTz(new Date(Date.UTC(2026, 1, 9, 13, 30)), 'Africa/Lagos');
  assert.equal(lagos.minutes, 14 * 60 + 30);
  assert.equal(lagos.dayOfWeek, 1);
});

test('scheduler: paused, stopped and archived missions are never scheduled', async () => {
  const { system, db } = await setup();
  const { user, mission } = await withMission(system);

  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 1);

  for (const status of ['paused', 'stopped', 'archived', 'draft']) {
    await db.run('UPDATE missions SET status = ? WHERE id = ?', status, mission.id);
    assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 0, `${status} must not schedule`);
  }
  await db.run('UPDATE missions SET status = ? WHERE id = ?', 'scheduled', mission.id);
  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 1);
  assert.ok(user.id);
});

test('scheduler: Pause All Automation suppresses every mission', async () => {
  const { system, db } = await setup();
  const { user } = await withMission(system);
  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 1);

  await db.run('UPDATE users SET automation_paused = 1 WHERE id = ?', user.id);
  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 0);
});

test('scheduler: a window is never started twice (spec 10)', async () => {
  const { system, db } = await setup();
  await withMission(system);

  const first = await system.scheduler.tick(MONDAY(11));
  assert.equal(first.length, 1);
  assert.equal(first[0].enqueued, 1);

  // Repeated ticks inside the same window must not enqueue again.
  assert.equal((await system.scheduler.tick(MONDAY(11))).length, 0);
  assert.equal((await system.scheduler.tick(MONDAY(11, 30))).length, 0);
  assert.equal((await db.all("SELECT * FROM automation_jobs WHERE stage = 'discovery'")).length, 1);
});

test('scheduler: each target country gets its own discovery job', async () => {
  const { system, db } = await setup();
  await withMission(system, {
    mission: {
      locations: [
        { country: 'US', city: 'Austin', priority: 'high' },
        { country: 'DE', city: 'Berlin', priority: 'medium' },
      ],
    },
  });

  const result = await system.scheduler.tick(MONDAY(11));
  assert.equal(result[0].enqueued, 2);
  const jobs = await db.all("SELECT * FROM automation_jobs WHERE stage = 'discovery'");
  assert.equal(jobs.length, 2);
  const countries = jobs.map((j) => JSON.parse(j.payload).location.country).sort();
  assert.deepEqual(countries, ['DE', 'US']);
});

test('scheduler: scheduled jobs actually run through the pipeline', async () => {
  const { system, email } = await setup();
  const { user } = await withMission(system);
  await connectMailbox(system.db, user.id);   // outreach needs an authorized mailbox
  await system.scheduler.tick(MONDAY(11));
  await system.worker.drain();

  assert.equal((await system.leads.list(user.id)).length, 1, 'the scheduled run produced a real lead');
  assert.equal(email.sent.length, 1, 'and completed the pipeline');
});

test('scheduler: without a mailbox the run stops at outreach instead of sending', async () => {
  const { system, email } = await setup();
  const { user } = await withMission(system);
  await system.scheduler.tick(MONDAY(11));
  await system.worker.drain();

  assert.equal((await system.leads.list(user.id)).length, 1, 'discovery and research still completed');
  assert.equal(email.sent.length, 0, 'nothing is sent without an authorized mailbox');
  const outreachJob = await system.db.get("SELECT * FROM automation_jobs WHERE stage = 'outreach'");
  assert.equal(outreachJob.status, 'failed');
  assert.match(outreachJob.last_error, /mailbox/i);
});

test('scheduler: next_run_at is refreshed for the UI', async () => {
  const { system, db } = await setup();
  const { mission } = await withMission(system);
  await system.scheduler.tick(MONDAY(11));
  const next = (await db.get('SELECT next_run_at FROM missions WHERE id = ?', mission.id)).next_run_at;
  assert.ok(next, 'next scouting session is recorded');
});

test('scheduler: a due follow-up is enqueued once and actually sends (spec 19)', async () => {
  const { system, email, db } = await setup();
  const { user } = await withMission(system);
  await connectMailbox(db, user.id);
  await system.scheduler.tick(MONDAY(11));
  await system.worker.drain();
  assert.equal(email.sent.length, 1, 'the initial message went out');

  const followUp = await db.get("SELECT * FROM follow_ups WHERE status = 'pending'");
  assert.ok(followUp, 'the initial message scheduled a follow-up');

  // Still two days away: nothing to do.
  assert.equal((await system.scheduler.scheduleFollowUps(MONDAY(11))).enqueued, 0, 'not due yet');

  await db.run(
    'UPDATE follow_ups SET due_at = ? WHERE id = ?',
    sqliteUtc(new Date(Date.UTC(2026, 1, 9, 10, 30))), followUp.id,
  );
  assert.equal((await system.scheduler.scheduleFollowUps(MONDAY(11))).enqueued, 1, 'due now');
  assert.equal(
    (await system.scheduler.scheduleFollowUps(MONDAY(11, 30))).enqueued, 0,
    'a second pass absorbs the replay',
  );
  assert.equal(
    (await db.all("SELECT * FROM automation_jobs WHERE stage = 'follow_up'")).length, 1,
    'exactly one job exists',
  );

  await system.worker.drain();
  assert.equal(email.sent.length, 2, 'the follow-up went out');
  assert.equal(
    (await db.get('SELECT status FROM follow_ups WHERE id = ?', followUp.id)).status, 'sent',
    'the follow-up row is closed',
  );
});

test('scheduler: Pause All Automation queues no follow-ups or monitoring', async () => {
  const { system, db } = await setup();
  const { user, mission } = await withMission(system);
  await connectMailbox(db, user.id);
  await system.scheduler.tick(MONDAY(11));
  await system.worker.drain();

  await db.run("UPDATE follow_ups SET due_at = '2026-02-09 00:00:00'");
  await db.run('UPDATE users SET automation_paused = 1 WHERE id = ?', user.id);

  assert.equal((await system.scheduler.scheduleFollowUps(MONDAY(11))).enqueued, 0);
  assert.equal((await system.scheduler.scheduleMailboxMonitors(MONDAY(11))).enqueued, 0);
  assert.equal((await system.scheduler.dueMissions(MONDAY(11))).length, 0);
  assert.ok(mission.id);
});

test('scheduler: mailbox monitoring polls every 15 minutes (spec 18)', async () => {
  const { system, email, db } = await setup();
  const { user } = await withMission(system);
  await connectMailbox(db, user.id);
  await system.scheduler.tick(MONDAY(11));
  await system.worker.drain();
  assert.equal(email.sent.length, 1, 'a message is in flight');

  const at = MONDAY(11, 30);
  assert.equal((await system.scheduler.scheduleMailboxMonitors(at)).enqueued, 1, 'first poll');
  assert.equal(
    (await system.scheduler.scheduleMailboxMonitors(new Date(at.getTime() + 60_000))).enqueued, 0,
    'the same 15-minute slot never polls twice',
  );
  assert.equal(
    (await system.scheduler.scheduleMailboxMonitors(new Date(at.getTime() + 16 * 60_000))).enqueued, 1,
    'a new slot polls again',
  );
  assert.equal(
    (await db.all("SELECT * FROM automation_jobs WHERE stage = 'mailbox_monitor'")).length, 2,
    'one job per slot',
  );

  await system.worker.drain();
  const done = await db.all(
    "SELECT * FROM automation_jobs WHERE stage = 'mailbox_monitor' AND status = 'succeeded'",
  );
  assert.equal(done.length, 2, 'the monitor jobs run cleanly');
});

test('scheduler: a mailbox with nothing sent is never polled', async () => {
  const { system, db } = await setup();
  const { user } = await withMission(system);
  await connectMailbox(db, user.id);

  assert.equal(
    (await system.scheduler.scheduleMailboxMonitors(MONDAY(11))).enqueued, 0,
    'no outreach in flight means no replies to detect',
  );
  assert.equal((await db.all("SELECT * FROM automation_jobs WHERE stage = 'mailbox_monitor'")).length, 0);
  assert.ok(user.id);
});
