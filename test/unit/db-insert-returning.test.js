import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// PostgreSQL returns no row from a bare INSERT, so `lastInsertRowid` (which the
// Postgres driver reads from `rows[0].id`) is 0 unless the statement ends with
// `RETURNING id`. SQLite papers over this in tests, which is how a missing
// RETURNING can reach production and surface as a 500 on the write path. This
// guard fails if an INSERT whose result is read via `lastInsertRowid` omits it.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Every single- or backtick-quoted literal, so we see the SQL as written.
const STRING_LITERAL = /`[^`]*`|'[^'\n]*'/g;

test('any INSERT read via lastInsertRowid ends with RETURNING id (postgres)', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(STRING_LITERAL)) {
      const sql = match[0];
      if (!/INSERT\s+INTO/i.test(sql)) continue;
      if (/RETURNING/i.test(sql)) continue;
      // If the id from this statement is consumed soon after, it is required.
      const tail = text.slice(match.index + sql.length, match.index + sql.length + 400);
      if (/lastInsertRowid/.test(tail)) {
        offenders.push(`${relative(SRC, file)}: ${sql.split('\n')[0].slice(0, 80).trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `INSERTs read via lastInsertRowid must end with RETURNING id, otherwise Postgres returns no row:\n${offenders.join('\n')}`,
  );
});

// Epoch-millisecond columns hold Date.now() (~1.76e12), which overflows a
// PostgreSQL 32-bit INTEGER (max ~2.1e9). They must be BIGINT, or the write
// path 500s on the first insert. SQLite's INTEGER is 64-bit so it hides this.
test('epoch-ms columns are BIGINT in schema.postgres.sql', () => {
  const schema = readFileSync(join(SRC, 'db', 'schema.postgres.sql'), 'utf8');
  const problems = [];
  for (const column of ['created_ms', 'window_start_ms']) {
    const line = schema.split('\n').find((l) => new RegExp(`^\\s*${column}\\s`).test(l));
    if (!line) problems.push(`${column}: column not found`);
    else if (!/\bBIGINT\b/.test(line)) problems.push(`${column}: must be BIGINT, got "${line.trim()}"`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
