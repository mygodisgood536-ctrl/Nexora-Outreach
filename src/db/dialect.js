/**
 * SQL dialect translation.
 *
 * The whole codebase is written in SQLite-flavoured SQL with `?` placeholders
 * because that is the zero-install test/dev driver. When the target dialect is
 * PostgreSQL (the production database, spec §15) the same SQL is translated at
 * runtime instead of being rewritten at every call site:
 *
 *   ?                 -> $1 .. $n   (counted OUTSIDE string literals/comments)
 *   datetime('now')   -> to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')
 *
 * The replacement produces exactly SQLite's `datetime('now')` format
 * ("YYYY-MM-DD HH:MM:SS", UTC, space separator) so that timestamp TEXT columns
 * compare identically on both databases.
 *
 * Statements executed through `Db.exec()` are NOT translated: those come from
 * dialect-specific schema files that are already correct for the target.
 */

const NOW_PG = "to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS')";
const NOW_RE = /datetime\(\s*'now'\s*\)/i;

/** Count `?` placeholders outside literals/comments (SQLite dialect). */
export function countPlaceholders(sql) {
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    if (c === "'") { i = skipString(sql, i); continue; }
    if (c === '"') { i = skipIdent(sql, i); continue; }
    if (c === '-' && sql[i + 1] === '-') { i = skipLineComment(sql, i); continue; }
    if (c === '/' && sql[i + 1] === '*') { i = skipBlockComment(sql, i); continue; }
    if (c === '?') n++;
    i++;
  }
  return n;
}

function skipString(sql, i) {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'") {
      if (sql[j + 1] === "'") { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

function skipIdent(sql, i) {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === '"') {
      if (sql[j + 1] === '"') { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

function skipLineComment(sql, i) {
  const j = sql.indexOf('\n', i);
  return j === -1 ? sql.length : j;
}

function skipBlockComment(sql, i) {
  const j = sql.indexOf('*/', i + 2);
  return j === -1 ? sql.length : j + 2;
}

/**
 * Translate SQLite-flavoured SQL into `dialect`.
 * Returns { sql, params } with PostgreSQL placeholders bound positionally.
 */
export function translate(sql, dialect, params = []) {
  if (dialect !== 'postgres') {
    return { sql, params };
  }

  let out = '';
  let n = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const c = sql[i];

    if (c === "'") { const j = skipString(sql, i); out += sql.slice(i, j); i = j; continue; }
    if (c === '"') { const j = skipIdent(sql, i); out += sql.slice(i, j); i = j; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = skipLineComment(sql, i); out += sql.slice(i, j); i = j; continue; }
    if (c === '/' && sql[i + 1] === '*') { const j = skipBlockComment(sql, i); out += sql.slice(i, j); i = j; continue; }

    if (c === '?') {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }

    if ((c === 'd' || c === 'D') && NOW_RE.test(sql.slice(i, i + 20))) {
      const m = NOW_RE.exec(sql.slice(i, i + 20));
      out += NOW_PG;
      i += m[0].length;
      continue;
    }

    out += c;
    i++;
  }

  const bound = normaliseParams(params);
  if (bound.length !== n) {
    const err = new Error(
      `SQL placeholder mismatch: statement has ${n} placeholder(s) but ${bound.length} value(s) were supplied.`,
    );
    err.code = 'SQL_PARAM_MISMATCH';
    throw err;
  }
  return { sql: out, params: bound };
}

/**
 * Coerce JS values into something both drivers accept.
 * node:sqlite accepts only null/number/bigint/string/Uint8Array; node-pg rejects
 * `undefined` outright. Normalising here keeps behaviour identical on both.
 */
export function normaliseParams(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}
