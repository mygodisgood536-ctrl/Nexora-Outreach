import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

import config from '../config.js';
import { translate } from './dialect.js';
import { SqliteDriver } from './sqlite.js';
import { PostgresDriver } from './postgres.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Statements issued inside `Db.tx()` must run on the transaction's own
 * connection, otherwise PostgreSQL would send them through the pool and they
 * would sit outside the transaction. An AsyncLocalStorage scope carries the
 * transaction-bound driver so existing call sites (`this.db.run(...)` inside a
 * `tx` callback) keep working unchanged on both databases.
 */
const txStore = new AsyncLocalStorage();

/** Bumped whenever schema.sql / schema.postgres.sql change. */
export const SCHEMA_VERSION = '8';

/** Arbitrary but stable advisory-lock key guarding schema application. */
const SCHEMA_LOCK_ID = 728_190_431;

/**
 * Idempotent, dialect-native upgrades replayed after the base DDL whenever the
 * stored schema version is stale. PostgreSQL is the only target that needs them
 * because it enforces integer widths: these epoch-millisecond columns were first
 * created as 32-bit `INTEGER`, which overflows at ~2.1e9 while `Date.now()` is
 * ~1.76e12. Widening to BIGINT is a no-op on fresh databases.
 */
const POSTGRES_UPGRADES = [
  'ALTER TABLE users ALTER COLUMN created_ms TYPE BIGINT',
  'ALTER TABLE api_rate_limits ALTER COLUMN window_start_ms TYPE BIGINT',
  // §10/§27 sending limits: added as nullable/defaulted columns so existing
  // rows keep working. Fresh databases already have them from schema.sql.
  'ALTER TABLE missions ADD COLUMN IF NOT EXISTS hourly_send_limit INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE missions ADD COLUMN IF NOT EXISTS min_seconds_between_sends INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_start_at TEXT',
  'ALTER TABLE missions ADD COLUMN IF NOT EXISTS campaign_end_at TEXT',
  // §30 failure UI: stable machine-readable error codes alongside the human
  // message, so the operator can be told what failed and whether retry is safe.
  'ALTER TABLE automation_jobs ADD COLUMN IF NOT EXISTS error_code TEXT',
  'ALTER TABLE outreach_messages ADD COLUMN IF NOT EXISTS error_code TEXT',
  // Spec §16: controlled redesign recommendation on the qualification.
  'ALTER TABLE qualifications ADD COLUMN IF NOT EXISTS recommended_service TEXT',
  // Spec §22: retention stamp set when an archived mission's configuration is
  // dropped. Nullable, so existing rows keep working.
  'ALTER TABLE missions ADD COLUMN IF NOT EXISTS purged_at TEXT',
];

/**
 * SQLite cannot widen a column type with ALTER, but it can add columns. These
 * run only when an existing database is behind the current schema version (a
 * fresh database already gets the columns from schema.sql), because SQLite has
 * no `ADD COLUMN IF NOT EXISTS`.
 */
const SQLITE_UPGRADES = [
  { table: 'missions', column: 'hourly_send_limit', sql: 'ALTER TABLE missions ADD COLUMN hourly_send_limit INTEGER NOT NULL DEFAULT 0' },
  { table: 'missions', column: 'min_seconds_between_sends', sql: 'ALTER TABLE missions ADD COLUMN min_seconds_between_sends INTEGER NOT NULL DEFAULT 0' },
  { table: 'missions', column: 'campaign_start_at', sql: 'ALTER TABLE missions ADD COLUMN campaign_start_at TEXT' },
  { table: 'missions', column: 'campaign_end_at', sql: 'ALTER TABLE missions ADD COLUMN campaign_end_at TEXT' },
  { table: 'automation_jobs', column: 'error_code', sql: 'ALTER TABLE automation_jobs ADD COLUMN error_code TEXT' },
  { table: 'outreach_messages', column: 'error_code', sql: 'ALTER TABLE outreach_messages ADD COLUMN error_code TEXT' },
  { table: 'qualifications', column: 'recommended_service', sql: 'ALTER TABLE qualifications ADD COLUMN recommended_service TEXT' },
  { table: 'missions', column: 'purged_at', sql: 'ALTER TABLE missions ADD COLUMN purged_at TEXT' },
];

export class Db {
  constructor(driver) {
    this.driver = driver;
    this.dialect = driver.dialect;
    this.file = driver.file ?? null;
  }

  _driver() {
    const ctx = txStore.getStore();
    return ctx && ctx.db === this ? ctx.txDriver : this.driver;
  }

  /** Execute a statement → { changes, lastInsertRowid }. */
  async run(sql, ...params) {
    const t = translate(sql, this.dialect, params);
    return this._driver().run(t.sql, t.params);
  }

