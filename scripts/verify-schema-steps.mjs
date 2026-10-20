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
// schema differs from the before-file (apart from the ledger table and the additions of the steps 008, 009 and 010, which may be
// there on either side: their columns on agent_tasks and mind_actions and their two slot tables), integrity_check is not ok,
// a foreign key is broken, a ledger row names an unknown step or another checksum, or the slot tables do not hold exactly the
// limits the ledger says were written (step 011: the owner's limits; else step 009: the limits of S3). `check` also prints the
// rows of the slot tables and how many rows still miss a new column (`s3:` line; the start's backfill brings it to 0). On the VM:
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
  'execution/010_task_host_starting': 'a5d43ddc03296599405e1606e08661e08189f87f4a6bac57b53a96f9afd94f8a',
  'execution/011_owner_slot_limits': '5632ae89a55a1426831052ece071b46b1fcaa4ab67b6676a1e09d98cf0cc8e98',
  'execution/012_operator_audit': '162f55b8b8119d4cfe58226f25898d12b94ec1e81dd3ad3bda14f0c4f27fcc8c',
  // 2026-10-15: the FCA provenance sets, made when SHANNON_FCA_PROVENANCE_REFS (on by default) first opens the task runtime.
  'execution/013_fca_provenance_sets': '628187523990f2531313993c8788fdba8f041441225a1aa61838349decc7aa55',
  // Her inner note (Syzygy ADR-0012, services/api/src/infra/sqlite/migrations/emotion/), as production's ledger holds them since
  // 2026-10-13 (read 2026-10-14): without them every deploy check reported `unknown step emotion/…`.
  'emotion/001_inner_notes': 'd683a488c6ec1095487a1f8cb721506c571bc59e9bbff5e0b876c7fa9c49e3cc',
  'emotion/002_inner_note_episodes': '82db51e74ebb56f08b3392b192a27490a0f3fc111deb956c022a59b9497452df',
  'emotion/003_inner_note_attempts': 'da679362296ea082a98c9b58ea1105862782f38e1f131b07162f319eddee1010',
  // Her feeling events (Syzygy ADR-0013 stage 1), applied in production since the stage-1 switches went on (2026-10-14).
  'emotion/004_feeling_events': 'f137c35156c7d3d0e875309beead90cd72bb9115bcd44d8cad54e4baf2fdc462',
  // The shadow of her fast layer (ADR-0013 stage 2), made when SHANNON_CORE_AFFECT first opens its store.
  'emotion/005_feeling_shadow': '314d33b616f087a45219f75637ddd480aa15bdcaade1d830ab1130e7996ee5b2',
  'emotion/006_feeling_days': '27736c122507ed4e21734c7831dbb340630702d23a4cbe35dc9d97081efefb55',
  // 2026-10-20: her rewritten drafts, made when SHANNON_NATURAL_TALK first opens their store.
  'emotion/007_reply_drafts': 'f1566b8c0014345f439840bb5e87d2d18057dcefff903f6135be449e5efeea69',
});

/** The slot rows each limit-writing step leaves (S3 review L5): `pool:max` and `class:pool:max`, sorted. */
export const SLOT_SEEDS = Object.freeze({
  'execution/009_action_slots': Object.freeze({
    pools: ['background:2', 'foreground:1'],
    classes: ['codex:background:2', 'creative:background:2', 'minecraft:background:2', 'other:background:2', 'research:background:2',
      'respond:foreground:1', 'sleep:background:2', 'touch:background:2'],
  }),
  'execution/011_owner_slot_limits': Object.freeze({
    pools: ['background:3', 'foreground:1', 'touch:1'],
    classes: ['codex:background:1', 'creative:background:1', 'minecraft:background:1', 'other:background:1', 'research:background:2',
      'respond:foreground:1', 'sleep:background:1', 'touch:touch:1'],
  }),
});

/**
 * What the S3 and S4 steps add (Syzygy ADR-0009 stage 1): columns appended by ALTER TABLE (008, 009, 010), and two new tables
 * with their indexes (009). Step 011 changes only rows. Also the additive objects of ADR-0009 stage 2 (E2, E3, E5), and those of the
 * voice history summary (2026-10-14: two tables and the epoch's `summary_version`), which may be there on either side of a deploy.
 */
