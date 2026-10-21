#!/usr/bin/env node
/**
 * Apply the schema to the configured database and report what it now contains.
 *
 * `DATABASE_URL` selects PostgreSQL (production Neon); without it the zero-install
 * SQLite file is used, so the same command works locally. `Db.migrate()` is
 * idempotent, which makes this safe to run against a live database.
 */
import { getDb, closeDb } from '../src/db/index.js';

const db = getDb();

const changed = await db.migrate();
console.log(`Database: ${db.file || 'PostgreSQL (DATABASE_URL)'}`);
console.log(`Schema applied: ${changed ? 'yes (DDL ran)' : 'no (already current)'}`);

const tables = db.dialect === 'postgres'
  ? await db.all(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  )
  : await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

console.log(`Tables (${tables.length}):`);
for (const t of tables) {
  const cols = db.dialect === 'postgres'
    ? await db.all(
      // `?` placeholders, not `$1`: the dialect layer rewrites them for
      // PostgreSQL and counts them, so raw `$1` breaks the parameter check.
      'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
      'public', t.name
    )
    : await db.all(`PRAGMA table_info("${t.name}")`);
  const names = cols.map((c) => c.column_name ?? c.name);
  console.log(`  - ${t.name.padEnd(22)} ${String(names.length).padStart(2)} cols`);
}

// The retention column is the one most likely to be missing on an older
// deployment, because CREATE TABLE IF NOT EXISTS never adds it to a live table.
const missions = db.dialect === 'postgres'
  ? await db.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'missions'"
  )
  : await db.all('PRAGMA table_info(missions)');
const missionCols = missions.map((c) => c.column_name ?? c.name);
for (const required of ['hourly_send_limit', 'campaign_start_at', 'error_code', 'purged_at']) {
  const table = required === 'error_code' ? 'automation_jobs' : 'missions';
  const ok = required === 'error_code'
    ? (db.dialect === 'postgres'
      ? await db.get(
        "SELECT 1 AS ok FROM information_schema.columns WHERE table_schema='public' AND table_name='automation_jobs' AND column_name='error_code'"
      )
      : (await db.all('PRAGMA table_info(automation_jobs)')).some((c) => c.name === 'error_code'))
    : missionCols.includes(required);
  if (!ok) console.error(`MISSING ${table}.${required} — run this script again after deploying the current code.`);
}

await closeDb();