  async get(sql, ...params) {
    const t = translate(sql, this.dialect, params);
    return this._driver().get(t.sql, t.params);
  }

  async all(sql, ...params) {
    const t = translate(sql, this.dialect, params);
    return this._driver().all(t.sql, t.params);
  }

  /** Multi-statement DDL. NOT translated — schema files are dialect-native. */
  async exec(sql) {
    return this._driver().exec(sql);
  }

  /**
   * Run `fn` inside a transaction. Rolls back on throw.
   * Nested transactions are a bug, not a feature, so they are rejected.
   */
  async tx(fn) {
    const existing = txStore.getStore();
    if (existing && existing.db === this) {
      throw new Error('Nested transactions are not supported.');
    }
    return this.driver.transaction((txDriver) => txStore.run({ db: this, txDriver }, () => fn(this)));
  }

  async hasTable(name) {
    if (this.dialect === 'postgres') {
      const row = await this.get('SELECT to_regclass(?) AS t', name);
      return Boolean(row && row.t);
    }
    const row = await this.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name,
    );
    return Boolean(row);
  }

  async _readSchemaVersion() {
    try {
      const row = await this.get('SELECT value FROM meta WHERE key = ?', 'schema_version');
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  async _writeSchemaVersion() {
    await this.run(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      'schema_version',
      SCHEMA_VERSION,
    );
  }

  /**
   * Apply the dialect's schema. Idempotent and safe to call on every boot:
   * a fast version check skips the DDL entirely once it has been applied.
   * PostgreSQL additionally takes an advisory lock so concurrent cold starts
   * cannot race each other.
   */
  async migrate() {
    const metaExists = await this.hasTable('meta');
    if (metaExists) {
      const current = await this._readSchemaVersion();
      if (current === SCHEMA_VERSION) return false;
    }

    const file = this.dialect === 'postgres' ? 'schema.postgres.sql' : 'schema.sql';
    const ddl = fs.readFileSync(path.join(HERE, file), 'utf8');

    if (this.dialect === 'postgres') {
      await this.tx(async () => {
        await this.run('SELECT pg_advisory_xact_lock(?)', SCHEMA_LOCK_ID);
        await this.exec(ddl);
        // Idempotent (ADD COLUMN IF NOT EXISTS), so safe on fresh databases too.
        for (const upgrade of POSTGRES_UPGRADES) await this.exec(upgrade);
        await this._writeSchemaVersion();
      });
    } else {
      await this.exec(ddl);
      // SQLite has no `ADD COLUMN IF NOT EXISTS`, so these run only for a
      // pre-existing database that is behind the current version; a fresh
      // database already received the columns from schema.sql. Guard on the
      // actual columns so a partially-applied upgrade cannot crash the boot.
      if (metaExists) await this._applySqliteUpgrades();
      await this._writeSchemaVersion();
    }
    return true;
  }

  /** Apply the SQLite additive upgrades for tables that already exist. */
  async _applySqliteUpgrades() {
    const columnsByTable = new Map();
    for (const upgrade of SQLITE_UPGRADES) {
      // A table that never existed is created fresh (with the column) by the
      // base DDL, so there is nothing to add.
      if (!columnsByTable.has(upgrade.table)) {
        if (!(await this.hasTable(upgrade.table))) { columnsByTable.set(upgrade.table, null); continue; }
        const info = await this.all(`PRAGMA table_info(${upgrade.table})`);
        columnsByTable.set(upgrade.table, new Set(info.map((c) => c.name)));
      }
      const cols = columnsByTable.get(upgrade.table);
      if (cols && !cols.has(upgrade.column)) await this.run(upgrade.sql);
    }
  }

  async close() {
    await this.driver.close();
  }
}

let singleton = null;

/**
 * The application-wide database handle.
 *
 * PostgreSQL (Neon, configured through Vercel) is used whenever `DATABASE_URL`
 * is present — that is the production path. Without it the app falls back to
 * the zero-install SQLite file so development and the test suite never require
 * a local database server.
 */
export function getDb() {
  if (!singleton) {
    const url = config.databaseUrl;
    const driver = url
      ? new PostgresDriver(url, { max: config.dbPoolMax })
      : new SqliteDriver(config.dbFile);
    singleton = new Db(driver);
  }
  return singleton;
}

/** Isolated in-memory SQLite database (used by tests). */
export function createTestDb(file = ':memory:') {
  return new Db(new SqliteDriver(file));
}

/** PostgreSQL test database — used by the Postgres integration suite. */
export function createPostgresDb(url) {
  if (!url) throw new Error('createPostgresDb requires a connection URL');
  return new Db(new PostgresDriver(url, { max: 3, allowExitOnIdle: true }));
}

export async function closeDb() {
  if (singleton) {
    const s = singleton;
    singleton = null;
    await s.close();
  }
}

export default getDb;
