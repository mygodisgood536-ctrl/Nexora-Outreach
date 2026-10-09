import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { translate } from './dialect.js';

/**
 * SQLite driver — the zero-install development and test database.
 *
 * Production runs on PostgreSQL (Neon, via Vercel); SQLite exists so the suite
 * can run on any machine with no local database server. Every method returns a
 * real Promise so that a forgotten `await` fails loudly instead of silently
 * handing a Promise to business logic.
 */
export class SqliteDriver {
  static dialect = 'sqlite';

  constructor(file) {
    this.file = file;
    this.dialect = 'sqlite';
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this._stmts = new Map();
    this._closed = false;
  }

  _prepare(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  async run(sql, params) {
    const t = translate(sql, 'sqlite', params);
    const r = this._prepare(t.sql).run(...t.params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  async get(sql, params) {
    const t = translate(sql, 'sqlite', params);
    const row = this._prepare(t.sql).get(...t.params);
    return row === undefined ? undefined : normaliseRow(row);
  }

  async all(sql, params) {
    const t = translate(sql, 'sqlite', params);
    return this._prepare(t.sql).all(...t.params).map(normaliseRow);
  }

  /** Multi-statement DDL. Not translated: schema files are dialect-native. */
  async exec(sql) {
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` inside a transaction. SQLite uses a single connection, so every
   * statement issued through this Db during `fn` is automatically part of the
   * transaction — no routing is required.
   */
  async transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      // Pass this driver so Db.tx can route statements issued inside the
      // callback back to this connection (same contract as PostgreSQL).
      const out = await fn(this);
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  async close() {
    this._closed = true;
    this._stmts.clear();
    try { this.raw.close(); } catch { /* already closed */ }
  }
}

function normaliseRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  }
  return row;
}
