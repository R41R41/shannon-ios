import type { DatabaseSync } from 'node:sqlite';

/**
 * Columns added to an additive table after it may already exist (review, low): `CREATE TABLE IF NOT EXISTS` never changes a
 * table that is there, so each later column is added when it is missing. Only nullable columns or columns with a default.
 */
export function ensureColumns(database: DatabaseSync, table: string, columns: Readonly<Record<string, string>>): void {
  if (!/^[a-z_]+$/u.test(table)) throw new Error('SCHEMA_TABLE');
  const present = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!/^[a-z_]+$/u.test(name)) throw new Error('SCHEMA_COLUMN');
    if (!present.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}
