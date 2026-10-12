#!/usr/bin/env node
// Read-only check of the execution schema steps on a Shannon database (Syzygy ADR-0009 stage 1, S2). It opens the file with
// node:sqlite in read-only mode and never writes.
//
//   node scripts/verify-schema-steps.mjs dump  <database> <before-file>   before the deploy: write sqlite_master (without the
//                                                                          ledger) to <before-file>, and print the facts below
//   node scripts/verify-schema-steps.mjs check <database> <before-file>   after the deploy: compare sqlite_master with
//                                                                          <before-file> and the ledger with the pinned checksums
//
// Both print user_version, integrity_check, the number of foreign_key_check rows and the ledger rows. `check` exits 1 when the
// schema differs from the before-file (apart from the ledger table and the additions of the S3 steps 008 and 009, which may be
// there on either side: their columns on agent_tasks and mind_actions and their two slot tables), integrity_check is not ok,
// a foreign key is broken, or a ledger row names an unknown step or another checksum. `check` also prints the rows of the slot
// tables and how many rows still miss an S3 column (`s3:` line; the start's backfill brings it to 0). On the VM:
//
//   N=/home/azureuser/shannon-ios-runtime/bin/node; DB=/home/azureuser/shannon-ios-data/shannon.sqlite
//   $N scripts/verify-schema-steps.mjs dump  "$DB" /tmp/schema-before.jsonl
//   ... deploy and start every service ...
//   $N scripts/verify-schema-steps.mjs check "$DB" /tmp/schema-before.jsonl

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const LEDGER = 'shannon_schema_steps';

/** The checksums of the execution steps (services/api/src/infra/sqlite/migrations/execution/), pinned like the test pins them. */
export const PINNED_SCHEMA_STEPS = Object.freeze({
  'execution/001_action_threads': 'efc68061f9594628eb100431d46739256af8c6389cc5f87efbc9fe6533a026b8',
  'execution/002_mind_worker_starts': 'ce21c801fa8a2dc3189d2210d023b7bb9398c3db9a17ab6ed8906aeb0e4f4178',
  'execution/003_liveness_episodes': 'b261b9ed2b3d03640c8a212f863a48424f0d83820e99cd3c1a0fbb3a4ece3fd4',
  'execution/004_fca_task_authority': 'c00116c0550b5755bb8a16a673963eadb0f026851394180043ced9564efbeacc',
  'execution/005_fca_task_runtime': 'afe6a267ad1becc288b14682bc54264e583a1f7c6d5eaf0b4dfa6b6c8912bd55',
  'execution/006_task_trees': 'f103e9be1f1d2eb571f161ce5a51595365677e4840d5f2cbee41cc91884855eb',
  'execution/007_fca_touch': '556835eff888206da4e83d5253e9809269aa5a572597eb505f87018dad7bc522',
  'execution/008_task_execution_columns': '69c8ae30a01ce3be3a047876121a250cfa7502a2076c90d35a3faad7c5aa451f',
  'execution/009_action_slots': '7dba69dd5efd5de2e3da9fcfc3c6c0be5eebcf3a1225a3e543e0c3a0a3b70f4f',
});

/** What the S3 steps add (Syzygy ADR-0009 stage 1): columns appended by ALTER TABLE, and two new tables with their indexes. */
export const S3_ADDITIONS = Object.freeze({
  columns: Object.freeze({
    agent_tasks: ['task_kind TEXT', 'capability TEXT', 'exec_state TEXT', 'wait_reason TEXT', 'unknown_since TEXT', 'effect_class TEXT',
      'exec_state_at TEXT'],
    mind_actions: ['task_id TEXT', 'slot_class TEXT', 'effect_sent INTEGER'],
  }),
  tables: Object.freeze(['mind_action_slot_pools', 'mind_action_slot_classes']),
});

/** A schema line without what the S3 steps add: null for an object of theirs, the table's SQL without their columns. */
export function withoutS3Additions(line) {
  const row = JSON.parse(line);
  if (S3_ADDITIONS.tables.includes(row.tbl_name)) return null;
  const columns = row.type === 'table' ? S3_ADDITIONS.columns[row.name] : undefined;
  if (!columns || typeof row.sql !== 'string') return line;
  const sql = columns.reduce((text, column) => text.replace(`, ${column}`, ''), row.sql);
  return JSON.stringify({ ...row, sql });
}

