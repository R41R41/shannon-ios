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
import { fcaHostPredicate } from '../src/mind/action/agentTasks/store/fcaHostPredicate.js';
import { TaskTreeStore } from '../src/mind/action/agentTasks/store/taskTreeStore.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { recordMindWorkerStart, syncLivenessEpisodes } from '../src/infra/ops/store/livenessStore.js';
import {
  applySchemaSteps, applySchemaStepsUnderLock, appliedSchemaSteps, schemaStepChecksum, SCHEMA_STEP_TABLE, type SchemaStep,
} from '../src/infra/sqlite/migrations/schemaSteps.js';
import {
  ACTION_THREADS_STEP, EXECUTION_STEPS, FCA_TASK_AUTHORITY_STEP,
} from '../src/infra/sqlite/migrations/executionSteps.js';
import { openDatabase, SQLITE_PROFILES, type SqliteProfileName } from '../src/infra/sqlite/sqliteOpen.js';
import { oldExecutionSchema, oldTaskRuntimeSchema } from './support/executionSchema88d7bfd0.js';

/**
 * Syzygy ADR-0009 stage 1, S2: the execution DDL moved into the schema steps and their ledger. On a database built by the old
 * constructors (88d7bfd0, copied verbatim in `support/executionSchema88d7bfd0.ts`) the new code adds the ledger table and
 * nothing else, keeps every row and is idempotent; a fresh database gets the same schema as before; two processes that open
 * the file at once apply each step once.
 */
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryPath(name = 'shannon.sqlite'): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-schema-steps-'));
  directories.push(directory);
  return join(directory, name);
}

type Row = Record<string, unknown>;

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
  it.each([['fresh at 88d7bfd0', false], ['grown through older versions', true]])('%s: adds the ledger and nothing else, twice', (_name, legacy) => {
    const path = temporaryPath();
    buildOld(path, legacy);
    const before = openDatabase(path, 'readOnly');
    const [oldSchema, oldRows] = [schema(before), contents(before)];
    before.close();
    expect(POPULATED.filter(table => (oldRows[table]?.length ?? 0) < ROWS)).toEqual([]);

    const first = openNew(path);
    expect(schema(first)).toEqual(oldSchema);
    expect(contents(first)).toEqual(oldRows);
    expect(checks(first)).toEqual({ integrity: 'ok', foreignKeys: [] });
    const ledger = appliedSchemaSteps(first);
    expect(new Map(ledger.map(step => [step.id, step.checksum]))).toEqual(new Map(EXECUTION_STEPS.map(step => [step.id, schemaStepChecksum(step)])));
    const ledgerTable = first.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(SCHEMA_STEP_TABLE);
    expect(ledgerTable?.sql).toBe('CREATE TABLE shannon_schema_steps(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    first.close();

    const second = openNew(path);
    expect(schema(second)).toEqual(oldSchema);
    expect(contents(second)).toEqual(oldRows);
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
    expect(schema(created)).toEqual(schema(old));
    expect(schema(created, true)).toEqual(schema(old, true));
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
      'execution/001_action_threads', 'execution/002_mind_worker_starts', 'execution/003_liveness_episodes',
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

  it('answers the Host predicate again until the FCA columns appear, then keeps it for the connection', () => {
    const path = temporaryPath();
    const host = openDatabase(path, 'agentTasks');
    migrateAgentTasks(host);
    expect(fcaHostPredicate(host, 't')).toBe('1=1');
    const fca = openDatabase(path, 'taskRuntime');
    new SQLiteFcaTaskAuthority(fca);
    expect(fcaHostPredicate(host, 't')).toBe('t.fca_kind IS NULL');
    expect(fcaHostPredicate(host)).toBe('fca_kind IS NULL');
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
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual([ACTION_THREADS_STEP.id]);
  });

  it('is applied under a lock the caller holds only when asked, and remembered nowhere', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => applySchemaStepsUnderLock(db, [ACTION_THREADS_STEP], '2026-10-12T00:00:00.000Z')).toThrow('SHANNON_SCHEMA_STEP_LOCK_REQUIRED');
    db.exec('BEGIN IMMEDIATE');
    applySchemaStepsUnderLock(db, [ACTION_THREADS_STEP], '2026-10-12T00:00:00.000Z');
    db.exec('ROLLBACK');
    expect(appliedSchemaSteps(db)).toEqual([]);
    new SQLiteActionStore(db);
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual([ACTION_THREADS_STEP.id]);
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