export const S3_ADDITIONS = Object.freeze({
  columns: Object.freeze({
    agent_tasks: ['task_kind TEXT', 'capability TEXT', 'exec_state TEXT', 'wait_reason TEXT', 'unknown_since TEXT', 'effect_class TEXT',
      'exec_state_at TEXT', 'exec_starting INTEGER'],
    mind_actions: ['task_id TEXT', 'slot_class TEXT', 'effect_sent INTEGER'],
    // Syzygy ADR-0009 stage 2 (E2): her goals' lifecycle, added by her own time's store (not a step of the ledger).
    autonomy_pursuits: ['source_kind TEXT', 'source_ref TEXT', 'interest_id TEXT', 'expected_value REAL', 'expected_score REAL',
      'completion_predicate TEXT', 'review_at TEXT', 'progress REAL', 'last_worked_at TEXT', 'evidence_json TEXT', 'closed_reason TEXT',
      'closed_at TEXT'],
    // 2026-10-14: the epoch's pinned voice summary version (SHANNON_VOICE_HISTORY_SUMMARY, `voiceSummaryMigration.ts`).
    conversation_replay_epochs: ['summary_version INTEGER'],
  }),
  tables: Object.freeze([
    'mind_action_slot_pools', 'mind_action_slot_classes',
    // Stage 2 (E2, E3, E5): goal events and the migration mark, the FCA task budget, the Executive's deliberations; each made on first use.
    'autonomy_pursuit_events', 'autonomy_pursuit_marks', 'fca_task_budget', 'executive_deliberations',
    // 2026-10-14: the operator's append-only audit (execution/012), made when SHANNON_OPERATOR_MINECRAFT is first on.
    'operator_audit',
    // 2026-10-15: the FCA provenance sets (execution/013), made when SHANNON_FCA_PROVENANCE_REFS first opens the task runtime.
    'fca_provenance_sets',
    // 2026-10-14: the voice history's summaries and wants, made when SHANNON_VOICE_HISTORY_SUMMARY first takes effect.
    'conversation_voice_summaries', 'conversation_voice_summary_wants',
    // 2026-10-14: her feeling events (emotion/004, ADR-0013 stage 1), with their time index and primary-key index, made when
    // SHANNON_FEELING_EVENTS first opens their store.
    'shannon_feeling_events',
    // ADR-0013 stage 2: the shadow of her fast layer (emotion/005), made when SHANNON_CORE_AFFECT first opens its store.
    'shannon_feeling_shadow',
    // Her closed days (emotion/006, ADR-0013 stage 3), made when one of the stage-3 switches first opens their store.
    'shannon_feeling_days',
    // Her rewritten drafts (emotion/007, 2026-10-20), made when SHANNON_NATURAL_TALK first opens their store.
    'shannon_reply_drafts',
  ]),
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
  if (columns('agent_tasks').has('exec_starting')) {
    // Rows another writer touched after the state machine (an older build): the start's re-derivation brings it to 0.
    facts.taskRowsStale = Number(db.prepare('SELECT COUNT(*) AS count FROM agent_tasks WHERE updated_at > exec_state_at').get()?.count ?? 0);
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

/** Whether the slot tables hold exactly the rows of the last limit-writing step in the ledger (S3 review L5). */
export function slotSeedProblems(ledger, facts) {
  const ids = new Set(ledger.map(row => row.id));
  const step = ['execution/011_owner_slot_limits', 'execution/009_action_slots'].find(id => ids.has(id));
  if (!step) return [];
  const expected = SLOT_SEEDS[step];
  const pools = (facts.pools ?? []).map(row => `${row.pool}:${row.max_live}`).sort();
  const classes = (facts.classes ?? []).map(row => `${row.slot_class}:${row.pool}:${row.max_live}`).sort();
  const problems = [];
  if (JSON.stringify(pools) !== JSON.stringify(expected.pools)) problems.push(`slot pools ${pools.join(',')} are not the rows of ${step}`);
  if (JSON.stringify(classes) !== JSON.stringify(expected.classes)) problems.push(`slot classes ${classes.join(',')} are not the rows of ${step}`);
  return problems;
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
    const executionFacts = s3Facts(db);
    print(`s3: ${JSON.stringify(executionFacts)}`);
    const problems = [...schemaProblems(before, lines), ...ledgerProblems(seen.ledger), ...slotSeedProblems(seen.ledger, executionFacts)];
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
