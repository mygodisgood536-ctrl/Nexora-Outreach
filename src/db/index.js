import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * node:sqlite returns INTEGER columns as JS numbers when they fit, but
 * `lastInsertRowid` may surface as BigInt. Normalise everything so callers
 * always get plain numbers.
 */
function normalise(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (typeof v === 'bigint') value[k] = Number(v);
    }
  }
  return value;
}

export class Db {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this._stmts = new Map();
  }

  _prepare(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  /** Execute a statement, returning { changes, lastInsertRowid }. */
  run(sql, ...params) {
    const r = this._prepare(sql).run(...params.map(normalise));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get(sql, ...params) {
    return normalise(this._prepare(sql).get(...params.map(normalise)));
  }

  all(sql, ...params) {
    return this._prepare(sql).all(...params.map(normalise)).map(normalise);
  }

  exec(sql) { this.raw.exec(sql); }

  /** Synchronous transaction. Rolls back on throw. */
  tx(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  close() {
    this._stmts.clear();
    try { this.raw.close(); } catch { /* already closed */ }
  }

  /** Apply the schema. Idempotent. */
  migrate() {
    const sql = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8');
    this.raw.exec(sql);
    const cur = this.get('SELECT value FROM meta WHERE key = ?', 'schema_version');
    if (!cur) {
      this.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'schema_version', '1');
    }
  }
}

let singleton = null;

/** Shared application-wide database handle. */
export function getDb() {
  if (!singleton) {
    singleton = new Db(config.dbFile);
    singleton.migrate();
  }
  return singleton;
}

/** Isolated database (used by tests). `:memory:` is fast and leak-free. */
export function createTestDb(file = ':memory:') {
  const db = new Db(file);
  db.migrate();
  return db;
}

export function closeDb() {
  if (singleton) { singleton.close(); singleton = null; }
}

export default getDb;