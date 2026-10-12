import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SLOT_LIMITS_TODAY, deriveTask, fcaPhaseOf, type ExecState } from '@shannon/mind';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { countTaskProjection, taskExecution, taskFactsOf } from '../src/mind/action/agentTasks/store/taskExecutionColumns.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { backfillActionSlotBatch, countActionProjection } from '../src/mind/action/threads/store/actionSlotColumns.js';
import { appliedSchemaSteps } from '../src/infra/sqlite/migrations/schemaSteps.js';
import { openDatabase } from '../src/infra/sqlite/sqliteOpen.js';
import { backfillExecutionColumns, startExecutionBackfill } from '../src/wiring/executionBackfillWiring.js';
import { executionDailyLine, startExecutionMonitor } from '../src/wiring/executionOpsWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { oldExecutionSchema } from './support/executionSchema88d7bfd0.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * Syzygy ADR-0009 stage 1, S3: the execution columns (steps 008 and 009), their backfill and the dual write. A golden database
 * of the production shapes at 706120d4 is migrated and backfilled twice; every derived value is checked, the legacy columns
 * stay as they were, and the projection back onto them has no mismatch.
 */
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-s3-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

type Row = Record<string, unknown>;
const T0 = '2026-10-12T00:00:00.000Z';
const T1 = '2026-10-12T01:00:00.000Z';
const UNKNOWN_AT = '2026-10-12T00:30:00.000Z';
const HEX = 'b'.repeat(64);

interface TaskSeed {
  id: string; status: string; pause?: string | null; current?: string | null; fca?: string | null; parent?: string | null;
  origin?: string | null; step?: string | null; stop?: number; wait?: string | null;
}

