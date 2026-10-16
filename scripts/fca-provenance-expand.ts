// Rollback aid for SHANNON_FCA_PROVENANCE_REFS (docs/fca-runtime-contract.md, "Provenance by reference", Deploy and rollback):
// rewrites every FCA step record that keeps its sources by reference back into the copy an older build reads. Run it only on
// a STOPPED database (all services stopped, a fresh backup taken), with this build's Node:
//
//   node --import tsx scripts/fca-provenance-expand.ts <database>            dry run: counts only, writes nothing
//   node --import tsx scripts/fca-provenance-expand.ts <database> --apply    one transaction; refuses if any reference is unresolved or malformed,
//                                                                           and exits non-zero if the integrity check is not ok
//
// Prints counts only (never a source or an id). The set table and its ledger row are left in place.
import { DatabaseSync } from 'node:sqlite';
import { isProvenanceReference, readStoredSources } from '../services/api/src/infra/sqlite/fcaProvenanceSets.js';

const [path, flag] = process.argv.slice(2);
if (!path || (flag !== undefined && flag !== '--apply')) {
  console.error('usage: fca-provenance-expand.ts <database> [--apply]');
  process.exit(2);
}
const db = new DatabaseSync(path);
const tables = [
  { table: 'fca_action_evidence', scope: 'scope_key', key: 'rowid' },
  { table: 'fca_task_history', scope: '(SELECT t.scope_key FROM agent_tasks t WHERE t.task_id=fca_task_history.task_id)', key: 'rowid' },
] as const;
let unresolved = 0, malformed = 0, expanded = 0;
const plan: Array<{ table: string; rowid: number; json: string }> = [];
for (const { table, scope, key } of tables) {
  if (!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
  const rows = db.prepare(`SELECT ${key} AS rowid, ${scope} AS scope_key, sources_json FROM ${table} WHERE sources_json LIKE '{"set":%'`).all();
  let count = 0;
  for (const row of rows) {
    // Looks like a reference but is not one this build reads: reported, never skipped silently, and --apply refuses.
    if (!isProvenanceReference(String(row.sources_json))) { malformed += 1; continue; }
    const sources = readStoredSources(db, String(row.scope_key), String(row.sources_json));
    if (!sources) { unresolved += 1; continue; }
    plan.push({ table, rowid: Number(row.rowid), json: JSON.stringify(sources) });
    count += 1;
  }
  console.log(`${table}: references=${count}`);
}
console.log(`unresolved=${unresolved}`);
console.log(`malformed=${malformed}`);
if (flag === '--apply') {
  if (unresolved || malformed) {
    console.error('FCA_PROVENANCE_EXPAND_REFUSED: unresolved or malformed references; nothing written');
    process.exit(1);
  }
  const before = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check);
  if (before !== 'ok') {
    console.error('FCA_PROVENANCE_EXPAND_REFUSED: integrity_check is not ok before the rewrite; nothing written');
    process.exit(1);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of plan) expanded += Number(db.prepare(`UPDATE ${item.table} SET sources_json=? WHERE rowid=?`).run(item.json, item.rowid).changes);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`expanded=${expanded}`);
  const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check);
  console.log(`integrity=${integrity}`);
  if (integrity !== 'ok') {
    console.error('FCA_PROVENANCE_EXPAND_FAILED: integrity_check is not ok after the rewrite; restore the backup');
    db.close();
    process.exit(1);
  }
}
db.close();
