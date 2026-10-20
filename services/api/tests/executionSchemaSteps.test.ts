import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { hostTaskPredicate } from '../src/mind/action/agentTasks/store/taskKinds.js';
import { TaskTreeStore } from '../src/mind/action/agentTasks/store/taskTreeStore.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { recordMindWorkerStart, syncLivenessEpisodes } from '../src/infra/ops/store/livenessStore.js';
import {
  applySchemaSteps, applySchemaStepsUnderLock, appliedSchemaSteps, schemaStepChecksum, SCHEMA_STEP_TABLE, type SchemaStep,
} from '../src/infra/sqlite/migrations/schemaSteps.js';
import {
  ACTION_SLOTS_STEP, ACTION_THREADS_STEP, EXECUTION_STEPS, FCA_TASK_AUTHORITY_STEP, OWNER_SLOT_LIMITS_STEP,
} from '../src/infra/sqlite/migrations/executionSteps.js';
import { openDatabase, SQLITE_PROFILES, type SqliteProfileName } from '../src/infra/sqlite/sqliteOpen.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { EMOTION_STEPS, FEELING_DAYS_STEPS, FEELING_SHADOW_STEPS, FEELING_STEPS, REPLY_DRAFTS_STEPS, REPLY_SONNET_DAYS_STEPS } from '../src/infra/sqlite/migrations/emotionSteps.js';
import { oldExecutionSchema, oldTaskRuntimeSchema } from './support/executionSchema88d7bfd0.js';

/**
 * Syzygy ADR-0009 stage 1, S2: the execution DDL moved into the schema steps and their ledger. On a database built by the old
 * constructors (88d7bfd0, copied verbatim in `support/executionSchema88d7bfd0.ts`) the new code adds the ledger table and,
 * since S3, the additive columns and slot tables of steps 008 and 009, and nothing else; it keeps every row and is idempotent;
 * a fresh database gets the same schema as before apart from those additions; two processes that open the file at once apply
 * each step once.
 */
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryPath(name = 'shannon.sqlite'): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-schema-steps-'));
  directories.push(directory);
  return join(directory, name);
}

type Row = Record<string, unknown>;

/**
 * What the S3 and S4 steps add (008, 009 and 010): columns appended by ALTER TABLE, and two tables (011 changes rows only); and
 * the operator's audit table of 012 (2026-10-14), and the FCA provenance sets of 013 (2026-10-15).
 */
const S3_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agent_tasks: ['task_kind TEXT', 'capability TEXT', 'exec_state TEXT', 'wait_reason TEXT', 'unknown_since TEXT', 'effect_class TEXT',
    'exec_state_at TEXT', 'exec_starting INTEGER'],
  mind_actions: ['task_id TEXT', 'slot_class TEXT', 'effect_sent INTEGER'],
};
const S3_TABLES = ['mind_action_slot_pools', 'mind_action_slot_classes', 'operator_audit', 'fca_provenance_sets'];

/** The schema rows without the S3 additions: what the S2 steps alone must leave unchanged. */
function withoutS3(rows: Row[]): Row[] {
  return rows.filter(row => !S3_TABLES.includes(String(row.tbl_name))).map(row => {
    const columns = row.type === 'table' ? S3_COLUMNS[String(row.name)] : undefined;
    if (!columns || typeof row.sql !== 'string') return row;
    return { ...row, sql: columns.reduce((text, column) => text.replace(`, ${column}`, ''), row.sql) };
  });
}

/** The rows without the S3 tables and columns (which the S2 steps' own check does not cover). */
function withoutS3Contents(all: Record<string, Row[]>): Record<string, Row[]> {
  const kept = Object.entries(all).filter(([table]) => !S3_TABLES.includes(table));
  return Object.fromEntries(kept.map(([table, rows]) => {
    const names = (S3_COLUMNS[table] ?? []).map(column => column.split(' ')[0]!);
    return [table, rows.map(row => Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name))))];
  }));
}

