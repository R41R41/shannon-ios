import type { DatabaseSync } from 'node:sqlite';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';
import { underWriteLock } from '../../../infra/sqlite/lockWaits.js';

// The stage-2 additive migration already supports this exact pre-lineage table. Its origin/actor
// columns have no CHECK restriction to widen. Accept only that known DDL and our additive suffixes.
const PRE_LINEAGE_REVISIONS = `CREATE TABLE shannon_skill_revisions (
  revision_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, scope_key TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, body_hash TEXT NOT NULL, made_by TEXT NOT NULL, actor TEXT NOT NULL, evidence_json TEXT NOT NULL,
  before_sha256 TEXT, after_sha256 TEXT NOT NULL, pinned INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`;
function supportedUnconstrainedRevisions(table: string, sql: string): boolean {
  if (table !== 'shannon_skill_revisions') return false;
  const normalize = (value: string) => value.replace(/\s+/gu, '').toLowerCase();
  let actual = normalize(sql), previous: string;
  do {
    previous = actual;
    actual = actual.replace(/,(?:provenance_jsontext|parent_revision_idtext|variant_oftext|usesintegernotnulldefault0|successesintegernotnulldefault0)(?=\)$)/u, '');
  } while (actual !== previous);
  return actual === normalize(PRE_LINEAGE_REVISIONS);
}

/** Widen the two historical CHECK constraints without rewriting or losing any row, index or trigger. */
export function ensureSkillImportSchema(database: DatabaseSync): void {
  underWriteLock(database, null, '', () => {
    for (const table of ['shannon_skills', 'shannon_skill_revisions']) {
      const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
      if (!row.sql.includes("'operator_authored'") && !supportedUnconstrainedRevisions(table, row.sql)) {
        const ancillary = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table) as { sql: string }[];
        const widened = row.sql.replace(/\('sleep', 'owner_edit'\)/gu, "('sleep', 'owner_edit', 'operator_authored')")
          .replace(/\('sleep', 'conversation', 'owner', 'shannon_copy'\)/gu, "('sleep', 'conversation', 'owner', 'shannon_copy', 'operator_authored')");
        if (widened === row.sql) throw new Error('SKILL_IMPORT_SCHEMA_UNRECOGNIZED');
        const temporary = `${table}_import_migration`;
        database.exec(widened.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}`, 'u'), `CREATE TABLE ${temporary}`));
        database.exec(`INSERT INTO ${temporary} SELECT * FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
        for (const item of ancillary) database.exec(item.sql);
      }
      ensureColumns(database, table, { provenance_json: 'TEXT' });
    }
    database.exec(`CREATE TABLE IF NOT EXISTS shannon_skill_imports (
      receipt_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_revision TEXT NOT NULL,
      pack_sha256 TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      PRIMARY KEY (scope_key, receipt_id),
      UNIQUE (scope_key, pack_id, pack_revision)
    )`);
  }, 'skill_import_schema');
}
