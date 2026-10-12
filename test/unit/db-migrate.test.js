import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, SCHEMA_VERSION } from '../../src/db/index.js';

const LIMIT_COLUMNS = ['hourly_send_limit', 'min_seconds_between_sends', 'campaign_start_at', 'campaign_end_at'];

test('migrate: a legacy sqlite database is upgraded in place and marked current', async () => {
  const db = await createTestDb();
  // Simulate a pre-v5 database: missions exists without the new limit columns.
  await db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES('schema_version', '4');
    CREATE TABLE missions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT,
                          service TEXT, status TEXT, sending_mode TEXT);`);

  const changed = await db.migrate();
  assert.equal(changed, true);

  const cols = (await db.all('PRAGMA table_info(missions)')).map((c) => c.name);
  for (const column of LIMIT_COLUMNS) assert.ok(cols.includes(column), `missing ${column}`);

  const row = await db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  assert.equal(row.value, SCHEMA_VERSION);

  // A second migrate is a no-op (columns already present, version current).
  assert.equal(await db.migrate(), false);
});

test('migrate: a fresh sqlite database already has the limit columns', async () => {
  const db = await createTestDb();
  await db.migrate();
  const cols = (await db.all('PRAGMA table_info(missions)')).map((c) => c.name);
  for (const column of LIMIT_COLUMNS) assert.ok(cols.includes(column), `missing ${column}`);
});