/** sqlite_master without the ledger, ordered; `normalised` folds whitespace. */
function schema(db: DatabaseSync, normalised = false): Row[] {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name != ? ORDER BY type, name`).all(SCHEMA_STEP_TABLE);
  return rows.map(row => ({ ...row, sql: normalised && typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : row.sql }));
}

function tables(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (?, 'sqlite_sequence') ORDER BY name`)
    .all(SCHEMA_STEP_TABLE);
  return rows.map(row => String(row.name));
}

function contents(db: DatabaseSync): Record<string, Row[]> {
  return Object.fromEntries(tables(db).map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
}

/** Older shapes of the tables that later gained columns, as a production file that lived through those versions has them. */
function legacyTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE fca_task_checkpoints (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      checkpoint_json TEXT, wait_reason TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, step_id TEXT, lease_json TEXT);
    CREATE TABLE fca_task_segment_receipts (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      lease_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE fca_task_sources (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, experience_id TEXT,
      observed_at TEXT NOT NULL, recalled_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE fca_task_history_summaries (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id), revision INTEGER NOT NULL,
      from_sequence INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
      template_json TEXT NOT NULL, sources_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
}

const ROWS = 3;

/** Values a column may not take at random (CHECKs, the one FCA root of a scope, the parent of a child task). */
const OVERRIDES: Readonly<Record<string, (index: number) => Row>> = {
  agent_tasks: index => ({ status: 'running', latest_sequence: index, is_pinned: 0, is_archived: 0,
    fca_kind: ['root', 'work', null][index], fca_parent_id: index === 1 ? 'agent_tasks:task_id:0' : null, fca_origin: index < 2 ? 'owner_request' : null }),
  agent_task_events: index => ({ tone: 'neutral', sequence: index + 1 }),
  agent_task_commands: index => ({ command_type: 'start', status: 'pending', attempts: 0, sequence: index + 1 }),
  mind_actions: index => ({ state: ['running', 'unknown', 'completed'][index], resources_json: '[]', base_resources_json: '[]' }),
  fca_task_history: index => ({ sequence: index + 1 }),
};

function references(db: DatabaseSync, table: string): Map<string, { table: string; column: string }> {
  const rows = db.prepare(`SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)`).all(table);
  return new Map(rows.map(row => [String(row.from), { table: String(row.table), column: String(row.to) }]));
}

function value(table: string, column: { name: string; type: string }, index: number, target?: { table: string; column: string }): unknown {
  if (target) return `${target.table}:${target.column}:${index}`;
  if (column.type.startsWith('INTEGER')) return index;
  if (column.type.startsWith('REAL')) return index + 0.5;
  return column.name.endsWith('_json') ? JSON.stringify({ table, index }) : `${table}:${column.name}:${index}`;
}

/** Realistic-shaped synthetic rows in every execution table, parents first; every foreign key points at a real row. */
function populate(db: DatabaseSync, order: readonly string[]): void {
  for (const table of order) {
    const columns = db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(table) as Array<{ name: string; type: string }>;
    const targets = references(db, table);
    const insert = db.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column.name}"`).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`);
    for (let index = 0; index < ROWS; index += 1) {
      const fixed = OVERRIDES[table]?.(index) ?? {};
      const row = columns.map(column => column.name in fixed ? fixed[column.name] : value(table, column, index, targets.get(column.name)));
      insert.run(...(row as Array<string | number | null>));
    }
  }
}

const POPULATED = ['agent_hosts', 'agent_tasks', 'agent_task_events', 'agent_task_commands', 'mind_actions', 'mind_action_budget',
  'mind_action_notice_receipts', 'mind_action_controls', 'mind_action_acknowledgements', 'mind_action_resource_acknowledgements',
  'mind_action_retained_resources', 'mind_action_retained_releases', 'mind_worker_starts', 'mind_worker_start_revisions',
  'ops_liveness_episodes', 'fca_task_checkpoints', 'fca_task_dispatch_order', 'fca_task_messages', 'fca_task_history',
  'fca_task_segment_receipts', 'fca_task_progress', 'fca_task_place_context', 'fca_task_sources', 'fca_task_source_links',
  'fca_task_history_summaries', 'fca_task_maintenance', 'fca_conversation_deliveries', 'agent_task_trees', 'agent_task_tree_versions',
  'agent_task_tree_attempts', 'agent_task_tree_proposals', 'agent_task_tree_proposal_ops', 'agent_task_tree_receipts',
  'agent_task_tree_learning', 'fca_touch_receipts'];

/** The old path: the Agent Host store's migration (unchanged by S2), then every old constructor's DDL. */
function buildOld(path: string, legacy: boolean): void {
  const db = openDatabase(path, 'taskRuntime');
  migrateAgentTasks(db);
  if (legacy) legacyTables(db);
  oldExecutionSchema(db);
  populate(db, POPULATED);
  db.close();
}

/** The new path: the constructors that make no rows, and the runner for the steps whose owners write when they run. */
function openNew(path: string): DatabaseSync {
  const db = openDatabase(path, 'taskRuntime');
  new SQLiteActionStore(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => false });
  new TaskTreeStore(db);
  applySchemaSteps(db, EXECUTION_STEPS);
  return db;
}

