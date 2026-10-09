/**
 * Proves the PostgreSQL path works end-to-end against the real Neon database:
 * connect, apply the schema, run representative queries, verify translation,
 * then clean up. Prints no credentials.
 *
 *   node scripts/verify-postgres.js
 */
import config from '../src/config.js';
import { Db } from '../src/db/index.js';
import { PostgresDriver as PD } from '../src/db/postgres.js';
import { translate } from '../src/db/dialect.js';

function fail(msg, err) {
  console.error(`FAIL: ${msg}`);
  if (err) {
    console.error(`  ${err.code || ''} ${err.message}`.trim());
    // Never print the connection string, only the host.
    const host = config.databaseUrl ? safeHost(config.databaseUrl) : '(none)';
    console.error(`  host: ${host}`);
  }
  process.exit(1);
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return '(unparsable)'; }
}

const checks = [];
function check(name, ok) {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}

if (!config.databaseUrl) fail('DATABASE_URL is not configured');
console.log(`dialect=${config.dbDialect} host=${safeHost(config.databaseUrl)}`);

// ── 1. Translation sanity ────────────────────────────────────────────
{
  const t = translate('INSERT INTO t(a,b) VALUES(?, ?)', 'postgres', [1, 2]);
  check('placeholders become $1,$2', t.sql === 'INSERT INTO t(a,b) VALUES($1, $2)');
  const t2 = translate("SELECT * FROM t WHERE x = '?' AND y = datetime('now') AND z = ?", 'postgres', ['a']);
  check('literal ? untouched', t2.sql.includes("= '?'"));
  check('datetime(now) translated', t2.sql.includes("to_char((now() at time zone 'utc')"));
  check('placeholder count outside literals', t2.sql.endsWith('$1'));
}

// ── 2. Connect + migrate ────────────────────────────────────────────
const driver = new PD(config.databaseUrl, { max: 3, allowExitOnIdle: true });
const db = new Db(driver);

try {
  const version = await db.get('SELECT current_database() AS db, version() AS v');
  check('connected to a real PostgreSQL server', /PostgreSQL/i.test(version.v));
  console.log(`  database: ${version.db}`);
} catch (e) {
  fail('could not connect', e);
}

try {
  const applied = await db.migrate();
  console.log(`  schema applied now: ${applied}`);
  const again = await db.migrate();
  check('migrate is idempotent', again === false);
} catch (e) {
  fail('migration failed', e);
}

// ── 3. Schema shape ─────────────────────────────────────────────────
try {
  const tables = await db.all(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1",
  );
  check('26 tables created', tables.length === 26, );
  if (tables.length !== 26) console.log(`  found ${tables.length}: ${tables.map((t) => t.table_name).join(', ')}`);
  const idx = await db.all("SELECT indexname FROM pg_indexes WHERE schemaname='public'");
  check('indexes created', idx.length >= 19);
} catch (e) {
  fail('schema inspection failed', e);
}

// ── 4. Write / read / unique-violation / transaction ────────────────
const marker = `pg-verify-${Date.now()}`;
let userId = null;
try {
  const r = await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question)
     VALUES(?, ?, ?, ?) RETURNING id`,
    'PG Verify', marker, marker, 'q?',
  );
  userId = r.lastInsertRowid;
  check('INSERT ... RETURNING id yields a number id', typeof userId === 'number' && userId > 0);
} catch (e) {
  fail('insert failed', e);
}

try {
  await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question)
     VALUES(?, ?, ?, ?)`,
    'Dup', marker, marker, 'q',
  );
  fail('unique violation was not raised');
} catch (e) {
  check('unique violation surfaces as SQLite-style error', /UNIQUE constraint failed/.test(e.message));
}

try {
  await db.tx(async () => {
    await db.run('UPDATE users SET full_name = ? WHERE id = ?', 'In Tx', userId);
    throw new Error('rollback probe');
  });
  fail('transaction did not roll back');
} catch (e) {
  if (e.message !== 'rollback probe') fail('unexpected tx error', e);
  const row = await db.get('SELECT full_name FROM users WHERE id = ?', userId);
  check('transaction rolled back', row.full_name === 'PG Verify');
}

try {
  await db.tx(async () => {
    await db.run('UPDATE users SET full_name = ? WHERE id = ?', 'Committed', userId);
  });
  const row = await db.get('SELECT full_name FROM users WHERE id = ?', userId);
  check('transaction committed', row.full_name === 'Committed');
} catch (e) {
  fail('commit failed', e);
}

// ── 5. Text timestamp comparisons behave like SQLite ────────────────
try {
  const row = await db.get(
    "SELECT CASE WHEN datetime_placeholder THEN 1 ELSE 1 END AS ok FROM (SELECT 1) s",
  ).catch(() => null);
  const t = await db.get("SELECT to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS') AS now_sqlite_fmt, ?::text AS past", '2000-01-01 00:00:00');
  check('timestamp text format + ordering', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t.now_sqlite_fmt) && t.past < t.now_sqlite_fmt);
} catch (e) {
  fail('timestamp check failed', e);
}

// ── 6. Cleanup ──────────────────────────────────────────────────────
try {
  if (userId !== null) {
    await db.run('DELETE FROM users WHERE id = ?', userId);
    const gone = await db.get('SELECT id FROM users WHERE id = ?', userId);
    check('verification rows cleaned up', gone === undefined);
  }
} catch (e) {
  fail('cleanup failed', e);
}

await db.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
