#!/usr/bin/env node
/** Apply the schema and report resulting tables. */
import { getDb, closeDb } from '../src/db/index.js';

const db = getDb();
const tables = db.all(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
);
console.log(`Database: ${db.file}`);
console.log(`Tables (${tables.length}):`);
for (const t of tables) {
  const cols = db.all(`PRAGMA table_info(${t.name})`);
  const fks = db.all(`PRAGMA foreign_key_list(${t.name})`);
  console.log(`  - ${t.name.padEnd(22)} ${String(cols.length).padStart(2)} cols, ${fks.length} fks`);
}
closeDb();