function schemaLines(db) {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> ? ORDER BY type, name').all(LEDGER);
  return rows.map(row => JSON.stringify(row));
}

function ledgerRows(db) {
  const found = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(LEDGER);
  if (!found) return [];
  return db.prepare(`SELECT id, checksum, applied_at FROM ${LEDGER} ORDER BY applied_at, rowid`).all();
}

function facts(db) {
  return {
    userVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version),
    integrity: String(db.prepare('PRAGMA integrity_check').get()?.integrity_check),
    foreignKeyProblems: db.prepare('PRAGMA foreign_key_check').all().length,
    ledger: ledgerRows(db),
  };
}

function ledgerProblems(ledger) {
  return ledger.flatMap(row => {
    const pinned = PINNED_SCHEMA_STEPS[row.id];
    if (!pinned) return [`unknown step ${row.id}`];
    return pinned === row.checksum ? [] : [`checksum of ${row.id} is ${row.checksum}, pinned ${pinned}`];
  });
}

function comparable(lines) {
  return lines.map(withoutS3Additions).filter(line => line !== null);
}

function s3Facts(db) {
  const has = name => Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const columns = table => new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name));
  const facts = {};
  if (columns('agent_tasks').has('exec_state')) {
    facts.taskRowsMissing = Number(db.prepare(`SELECT COUNT(*) AS count FROM agent_tasks
      WHERE task_kind IS NULL OR exec_state IS NULL OR effect_class IS NULL OR exec_state_at IS NULL`).get()?.count ?? 0);
  }
  if (columns('mind_actions').has('slot_class')) {
    facts.actionRowsMissing = Number(db.prepare('SELECT COUNT(*) AS count FROM mind_actions WHERE slot_class IS NULL OR effect_sent IS NULL')
      .get()?.count ?? 0);
  }
  if (has('mind_action_slot_pools')) facts.pools = db.prepare('SELECT pool, max_live FROM mind_action_slot_pools ORDER BY pool').all();
  if (has('mind_action_slot_classes')) {
    facts.classes = db.prepare('SELECT slot_class, pool, max_live FROM mind_action_slot_classes ORDER BY slot_class').all();
  }
  return facts;
}

function schemaProblems(beforeLines, afterLines) {
  const [before, after] = [comparable(beforeLines), comparable(afterLines)];
  const removed = before.filter(line => !after.includes(line)).map(line => `- ${line}`);
  const added = after.filter(line => !before.includes(line)).map(line => `+ ${line}`);
  return [...removed, ...added];
}

/** Runs one command and returns its exit code; `print` receives each line. */
export function verifySchemaSteps(argv, print = line => console.log(line)) {
  const [command, database, file] = argv;
  if (!['dump', 'check'].includes(command) || !database || !file) {
    print('usage: verify-schema-steps.mjs dump|check <database> <before-file>');
    return 2;
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const lines = schemaLines(db);
    const seen = facts(db);
    print(JSON.stringify(seen));
    if (command === 'dump') {
      writeFileSync(file, `${lines.join('\n')}\n`);
      print(`schema written: ${lines.length} objects`);
      return 0;
    }
    const before = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    print(`s3: ${JSON.stringify(s3Facts(db))}`);
    const problems = [...schemaProblems(before, lines), ...ledgerProblems(seen.ledger)];
    if (seen.integrity !== 'ok') problems.push(`integrity_check: ${seen.integrity}`);
    if (seen.foreignKeyProblems) problems.push(`foreign_key_check: ${seen.foreignKeyProblems} rows`);
    for (const problem of problems) print(problem);
    print(problems.length ? `SCHEMA_STEPS_FAILED (${problems.length})` : 'SCHEMA_UNCHANGED_AND_LEDGER_PINNED');
    return problems.length ? 1 : 0;
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = verifySchemaSteps(process.argv.slice(2));