/** The old columns only, as the build of 706120d4 writes them. */
function insertTask(db: DatabaseSync, seed: TaskSeed): void {
  db.prepare(`INSERT INTO agent_tasks(task_id,scope_key,conversation_thread_id,start_idempotency_key,title,goal,status,summary,current_action,
    created_at,updated_at,latest_sequence,pause_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(seed.id, 'owner', `thread:${seed.id}`, `start:${seed.id}`, seed.id, 'goal', seed.status, 'summary', seed.current ?? null, T0, T1,
      seed.pause ?? null);
  if (!seed.fca) return;
  db.prepare('UPDATE agent_tasks SET fca_kind = ?, fca_parent_id = ?, fca_origin = ? WHERE task_id = ?')
    .run(seed.fca, seed.parent ?? null, seed.origin ?? 'owner_request', seed.id);
  db.prepare('INSERT INTO fca_task_checkpoints(task_id,wait_reason,stop_requested,step_id,lease_json) VALUES(?,?,?,?,?)')
    .run(seed.id, seed.wait ?? null, seed.stop ?? 0, seed.step ?? null, seed.step ? '{"id":"a","generation":1,"holder":"h"}' : null);
}

const CODEX_TASKS: TaskSeed[] = [
  { id: 'c-proposed', status: 'proposed' }, { id: 'c-queued', status: 'queued' }, { id: 'c-starting', status: 'starting', current: '接続中' },
  { id: 'c-running', status: 'running' }, { id: 'c-approval', status: 'waiting_approval' }, { id: 'c-owner', status: 'paused', pause: 'owner' },
  { id: 'c-needs', status: 'paused', pause: 'needs_owner', current: '再開してください' },
  { id: 'c-legacy-needs', status: 'paused', current: '続きが必要' }, { id: 'c-legacy-owner', status: 'paused' },
  { id: 'c-done', status: 'completed' }, { id: 'c-failed', status: 'failed' }, { id: 'c-cancelled', status: 'cancelled' },
];

const FCA_TASKS: TaskSeed[] = [
  { id: 'root', status: 'running', fca: 'root' },
  { id: 'conversation', status: 'running', fca: 'conversation', parent: 'root', step: 'step-c' },
  { id: 'r-ready', status: 'queued', fca: 'research', parent: 'root' },
  { id: 'r-wait', status: 'running', fca: 'research', parent: 'root', wait: 'message' },
  { id: 'g-stopped', status: 'paused', pause: 'fca_stopped', fca: 'generic', parent: 'root', stop: 1 },
  { id: 'r-unknown', status: 'paused', pause: 'fca_unknown', fca: 'research', parent: 'root', step: 'step-u' },
  { id: 'g-unknown', status: 'paused', pause: 'fca_unknown', fca: 'generic', parent: 'root' },
  { id: 'sleep', status: 'running', fca: 'sleep', origin: 'maintenance', step: 'step-s' },
  { id: 'r-stopping', status: 'running', fca: 'research', parent: 'root', step: 'step-x', stop: 1 },
  { id: 'r-child', status: 'queued', fca: 'research', parent: 'r-wait' },
  { id: 'r-done', status: 'completed', fca: 'research', parent: 'root' },
  { id: 'g-failed', status: 'failed', fca: 'generic', parent: 'root' },
  { id: 'r-cancelled', status: 'cancelled', fca: 'research', parent: 'root' },
];

/** task id → kind, state, wait reason, effect class, unknown since. */
const EXPECTED_TASKS: Readonly<Record<string, [string, ExecState, string | null, string, string | null]>> = {
  'c-proposed': ['codex', 'proposed', null, 'external', null], 'c-queued': ['codex', 'ready', null, 'external', null],
  'c-starting': ['codex', 'active', null, 'external', null], 'c-running': ['codex', 'active', null, 'external', null],
  'c-approval': ['codex', 'waiting', 'approval', 'external', null], 'c-owner': ['codex', 'stopped', null, 'external', null],
  'c-needs': ['codex', 'waiting', 'owner', 'external', null], 'c-legacy-needs': ['codex', 'waiting', 'owner', 'external', null],
  'c-legacy-owner': ['codex', 'stopped', null, 'external', null], 'c-done': ['codex', 'completed', null, 'external', null],
  'c-failed': ['codex', 'failed', null, 'external', null], 'c-cancelled': ['codex', 'cancelled', null, 'external', null],
  root: ['root', 'waiting', null, 'none', null], conversation: ['conversation', 'active', null, 'none', null],
  'r-ready': ['work', 'ready', null, 'none', null], 'r-wait': ['work', 'waiting', 'message', 'none', null],
  'g-stopped': ['work', 'stopped', null, 'none', null], 'r-unknown': ['work', 'unknown', null, 'none', UNKNOWN_AT],
  'g-unknown': ['work', 'unknown', null, 'none', T1], sleep: ['sleep', 'active', null, 'none', null],
  'r-stopping': ['work', 'stopping', null, 'none', null], 'r-child': ['work', 'ready', null, 'none', null],
  'r-done': ['work', 'completed', null, 'none', null], 'g-failed': ['work', 'failed', null, 'none', null],
  'r-cancelled': ['work', 'cancelled', null, 'none', null],
};

interface ActionSeed { id: string; kind: string; source: string; state: string; sent?: number; resources?: string[] }

function insertAction(db: DatabaseSync, seed: ActionSeed): void {
  const resources = JSON.stringify(seed.resources ?? []);
  const live = ['running', 'waiting', 'stopping'].includes(seed.state);
  db.prepare(`INSERT INTO mind_actions(id,scope_key,kind,origin,source_id,state,generation,holder,last_holder,lease_until,resources_json,
    base_resources_json,owner_informed,sent,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,1,?,?,?)`)
    .run(seed.id, 'owner', seed.kind, seed.kind === 'ownTime' ? 'own_time' : 'owner_request', seed.source, seed.state, live ? 'h' : null, 'h',
      live ? '2026-10-12T02:00:00.000Z' : null, resources, resources, seed.sent ?? 0, T0, T1);
}

const RESOURCE = `res:${'c'.repeat(64)}`;
const ACTIONS: ActionSeed[] = [
  { id: 'a-respond', kind: 'respond', source: 'turn-1', state: 'completed' },
  { id: 'a-respond-live', kind: 'respond', source: 'turn-2', state: 'running' },
  { id: 'a-own', kind: 'ownTime', source: 'cycle-1', state: 'unknown' },
  { id: 'a-research', kind: 'agentTask', source: 'fca:r-wait:3', state: 'running', sent: 1 },
  { id: 'a-sleep', kind: 'agentTask', source: 'fca:sleep:1', state: 'completed', sent: 1 },
  { id: 'a-root', kind: 'agentTask', source: 'fca:root:7', state: 'cancelled' },
  { id: 'a-gone', kind: 'agentTask', source: 'fca:gone:1', state: 'cancelled' },
  { id: 'a-codex', kind: 'agentTask', source: 'c-running', state: 'unknown', sent: 1, resources: [RESOURCE] },
  { id: 'a-touch', kind: 'agentTask', source: `touch:${HEX}`, state: 'completed' },
  { id: 'a-minecraft', kind: 'minecraft', source: 'request-1', state: 'running', sent: 1, resources: [`res:${'d'.repeat(64)}`] },
  { id: 'a-lost', kind: 'agentTask', source: 'lost-source', state: 'failed' },
  { id: 'a-fca-id', kind: 'agentTask', source: 'r-ready', state: 'completed' },
];

/** action id → task id, slot class, effect sent. */
const EXPECTED_ACTIONS: Readonly<Record<string, [string | null, string, number]>> = {
  'a-respond': [null, 'respond', 0], 'a-respond-live': [null, 'respond', 0], 'a-own': [null, 'creative', 1],
  'a-research': ['r-wait', 'research', 1], 'a-sleep': ['sleep', 'sleep', 1], 'a-root': ['root', 'research', 0],
  'a-gone': ['gone', 'other', 0], 'a-codex': ['c-running', 'codex', 1], 'a-touch': [null, 'touch', 0],
  'a-minecraft': [null, 'minecraft', 1], 'a-lost': [null, 'other', 0], 'a-fca-id': [null, 'other', 0],
};

/** The production shapes at 706120d4 with realistic rows: Codex tasks with a tree, FCA tasks, unknown actions, retained keys. */
function buildGolden(path: string): void {
  const db = openDatabase(path, 'taskRuntime');
  migrateAgentTasks(db);
  oldExecutionSchema(db);
  for (const seed of [...CODEX_TASKS, ...FCA_TASKS]) insertTask(db, seed);
  db.prepare(`INSERT INTO agent_task_events(event_id,task_id,sequence,event_type,title,tone,occurred_at,payload_json)
    VALUES('e-unknown','r-unknown',2,'fca_recovery_unknown','fca_recovery_unknown','neutral',?,'{}')`).run(UNKNOWN_AT);
  db.prepare('INSERT INTO agent_task_trees(scope_key,task_id,revision,tree_json,updated_at) VALUES(?,?,?,?,?)')
    .run('owner', 'c-running', 1, '{"schema":"shannon.task-tree.v1"}', T0);
  for (const seed of ACTIONS) insertAction(db, seed);
  db.prepare('INSERT INTO mind_action_retained_resources(action_id,resource,retained_at) VALUES(?,?,?)').run('a-codex', RESOURCE, T1);
  db.close();
}

const S3_TASK_COLUMNS = ['task_kind', 'capability', 'exec_state', 'wait_reason', 'unknown_since', 'effect_class', 'exec_state_at'];
const S3_ACTION_COLUMNS = ['task_id', 'slot_class', 'effect_sent'];

function legacyRows(db: DatabaseSync, table: string, drop: readonly string[]): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => Object.fromEntries(Object.entries(row).filter(([name]) => !drop.includes(name))));
}

function checks(db: DatabaseSync) {
  return { integrity: db.prepare('PRAGMA integrity_check').get()?.integrity_check, foreignKeys: db.prepare('PRAGMA foreign_key_check').all() };
}

function zeroCounts(db: DatabaseSync) {
  return { tasks: countTaskProjection(db), actions: countActionProjection(db) };
}

const ZERO = { tasks: { mismatches: 0, nulls: 0 }, actions: { mismatches: 0, nulls: 0 } };

describe('the S3 columns on a golden database of 706120d4', () => {
  it('derives every column from the old ones, twice, and the second run writes nothing', async () => {
    const path = temporaryPath();
    buildGolden(path);
    const db = openDatabase(path, 'taskRuntime');
    const [tasksBefore, actionsBefore] = [legacyRows(db, 'agent_tasks', []), legacyRows(db, 'mind_actions', [])];
    const first = await backfillExecutionColumns(db, { batch: 5 });
    expect(first).toMatchObject({ tasks: CODEX_TASKS.length + FCA_TASKS.length, actions: ACTIONS.length });
    expect(await backfillExecutionColumns(db, { batch: 5 })).toMatchObject({ tasks: 0, actions: 0 });
    expect(legacyRows(db, 'agent_tasks', S3_TASK_COLUMNS)).toEqual(tasksBefore);
    expect(legacyRows(db, 'mind_actions', S3_ACTION_COLUMNS)).toEqual(actionsBefore);
    expect(checks(db)).toEqual({ integrity: 'ok', foreignKeys: [] });
    expect(zeroCounts(db)).toEqual(ZERO);
    expect(appliedSchemaSteps(db).map(step => step.id)).toEqual(['execution/008_task_execution_columns', 'execution/009_action_slots']);
    for (const row of db.prepare('SELECT * FROM agent_tasks').all()) {
      const [kind, state, wait, effect, since] = EXPECTED_TASKS[String(row.task_id)]!;
      expect([row.task_id, row.task_kind, row.exec_state, row.wait_reason, row.effect_class, row.unknown_since, row.capability])
        .toEqual([row.task_id, kind, state, wait, effect, since, null]);
      expect(row.exec_state_at).toBe(T1);
    }
    for (const row of db.prepare('SELECT * FROM mind_actions').all()) {
      expect([row.id, row.task_id, row.slot_class, row.effect_sent]).toEqual([row.id, ...EXPECTED_ACTIONS[String(row.id)]!]);
    }
    db.close();
  });

  it('seeds today\'s slot limits exactly', async () => {
    const path = temporaryPath();
    buildGolden(path);
    const db = openDatabase(path, 'taskRuntime');
    await backfillExecutionColumns(db);
    const pools = db.prepare('SELECT pool, max_live FROM mind_action_slot_pools ORDER BY pool').all();
    expect(Object.fromEntries(pools.map(row => [row.pool, row.max_live]))).toEqual(SLOT_LIMITS_TODAY.pools);
    const classes = db.prepare('SELECT slot_class, pool, max_live FROM mind_action_slot_classes').all();
    const seeded = Object.fromEntries(classes.map(row => [row.slot_class, { pool: row.pool, maxLive: row.max_live }]));
    expect(seeded).toEqual(SLOT_LIMITS_TODAY.classes);
    db.close();
  });

  it('gives each FCA task the phase the runtime shows', async () => {
    const path = temporaryPath();
    buildGolden(path);
    const db = openDatabase(path, 'taskRuntime');
    await backfillExecutionColumns(db);
    const authority = new SQLiteFcaTaskAuthority(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => false });
    for (const seed of FCA_TASKS.filter(task => task.origin !== 'maintenance')) {
      const row = db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(seed.id)!;
      expect([seed.id, fcaPhaseOf(row.exec_state as ExecState)]).toEqual([seed.id, runtime.get('owner', seed.id)?.phase]);
    }
    db.close();
  });

  it('fills what an older build wrote after the step, and corrects a state it left stale', async () => {
    const path = temporaryPath();
    buildGolden(path);
    const db = openDatabase(path, 'taskRuntime');
    await backfillExecutionColumns(db);
    insertTask(db, { id: 'c-late', status: 'queued' });
    insertAction(db, { id: 'a-late', kind: 'agentTask', source: 'c-late', state: 'running', sent: 1 });
    db.prepare("UPDATE agent_tasks SET status = 'completed', pause_reason = NULL WHERE task_id = 'c-owner'").run();
    db.prepare("UPDATE mind_actions SET sent = 0, state = 'completed' WHERE id = 'a-research'").run();
    expect(zeroCounts(db)).toEqual({ tasks: { mismatches: 1, nulls: 1 }, actions: { mismatches: 1, nulls: 1 } });
    await backfillExecutionColumns(db);
    expect(zeroCounts(db)).toEqual(ZERO);
    const late = db.prepare("SELECT exec_state, task_kind FROM agent_tasks WHERE task_id = 'c-late'").get();
    expect(late).toEqual({ exec_state: 'ready', task_kind: 'codex' });
    expect(db.prepare("SELECT task_id, slot_class, effect_sent FROM mind_actions WHERE id = 'a-late'").get())
      .toEqual({ task_id: 'c-late', slot_class: 'codex', effect_sent: 1 });
    expect(db.prepare("SELECT exec_state FROM agent_tasks WHERE task_id = 'c-owner'").get()?.exec_state).toBe('completed');
    db.close();
  });

  it('reads a row before the backfill by deriving it (dual read)', () => {
    const path = temporaryPath();
    buildGolden(path);
    const db = openDatabase(path, 'taskRuntime');
    new SQLiteFcaTaskAuthority(db);
    const row = db.prepare(`SELECT t.*, c.step_id AS c_step_id, c.stop_requested AS c_stop_requested, c.wait_reason AS c_wait_reason
      FROM agent_tasks t LEFT JOIN fca_task_checkpoints c ON c.task_id = t.task_id WHERE t.task_id = 'r-wait'`).get()!;
    expect(row.exec_state).toBeNull();
    expect(taskExecution(row)).toMatchObject({ taskKind: 'work', execState: 'waiting', waitReason: 'message' });
    expect(deriveTask(taskFactsOf(row))?.execState).toBe('waiting');
    db.close();
  });

  it('works on a database where the common runtime never ran: every task is Codex', async () => {
    const path = temporaryPath();
    const db = openDatabase(path, 'agentTasks');
    migrateAgentTasks(db);
    new SQLiteActionStore(db);
    insertTask(db, { id: 'c-only', status: 'running' });
    insertAction(db, { id: 'a-only', kind: 'agentTask', source: 'c-only', state: 'running', sent: 1 });
    await backfillExecutionColumns(db);
    expect(db.prepare('SELECT task_kind, exec_state FROM agent_tasks').get()).toEqual({ task_kind: 'codex', exec_state: 'active' });
    expect(db.prepare('SELECT task_id, slot_class FROM mind_actions').get()).toEqual({ task_id: 'c-only', slot_class: 'codex' });
    expect(zeroCounts(db)).toEqual(ZERO);
    db.close();
  });

  it('keeps each batch short on many actions', () => {
    const db = new DatabaseSync(':memory:');
    new SQLiteActionStore(db);
    db.exec('BEGIN');
    for (let index = 0; index < 20_000; index += 1) insertAction(db, { id: `bulk-${index}`, kind: 'respond', source: `turn-${index}`, state: 'completed' });
    db.exec('COMMIT');
    db.prepare('UPDATE mind_actions SET slot_class = NULL, effect_sent = NULL').run();
    let after: number | null = 0;
    let batches = 0;
    let longest = 0;
    while (after !== null) {
      const started = performance.now();
      db.exec('BEGIN IMMEDIATE');
      const batch = backfillActionSlotBatch(db, after, 500);
      db.exec('COMMIT');
      longest = Math.max(longest, performance.now() - started);
      after = batch.next;
      batches += 1;
    }
    expect(batches).toBe(41);
    expect(longest).toBeLessThan(250);
    expect(countActionProjection(db)).toEqual({ mismatches: 0, nulls: 0 });
    db.close();
  });
});

describe('the dual write', () => {
  it('writes the action columns with every change of the action store', async () => {
    const db = new DatabaseSync(':memory:');
    migrateAgentTasks(db);
    const authority = new SQLiteFcaTaskAuthority(db);
    new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => false });
    insertTask(db, { id: 'c-host', status: 'running' });
    insertTask(db, { id: 'r-task', status: 'running', fca: 'research' });
    const h = actionHarness(() => T1, ':memory:', db);
    const enqueue = (kind: 'respond' | 'ownTime' | 'agentTask' | 'minecraft', sourceId: string) =>
      h.store.enqueue({ scopeKey: 'owner', kind, origin: kind === 'ownTime' ? 'own_time' : 'owner_request', sourceId }, T1);
    const codex = enqueue('agentTask', 'c-host');
    const research = enqueue('agentTask', 'fca:r-task:2');
    const touch = enqueue('agentTask', `touch:${HEX}`);
    const own = enqueue('ownTime', 'cycle-9');
    const columns = (id: string) => db.prepare('SELECT task_id, slot_class, effect_sent FROM mind_actions WHERE id = ?').get(id);
    expect(columns(codex.id)).toEqual({ task_id: 'c-host', slot_class: 'codex', effect_sent: 0 });
    expect(columns(research.id)).toEqual({ task_id: 'r-task', slot_class: 'research', effect_sent: 0 });
    expect(columns(touch.id)).toEqual({ task_id: null, slot_class: 'touch', effect_sent: 0 });
    expect(columns(own.id)).toEqual({ task_id: null, slot_class: 'creative', effect_sent: 0 });
    const claimed = h.store.claim(codex.id, 'runner', T1)!;
    const lease = { id: claimed.id, generation: claimed.generation, holder: 'runner' };
    expect(h.store.dispatch(lease, T1)).toBe(true);
    expect(columns(codex.id)).toMatchObject({ effect_sent: 1 });
    expect(countActionProjection(db)).toEqual({ mismatches: 0, nulls: 0 });
    h.store.sweep('2026-10-12T02:00:00.000Z');
    expect(h.store.get(codex.id)).toMatchObject({ state: 'unknown', sent: true });
    h.store.sweep('2026-10-12T03:00:00.000Z');
    expect(h.store.get(codex.id)).toMatchObject({ state: 'unknown', sent: false, result: 'unknown_expired' });
    expect(columns(codex.id)).toMatchObject({ effect_sent: 1 });
    expect(h.store.reconcile(lease, 'completed', 'done', '2026-10-12T03:00:01.000Z')).toBe(true);
    expect(columns(codex.id)).toMatchObject({ effect_sent: 0 });
    const second = h.store.claim(research.id, 'runner', T1)!;
    const researchLease = { id: second.id, generation: second.generation, holder: 'runner' };
    h.store.dispatch(researchLease, T1);
    h.store.finish(researchLease, 'unknown', 'lost', T1);
    expect(columns(research.id)).toMatchObject({ effect_sent: 1 });
    const third = h.store.claim(own.id, 'runner', T1)!;
    h.store.checkpoint({ id: third.id, generation: third.generation, holder: 'runner' }, 'step', T1);
    expect(columns(own.id)).toMatchObject({ effect_sent: 0 });
    h.store.stop('owner', null, 'stop-all', T1);
    expect(countActionProjection(db)).toEqual({ mismatches: 0, nulls: 0 });
    db.close();
  });

  it('writes the task columns with every event of an Agent Host task', () => {
    const path = temporaryPath();
    const store = new SQLiteAgentTaskStore(path);
    const reader = openDatabase(path, 'readOnly');
    const created = store.create('owner', { idempotencyKey: 'start', conversationThreadID: 'thread', title: '調査', goal: '原因', summary: '調べる。' }, T0);
    const state = () => reader.prepare('SELECT exec_state, wait_reason, task_kind, effect_class FROM agent_tasks WHERE task_id = ?').get(created.task.id);
    expect(state()).toEqual({ exec_state: 'ready', wait_reason: null, task_kind: 'codex', effect_class: 'external' });
    store.claim('mac', '2026-10-12T00:00:01.000Z');
    expect(state()).toMatchObject({ exec_state: 'active' });
    const event = (id: string, type: 'started' | 'approval_requested' | 'paused', payload: Record<string, unknown>, at: string) =>
      store.recordHostEvents('mac', [{ eventId: id, taskId: created.task.id, type, title: type, occurredAt: at, payload }], at);
    event('e1', 'started', {}, '2026-10-12T00:00:02.000Z');
    expect(state()).toMatchObject({ exec_state: 'active' });
    const approval = { externalRequestID: 'x', kind: 'network', title: '接続', reason: '確認', resource: 'https://example.com' };
    event('e2', 'approval_requested', { approval }, '2026-10-12T00:00:03.000Z');
    expect(state()).toMatchObject({ exec_state: 'waiting', wait_reason: 'approval' });
    event('e3', 'paused', { pauseReason: 'needs_owner', currentAction: '再開してください' }, '2026-10-12T00:00:04.000Z');
    expect(state()).toMatchObject({ exec_state: 'waiting', wait_reason: 'owner' });
    store.enqueue('owner', created.task.id, { idempotencyKey: 'resume', type: 'resume' }, '2026-10-12T00:00:05.000Z');
    expect(state()).toMatchObject({ exec_state: 'active', wait_reason: null });
    store.enqueue('owner', created.task.id, { idempotencyKey: 'stop', type: 'interrupt' }, '2026-10-12T00:00:06.000Z');
    expect(state()).toMatchObject({ exec_state: 'stopped' });
    expect(zeroCounts(reader)).toMatchObject({ tasks: { mismatches: 0, nulls: 0 } });
    reader.close();
    store.close();
  });

  it('writes the task columns with every event of an FCA task, through a whole run', async () => {
    const h = actionHarness(() => T1);
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => T1,
      model: { async decide() { return { decision: { kind: 'complete', summary: 'Finished' }, history: ['known response'] }; }, toolResults: results => results },
    });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: 'Research', goal: 'Research' }, 'research');
    const stored = (id: string) => h.db.prepare('SELECT exec_state FROM agent_tasks WHERE task_id = ?').get(id)?.exec_state;
    expect(stored(task.id)).toBe('ready');
    await driver.tick();
    await driver.drain();
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(stored(task.id)).toBe('completed');
    expect(zeroCounts(h.db)).toEqual(ZERO);
    for (const row of h.db.prepare('SELECT * FROM agent_tasks').all()) {
      const checkpoint = h.db.prepare('SELECT step_id AS c_step_id, stop_requested AS c_stop_requested, wait_reason AS c_wait_reason FROM fca_task_checkpoints WHERE task_id = ?')
        .get(String(row.task_id)) ?? {};
      expect([row.task_id, row.exec_state]).toEqual([row.task_id, deriveTask(taskFactsOf({ ...row, ...checkpoint }))?.execState]);
    }
    await driver.close();
    h.close();
  });
});

describe('the ops view and the start', () => {
  it('shows the projection counts and puts them in the daily line', async () => {
    const path = temporaryPath();
    buildGolden(path);
    const backfill = startExecutionBackfill({ databasePath: path, log: () => {} });
    await backfill.done;
    const database = openDatabase(path, 'liveness');
    const monitor = startExecutionMonitor({ database, scheduler: () => null, liveness: () => null, now: () => T1, intervalMs: null, log: () => {} });
    const view = monitor.view();
    expect([view.projectionMismatches, view.projectionNulls]).toEqual([0, 0]);
    expect(executionDailyLine(view, '2026-10-12')).toContain('projectionMismatches=0 projectionNulls=0');
    monitor.close();
    database.close();
  });

  it('counts the rows the backfill has not reached yet', () => {
    const path = temporaryPath();
    buildGolden(path);
    const database = openDatabase(path, 'liveness');
    const monitor = startExecutionMonitor({ database, scheduler: () => null, liveness: () => null, now: () => T1, intervalMs: null, log: () => {} });
    expect(monitor.view().projectionNulls).toBe(CODEX_TASKS.length + FCA_TASKS.length + ACTIONS.length);
    monitor.close();
    database.close();
  });
});
