import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, seedUser, seedMission, connectMailbox, STAGE } from '../helpers/harness.js';
import { minutesInTz } from '../../src/core/time.js';

/** Monday 2026-02-09 at a given UTC time. */
const MONDAY = (utcHour, utcMinute = 0) =>
  new Date(Date.UTC(2026, 1, 9, utcHour, utcMinute));

function withMission(system, opts = {}) {
  const { db } = system;
  const user = seedUser(db, opts.user);
  const mission = seedMission(db, user.id, opts.mission);
  return { user, mission };
}

test('scheduler: nothing is scheduled outside the mission windows', () => {
  const { system } = setup();
  // Monday 10:00-13:00 UTC
  const { mission } = withMission(system, {
    mission: { windows: [{ dayOfWeek: 1, startMin: 600, endMin: 780 }] },
  });

  assert.equal(system.scheduler.dueMissions(MONDAY(8)).length, 0, 'before the window');
  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 1, 'inside the window');
  assert.equal(system.scheduler.dueMissions(MONDAY(14)).length, 0, 'after the window');
  assert.equal(system.scheduler.tick(MONDAY(11)).length, 1);
  assert.equal(system.scheduler.tick(MONDAY(14)).length, 0);
  assert.ok(mission.id);
});

test('scheduler: multiple windows on the same day are honoured', () => {
  const { system } = setup();
  withMission(system, {
    mission: {
      windows: [
        { dayOfWeek: 1, startMin: 600, endMin: 780 },    // 10:00-13:00
        { dayOfWeek: 1, startMin: 1020, endMin: 1200 },  // 17:00-20:00
      ],
    },
  });

  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 1, 'morning window');
  assert.equal(system.scheduler.dueMissions(MONDAY(18)).length, 1, 'evening window');
  assert.equal(system.scheduler.dueMissions(MONDAY(15)).length, 0, 'between windows');
});

test('scheduler: the mission timezone, not the server, decides (spec 10)', () => {
  const { system } = setup();
  // 14:00-18:00 Africa/Lagos (UTC+1) == 13:00-17:00 UTC.
  withMission(system, {
    mission: {
      timezone: 'Africa/Lagos',
      windows: [{ dayOfWeek: 1, startMin: 14 * 60, endMin: 18 * 60 }],
    },
  });

  assert.equal(system.scheduler.dueMissions(MONDAY(12)).length, 0, '12:00 UTC is 13:00 Lagos');
  assert.equal(system.scheduler.dueMissions(MONDAY(13)).length, 1, '13:00 UTC is 14:00 Lagos');
  assert.equal(system.scheduler.dueMissions(MONDAY(16, 59)).length, 1, '16:59 UTC is 17:59 Lagos');
  assert.equal(system.scheduler.dueMissions(MONDAY(17)).length, 0, '17:00 UTC is 18:00 Lagos — window end is exclusive');
  assert.equal(system.scheduler.dueMissions(MONDAY(18)).length, 0, '18:00 UTC is 19:00 Lagos');
});

test('scheduler: timezone conversion is exercised directly', () => {
  // 13:00 UTC on a Monday is 14:00 in Lagos (UTC+1).
  const lagos = minutesInTz(new Date(Date.UTC(2026, 1, 9, 13, 30)), 'Africa/Lagos');
  assert.equal(lagos.minutes, 14 * 60 + 30);
  assert.equal(lagos.dayOfWeek, 1);
});

test('scheduler: paused, stopped and archived missions are never scheduled', () => {
  const { system, db } = setup();
  const { user, mission } = withMission(system);

  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 1);

  for (const status of ['paused', 'stopped', 'archived', 'draft']) {
    db.run('UPDATE missions SET status = ? WHERE id = ?', status, mission.id);
    assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 0, `${status} must not schedule`);
  }
  db.run('UPDATE missions SET status = ? WHERE id = ?', 'scheduled', mission.id);
  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 1);
  assert.ok(user.id);
});

test('scheduler: Pause All Automation suppresses every mission', () => {
  const { system, db } = setup();
  const { user } = withMission(system);
  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 1);

  db.run('UPDATE users SET automation_paused = 1 WHERE id = ?', user.id);
  assert.equal(system.scheduler.dueMissions(MONDAY(11)).length, 0);
});

test('scheduler: a window is never started twice (spec 10)', () => {
  const { system, db } = setup();
  withMission(system);

  const first = system.scheduler.tick(MONDAY(11));
  assert.equal(first.length, 1);
  assert.equal(first[0].enqueued, 1);

  // Repeated ticks inside the same window must not enqueue again.
  assert.equal(system.scheduler.tick(MONDAY(11)).length, 0);
  assert.equal(system.scheduler.tick(MONDAY(11, 30)).length, 0);
  assert.equal(db.all("SELECT * FROM automation_jobs WHERE stage = 'discovery'").length, 1);
});

test('scheduler: each target country gets its own discovery job', () => {
  const { system, db } = setup();
  withMission(system, {
    mission: {
      locations: [
        { country: 'US', city: 'Austin', priority: 'high' },
        { country: 'DE', city: 'Berlin', priority: 'medium' },
      ],
    },
  });

  const result = system.scheduler.tick(MONDAY(11));
  assert.equal(result[0].enqueued, 2);
  const jobs = db.all("SELECT * FROM automation_jobs WHERE stage = 'discovery'");
  assert.equal(jobs.length, 2);
  const countries = jobs.map((j) => JSON.parse(j.payload).location.country).sort();
  assert.deepEqual(countries, ['DE', 'US']);
});

test('scheduler: scheduled jobs actually run through the pipeline', async () => {
  const { system, email } = setup();
  const { user } = withMission(system);
  connectMailbox(system.db, user.id);   // outreach needs an authorized mailbox
  system.scheduler.tick(MONDAY(11));
  await system.worker.drain();

  assert.equal(system.leads.list(user.id).length, 1, 'the scheduled run produced a real lead');
  assert.equal(email.sent.length, 1, 'and completed the pipeline');
});

test('scheduler: without a mailbox the run stops at outreach instead of sending', async () => {
  const { system, email } = setup();
  const { user } = withMission(system);
  system.scheduler.tick(MONDAY(11));
  await system.worker.drain();

  assert.equal(system.leads.list(user.id).length, 1, 'discovery and research still completed');
  assert.equal(email.sent.length, 0, 'nothing is sent without an authorized mailbox');
  const outreachJob = system.db.get("SELECT * FROM automation_jobs WHERE stage = 'outreach'");
  assert.equal(outreachJob.status, 'failed');
  assert.match(outreachJob.last_error, /mailbox/i);
});

test('scheduler: next_run_at is refreshed for the UI', () => {
  const { system, db } = setup();
  const { mission } = withMission(system);
  system.scheduler.tick(MONDAY(11));
  const next = db.get('SELECT next_run_at FROM missions WHERE id = ?', mission.id).next_run_at;
  assert.ok(next, 'next scouting session is recorded');
});