function checks(db: DatabaseSync): { integrity: unknown; foreignKeys: unknown[] } {
  return { integrity: db.prepare('PRAGMA integrity_check').get()?.integrity_check, foreignKeys: db.prepare('PRAGMA foreign_key_check').all() };
}

describe('the execution schema steps on a database built by 88d7bfd0', () => {
  it.each([['fresh at 88d7bfd0', false], ['grown through older versions', true]])('%s: adds the ledger and the S3 additions only, twice', (_name, legacy) => {
    const path = temporaryPath();
    buildOld(path, legacy);
    const before = openDatabase(path, 'readOnly');
    const [oldSchema, oldRows] = [schema(before), contents(before)];
    before.close();
    expect(POPULATED.filter(table => (oldRows[table]?.length ?? 0) < ROWS)).toEqual([]);

    const first = openNew(path);
    expect(withoutS3(schema(first))).toEqual(oldSchema);
    expect(withoutS3Contents(contents(first))).toEqual(oldRows);
    expect(first.prepare('SELECT COUNT(*) AS count FROM mind_actions WHERE slot_class IS NULL').get()?.count).toBe(ROWS);
    expect(checks(first)).toEqual({ integrity: 'ok', foreignKeys: [] });
    const ledger = appliedSchemaSteps(first);
    expect(new Map(ledger.map(step => [step.id, step.checksum]))).toEqual(new Map(EXECUTION_STEPS.map(step => [step.id, schemaStepChecksum(step)])));
    const ledgerTable = first.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(SCHEMA_STEP_TABLE);
    expect(ledgerTable?.sql).toBe('CREATE TABLE shannon_schema_steps(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    first.close();

    const second = openNew(path);
    expect(withoutS3(schema(second))).toEqual(oldSchema);
    expect(withoutS3Contents(contents(second))).toEqual(oldRows);
    expect(appliedSchemaSteps(second)).toEqual(ledger);
    expect(checks(second)).toEqual({ integrity: 'ok', foreignKeys: [] });
    second.close();
  });

  it('makes a fresh database byte for byte as the old constructors did', () => {
    const oldPath = temporaryPath('old.sqlite');
    const old = openDatabase(oldPath, 'taskRuntime');
    migrateAgentTasks(old);
    oldExecutionSchema(old);
    const newPath = temporaryPath('new.sqlite');
    const fresh = openDatabase(newPath, 'taskRuntime');
    migrateAgentTasks(fresh);
    fresh.close();
    const created = openNew(newPath);
    expect(withoutS3(schema(created))).toEqual(schema(old));
    expect(withoutS3(schema(created, true))).toEqual(schema(old, true));
    old.close();
    created.close();
  });

  it('keeps the old order of a step: the runtime creates its history table before the history store adds its columns', () => {
    const old = new DatabaseSync(':memory:');
    migrateAgentTasks(old);
    oldTaskRuntimeSchema(old);
    const created = new DatabaseSync(':memory:');
    migrateAgentTasks(created);
    new SQLiteTaskRuntimeStore(created, { authority: new SQLiteFcaTaskAuthority(created), leaseValid: () => false });
    const history = (db: DatabaseSync) => db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'fca_task_history'`).get()?.sql;
    expect(history(created)).toBe(history(old));
  });
});

describe('the ledger', () => {
  it('refuses a recorded step whose operations changed, loudly and without running it again', () => {
    const path = preparedFile();
    openNew(path).close();
    const tamper = new DatabaseSync(path);
    tamper.prepare(`UPDATE ${SCHEMA_STEP_TABLE} SET checksum = 'edited' WHERE id = ?`).run(ACTION_THREADS_STEP.id);
    const before = schema(tamper);
    tamper.close();
    const db = openDatabase(path, 'mindWorker');
    expect(() => new SQLiteActionStore(db)).toThrow(`SHANNON_SCHEMA_STEP_CHANGED:${ACTION_THREADS_STEP.id}`);
    expect(schema(db)).toEqual(before);
    db.close();
  });

  it('records nothing for the FCA authority before agent_tasks exists, as the constructor refused before', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => new SQLiteFcaTaskAuthority(db)).toThrow('FCA_AGENT_TASKS_MIGRATION_REQUIRED');
    expect(appliedSchemaSteps(db).map(step => step.id)).not.toContain(FCA_TASK_AUTHORITY_STEP.id);
    migrateAgentTasks(db);
    new SQLiteFcaTaskAuthority(db);
    expect(appliedSchemaSteps(db).map(step => step.id)).toContain(FCA_TASK_AUTHORITY_STEP.id);
  });

  it('leaves a switched-off part historical: the action threads alone add no FCA column to agent_tasks', () => {
    const db = new DatabaseSync(':memory:');
    migrateAgentTasks(db);
    const historical = schema(db).find(row => row.name === 'agent_tasks');
    new SQLiteActionStore(db);
    recordMindWorkerStart(db, '2026-10-12T00:00:00.000Z', 'revision');
    syncLivenessEpisodes(db, 'owner', ['sleep_stalled'], '2026-10-12T00:00:00.000Z');
    expect(schema(db).find(row => row.name === 'agent_tasks')).toEqual(historical);
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual([
      'execution/001_action_threads', 'execution/009_action_slots', 'execution/011_owner_slot_limits', 'execution/002_mind_worker_starts',
      'execution/003_liveness_episodes',
    ]);
  });

  it('takes no write lock once every step is recorded', () => {
    const path = preparedFile();
    openNew(path).close();
    const holder = openDatabase(path, 'taskRuntime');
    holder.exec('BEGIN IMMEDIATE');
    const reader = new DatabaseSync(path);
    reader.exec('PRAGMA busy_timeout=0;');
    expect(() => applySchemaSteps(reader, EXECUTION_STEPS)).not.toThrow();
    holder.exec('ROLLBACK');
    holder.close();
    reader.close();
  });

  it('answers the Host predicate again until the task kind column appears, then keeps it for the connection', () => {
    const path = temporaryPath();
    const host = openDatabase(path, 'agentTasks');
    migrateAgentTasks(host);
    expect(hostTaskPredicate(host, 't')).toBe('1=1');
    const fca = openDatabase(path, 'taskRuntime');
    new SQLiteFcaTaskAuthority(fca);
    expect(hostTaskPredicate(host, 't')).toBe("t.task_kind = 'codex'");
    expect(hostTaskPredicate(host)).toBe("task_kind = 'codex'");
    fca.close();
    host.close();
  });
});

/** The checksums of the applied steps, written out: a step that changes in words fails here before it fails a boot. */
const PINNED: Readonly<Record<string, string>> = {
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
  'execution/013_fca_provenance_sets': '628187523990f2531313993c8788fdba8f041441225a1aa61838349decc7aa55',
};

function reindented(step: SchemaStep): SchemaStep {
  const spaced = (text: string) => `\n   ${text.replace(/ /gu, '  \n\t')}  `;
  return { id: step.id, operations: step.operations.map(operation => {
    if ('sql' in operation) return { sql: spaced(operation.sql) };
    if ('requireTable' in operation) return { requireTable: { table: operation.requireTable.table, error: ` ${operation.requireTable.error}` } };
    return { addColumn: { ...operation.addColumn, definition: spaced(operation.addColumn.definition) } };
  }) };
}

describe('the pinned checksums', () => {
  it('are the checksums of the steps as written', () => {
    expect(Object.fromEntries(EXECUTION_STEPS.map(step => [step.id, schemaStepChecksum(step)]))).toEqual(PINNED);
  });

  it('do not move with whitespace, and move with words', () => {
    for (const step of EXECUTION_STEPS) expect(schemaStepChecksum(reindented(step))).toBe(PINNED[step.id]);
    const first = ACTION_THREADS_STEP.operations[0] as { sql: string };
    const reworded: SchemaStep = { id: ACTION_THREADS_STEP.id, operations: [{ sql: first.sql.replace('TEXT', 'BLOB') }, ...ACTION_THREADS_STEP.operations.slice(1)] };
    expect(schemaStepChecksum(reworded)).not.toBe(PINNED[ACTION_THREADS_STEP.id]);
  });

  it('are what the production check script expects', () => {
    const path = temporaryPath();
    buildOld(path, true);
    const before = `${path}.before.jsonl`;
    const script = fileURLToPath(new URL('../../../scripts/verify-schema-steps.mjs', import.meta.url));
    const dump = spawnSync(process.execPath, [script, 'dump', path, before], { encoding: 'utf8' });
    expect(dump.status).toBe(0);
    openNew(path).close();
    const check = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(check.stdout).toContain('SCHEMA_UNCHANGED_AND_LEDGER_PINNED');
    expect(check.status).toBe(0);
    const tamper = new DatabaseSync(path);
    tamper.prepare(`UPDATE ${SCHEMA_STEP_TABLE} SET checksum = 'edited' WHERE id = ?`).run(ACTION_THREADS_STEP.id);
    tamper.exec('CREATE TABLE unexpected (id TEXT)');
    tamper.close();
    const failed = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(`checksum of ${ACTION_THREADS_STEP.id} is edited`);
    expect(failed.stdout).toContain('"name":"unexpected"');
  });

  it('accepts the voice history summary\'s additions on a database the API made (owner decision 2026-10-14), and nothing else', () => {
    const path = temporaryPath();
    const at = '2026-10-14T00:00:00.000Z';
    // Before the deploy: the API with replay epochs, without the voice summary (its tables and its epoch column absent).
    const old = new SQLiteShannonStore({ path, now: () => at, replayEpochs: true, voiceSummaries: false });
    old.saveReplayEpoch('owner', 'thread', 'voice', { epoch: 1, startMessageId: 'a', fullFromMessageId: 'a', budgetCharacters: 12_000, startedAt: at });
    old.close();
    const before = `${path}.before.jsonl`;
    const script = fileURLToPath(new URL('../../../scripts/verify-schema-steps.mjs', import.meta.url));
    expect(spawnSync(process.execPath, [script, 'dump', path, before], { encoding: 'utf8' }).status).toBe(0);
    // After: the new code opens it with the summary on, as every service does at its start.
    const current = new SQLiteShannonStore({ path, now: () => at, replayEpochs: true, voiceSummaries: true });
    current.close();
    const columns = new DatabaseSync(path, { readOnly: true });
    expect((columns.prepare('PRAGMA table_info(conversation_replay_epochs)').all() as Array<{ name: string }>).map(row => row.name))
      .toContain('summary_version');
    columns.close();
    const check = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(check.stdout).toContain('SCHEMA_UNCHANGED_AND_LEDGER_PINNED');
    expect(check.status).toBe(0);
    const tamper = new DatabaseSync(path);
    tamper.exec('ALTER TABLE conversation_replay_epochs ADD COLUMN unexpected TEXT');
    tamper.close();
    const failed = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('unexpected TEXT');
  });

  it('pins her inner note steps as production\'s ledger holds them, so a deploy check passes cleanly (2026-10-14)', () => {
    const path = temporaryPath();
    buildOld(path, true);
    // As on the VM since 2026-10-13: the inner note's steps are applied before the deploy and stay as they were.
    const emotion = new DatabaseSync(path); applySchemaSteps(emotion, EMOTION_STEPS); emotion.close();
    const before = `${path}.before.jsonl`;
    const script = fileURLToPath(new URL('../../../scripts/verify-schema-steps.mjs', import.meta.url));
    expect(spawnSync(process.execPath, [script, 'dump', path, before], { encoding: 'utf8' }).status).toBe(0);
    openNew(path).close();
    const check = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(check.stdout).not.toContain('unknown step');
    expect(check.stdout).toContain('SCHEMA_UNCHANGED_AND_LEDGER_PINNED');
    expect(check.status).toBe(0);
    expect(EMOTION_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/001_inner_notes', 'd683a488c6ec1095487a1f8cb721506c571bc59e9bbff5e0b876c7fa9c49e3cc'],
      ['emotion/002_inner_note_episodes', '82db51e74ebb56f08b3392b192a27490a0f3fc111deb956c022a59b9497452df'],
      ['emotion/003_inner_note_attempts', 'da679362296ea082a98c9b58ea1105862782f38e1f131b07162f319eddee1010'],
    ]);
    // Syzygy ADR-0013 stage 1: her feeling events, applied only while `SHANNON_FEELING_EVENTS` opens their store.
    expect(FEELING_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/004_feeling_events', 'f137c35156c7d3d0e875309beead90cd72bb9115bcd44d8cad54e4baf2fdc462'],
    ]);
    // Stage 2's shadow (`SHANNON_CORE_AFFECT`) and stage 3's closed days (the stage-3 switches), each only when its switch opens its store.
    expect(FEELING_SHADOW_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/005_feeling_shadow', '314d33b616f087a45219f75637ddd480aa15bdcaade1d830ab1130e7996ee5b2'],
    ]);
    expect(FEELING_DAYS_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/006_feeling_days', '27736c122507ed4e21734c7831dbb340630702d23a4cbe35dc9d97081efefb55'],
    ]);
    // Owner 2026-10-20: her rewritten drafts, only when `SHANNON_NATURAL_TALK` opens their store.
    expect(REPLY_DRAFTS_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/007_reply_drafts', 'f1566b8c0014345f439840bb5e87d2d18057dcefff903f6135be449e5efeea69'],
    ]);
    // Owner 2026-10-21: her replies on Sonnet counted per day, only when `SHANNON_REPLY_SONNET` opens their store.
    expect(REPLY_SONNET_DAYS_STEPS.map(step => [step.id, schemaStepChecksum(step)])).toEqual([
      ['emotion/008_reply_sonnet_days', 'a5f2d09ba445b97ecd2ef91c4a98ffb413e4d346621cc544aaf6c412642bd3a8'],
    ]);
  });

  it('passes a deploy across which her feeling events step was applied, and pins it (ADR-0013 stage 1, 2026-10-14)', () => {
    const path = temporaryPath();
    buildOld(path, true);
    const emotion = new DatabaseSync(path); applySchemaSteps(emotion, EMOTION_STEPS); emotion.close();
    const before = `${path}.before.jsonl`;
    const script = fileURLToPath(new URL('../../../scripts/verify-schema-steps.mjs', import.meta.url));
    expect(spawnSync(process.execPath, [script, 'dump', path, before], { encoding: 'utf8' }).status).toBe(0);
    openNew(path).close();
    // As in production when the stage-1 switches went on: the step, its table and its two indexes appear across the deploy.
    const feeling = new DatabaseSync(path); applySchemaSteps(feeling, FEELING_STEPS); feeling.close();
    const check = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(check.stdout).not.toContain('unknown step');
    expect(check.stdout).not.toContain('shannon_feeling_events');
    expect(check.stdout).toContain('SCHEMA_UNCHANGED_AND_LEDGER_PINNED');
    expect(check.status).toBe(0);
    const indexes = new DatabaseSync(path, { readOnly: true });
    expect(indexes.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shannon_feeling_events'").get()).toEqual({ n: 2 });
    indexes.close();
  });

  it('holds the slot tables to the rows the ledger says were written (S3 review L5)', () => {
    const path = temporaryPath();
    buildOld(path, false);
    const before = `${path}.before.jsonl`;
    const script = fileURLToPath(new URL('../../../scripts/verify-schema-steps.mjs', import.meta.url));
    expect(spawnSync(process.execPath, [script, 'dump', path, before], { encoding: 'utf8' }).status).toBe(0);
    openNew(path).close();
    const check = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(check.stdout).toContain('"pools":[{"pool":"background","max_live":3},{"pool":"foreground","max_live":1},{"pool":"touch","max_live":1}]');
    expect(check.status).toBe(0);
    const tamper = new DatabaseSync(path);
    tamper.exec("UPDATE mind_action_slot_pools SET max_live = 2 WHERE pool = 'background'; DELETE FROM mind_action_slot_classes WHERE slot_class = 'touch'");
    tamper.close();
    const failed = spawnSync(process.execPath, [script, 'check', path, before], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('slot pools background:2,foreground:1,touch:1 are not the rows of execution/011_owner_slot_limits');
    expect(failed.stdout).toContain('are not the rows of execution/011_owner_slot_limits');
  });
});

describe('a step inside a transaction of the caller', () => {
  it('is refused while it still has to be applied, so a rollback cannot leave it noted as done', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('BEGIN');
    expect(() => new SQLiteActionStore(db)).toThrow(`SHANNON_SCHEMA_STEP_IN_TRANSACTION:${ACTION_THREADS_STEP.id}`);
    db.exec('ROLLBACK');
    new SQLiteActionStore(db);
    db.exec('BEGIN');
    expect(() => new SQLiteActionStore(db)).not.toThrow();
    db.exec('ROLLBACK');
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual([ACTION_THREADS_STEP.id, ACTION_SLOTS_STEP.id, OWNER_SLOT_LIMITS_STEP.id]);
  });

  it('is applied under a lock the caller holds only when asked, and remembered nowhere', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => applySchemaStepsUnderLock(db, [ACTION_THREADS_STEP], '2026-10-12T00:00:00.000Z')).toThrow('SHANNON_SCHEMA_STEP_LOCK_REQUIRED');
    db.exec('BEGIN IMMEDIATE');
    applySchemaStepsUnderLock(db, [ACTION_THREADS_STEP], '2026-10-12T00:00:00.000Z');
    db.exec('ROLLBACK');
    expect(appliedSchemaSteps(db)).toEqual([]);
    new SQLiteActionStore(db);
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual([ACTION_THREADS_STEP.id, ACTION_SLOTS_STEP.id, OWNER_SLOT_LIMITS_STEP.id]);
  });
});

const root = fileURLToPath(new URL('../../..', import.meta.url));
const child = fileURLToPath(new URL('./support/schemaStepsChild.ts', import.meta.url));

interface ChildResult { ok: boolean; error?: string; waitedMs?: number; ledger?: Array<{ id: string; checksum: string; appliedAt: string }> }

function run(path: string, marker?: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const args = ['--import', 'tsx', child, path, ...(marker ? [marker] : [])];
    const process_ = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    process_.stdout.on('data', chunk => { out += String(chunk); });
    process_.stderr.on('data', chunk => { err += String(chunk); });
    process_.on('error', reject);
    process_.on('close', code => {
      const line = out.trim().split('\n').filter(item => item.startsWith('{')).at(-1);
      if (code !== 0 || !line) reject(new Error(`child exited ${code}: ${err.slice(0, 2_000)}`));
      else resolve(JSON.parse(line) as ChildResult);
    });
  });
}

function preparedFile(): string {
  const path = temporaryPath();
  const db = openDatabase(path, 'agentTasks');
  migrateAgentTasks(db);
  db.close();
  return path;
}

describe('two processes opening the file at once', () => {
  it('apply each step once and agree on the ledger', async () => {
    const path = preparedFile();
    const results = await Promise.all([run(path), run(path)]);
    expect(results.map(result => result.error)).toEqual([undefined, undefined]);
    expect(results[0]!.ledger).toEqual(results[1]!.ledger);
    expect(results[0]!.ledger!.map(step => step.id).sort()).toEqual(EXECUTION_STEPS.map(step => step.id));
    const db = openDatabase(path, 'readOnly');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${SCHEMA_STEP_TABLE}`).get()?.count).toBe(EXECUTION_STEPS.length);
    expect(checks(db)).toEqual({ integrity: 'ok', foreignKeys: [] });
    db.close();
  }, 60_000);

  it('a process that found no ledger and then waited for the lock reads it again and runs nothing', async () => {
    const path = preparedFile();
    const marker = `${path}.ready`;
    const holder = openDatabase(path, 'taskRuntime');
    holder.exec('BEGIN IMMEDIATE');
    const waiting = run(path, marker);
    while (!existsSync(marker)) await delay(20);
    await delay(500);
    applySchemaStepsUnderLock(holder, EXECUTION_STEPS, '2026-10-12T00:00:00.000Z');
    holder.exec('COMMIT');
    const result = await waiting;
    expect(result.error).toBeUndefined();
    expect(result.waitedMs).toBeGreaterThan(300);
    expect(result.ledger!.map(step => step.appliedAt)).toEqual(EXECUTION_STEPS.map(() => '2026-10-12T00:00:00.000Z'));
    holder.close();
  }, 60_000);
});

