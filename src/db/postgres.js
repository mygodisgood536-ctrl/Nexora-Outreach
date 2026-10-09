import pg from 'pg';

const { Pool } = pg;

// node-pg returns int8 (BIGINT) as a string by default. Every id in Nexora is
// a JS number in business logic, so parse int8 as a number. Values stay far
// below Number.MAX_SAFE_INTEGER (ids are sequential integers).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/** PostgreSQL SQLSTATE codes we translate into the SQLite-style errors the app expects. */
const CONSTRAINT_ERRORS = {
  23505: (e) => `UNIQUE constraint failed: ${constraintLabel(e)}`,
  23503: (e) => `FOREIGN KEY constraint failed: ${constraintLabel(e)}`,
  23502: (e) => `NOT NULL constraint failed: ${constraintLabel(e)}`,
  23514: (e) => `CHECK constraint failed: ${constraintLabel(e)}`,
};

function constraintLabel(e) {
  // `constraint` looks like "users_username_lower_key"; `column`/`table` are set
  // for NOT NULL violations. Fall back to the raw detail so nothing is hidden.
  if (e.table && e.column) return `${e.table}.${e.column}`;
  if (e.constraint) return e.constraint;
  if (e.table) return e.table;
  return e.detail || '';
}

/** Normalise a node-pg error so callers can keep matching on message/code. */
export function normalisePgError(e) {
  if (!e || typeof e.code !== 'string') return e;
  const mapper = CONSTRAINT_ERRORS[e.code];
  if (mapper) {
    e.uniqueViolation = e.code === '23505';
    e.constraintViolation = true;
    e.message = mapper(e);
    return e;
  }
  // Serialization failure / statement timeout — transient by definition (§30).
  if (e.code === '40001' || e.code === '40P01' || e.code === '57014') {
    e.transient = true;
  }
  return e;
}

/**
 * PostgreSQL driver — the production database (Neon, connected through Vercel).
 *
 * Selected automatically when `DATABASE_URL` is present. The public surface is
 * identical to the SQLite driver so business code is dialect-agnostic.
 */
export class PostgresDriver {
  static dialect = 'postgres';

  constructor(connectionString, options = {}) {
    this.dialect = 'postgres';
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 5,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 15_000,
      // Serverless-friendly: let the process exit when no connections are in use.
      allowExitOnIdle: options.allowExitOnIdle ?? false,
      application_name: 'nexora-outreach',
    });
    this.pool.on('error', (e) => {
      normalisePgError(e);
      // An idle client blew up (network restart, pooler recycle). The pool will
      // replace it; never let this take the process down.
      if (e && e.code === '28P01') return;
      console.error('[db] idle postgres client error:', e.message);
    });
    this._closed = false;
  }

  async _query(client, sql, params) {
    try {
      return await client.query({ text: sql, values: params });
    } catch (e) {
      throw normalisePgError(e);
    }
  }

  /** Acquire a dedicated client for the duration of `fn` (used by transactions). */
  async withClient(fn) {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  /** Client-bound driver view, handed to transaction callbacks. */
  boundDriver(client) {
    const self = this;
    return {
      dialect: 'postgres',
      async run(sql, params) {
        const r = await self._query(client, sql, params);
        const row = r.rows && r.rows[0];
        return {
          changes: r.rowCount ?? 0,
          lastInsertRowid: row && row.id !== undefined ? Number(row.id) : 0,
        };
      },
      async get(sql, params) {
        const r = await self._query(client, sql, params);
        return r.rows && r.rows.length ? r.rows[0] : undefined;
      },
      async all(sql, params) {
        const r = await self._query(client, sql, params);
        return r.rows || [];
      },
      async exec(sql) {
        await self._query(client, sql);
      },
    };
  }

  async run(sql, params) { return this._runOnPool('run', sql, params); }
  async get(sql, params) { return this._runOnPool('get', sql, params); }
  async all(sql, params) { return this._runOnPool('all', sql, params); }
  async exec(sql) { await this._runOnPool('exec', sql, undefined); }

  async _runOnPool(kind, sql, params) {
    const client = await this.pool.connect().catch((e) => { throw normalisePgError(e); });
    try {
      const driver = this.boundDriver(client);
      return await driver[kind](sql, params);
    } finally {
      client.release();
    }
  }

  async transaction(fn) {
    return this.withClient(async (client) => {
      const driver = this.boundDriver(client);
      try {
        await this._query(client, 'BEGIN');
        // Serialise concurrent cold starts applying the same schema.
        const out = await fn(driver);
        await this._query(client, 'COMMIT');
        return out;
      } catch (err) {
        try { await this._query(client, 'ROLLBACK'); } catch { /* connection gone */ }
        throw err;
      }
    });
  }

  async close() {
    this._closed = true;
    await this.pool.end();
  }
}