/** The PRAGMAs each opener set before S2, copied verbatim from 88d7bfd0. */
const OLD_OPENERS: ReadonlyArray<[SqliteProfileName, string]> = [
  ['mindWorker', 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=750;'],
  ['taskRuntime', 'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;'],
  ['agentTasks', `
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `],
  ['minecraftLifecycle', 'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;'],
  ['liveness', 'PRAGMA busy_timeout = 5000;'],
  ['readOnly', 'PRAGMA busy_timeout=5000;'],
];

function settings(db: DatabaseSync): Row {
  const one = (pragma: string) => Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0];
  return { busy: one('busy_timeout'), foreignKeys: one('foreign_keys'), journal: one('journal_mode'), synchronous: one('synchronous') };
}

describe('the one opener', () => {
  it.each(OLD_OPENERS)('the %s profile sets what its opener set', (name, pragmas) => {
    const readOnly = SQLITE_PROFILES[name].readOnly;
    const [oldPath, newPath] = [temporaryPath('old.sqlite'), temporaryPath('new.sqlite')];
    for (const path of [oldPath, newPath]) new DatabaseSync(path).close();
    const old = new DatabaseSync(oldPath, readOnly ? { readOnly: true } : {});
    old.exec(pragmas);
    const opened = openDatabase(newPath, name);
    expect(settings(opened)).toEqual(settings(old));
    if (readOnly) expect(() => opened.exec('CREATE TABLE written (id TEXT)')).toThrow();
    old.close();
    opened.close();
  });
});
