import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTION_LIMITS, UNKNOWN_EXIT_MODEL_ONLY_MS, UNKNOWN_EXIT_MS, classifyLease, leaseOutcome, type ActionLease } from '@shannon/mind';
import type { FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import { UNKNOWN_CLOSED_SUMMARY } from '../src/mind/action/agentTasks/store/agentTaskUnknownExit.js';
import { agentTaskSettled } from '../src/mind/action/agentTasks/store/agentTaskSettlement.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { countTaskProjection } from '../src/mind/action/agentTasks/store/taskExecutionColumns.js';
import { resetTaskTransitionRefusals, taskTransitionRefusals } from '../src/mind/action/agentTasks/store/taskStore.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { openDatabase } from '../src/infra/sqlite/sqliteOpen.js';
import { backfillExecutionColumns } from '../src/wiring/executionBackfillWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

/** Syzygy ADR-0009 stage 1: S4 (the state machine writes), S5 (one unknown exit), S6 (slot classes from the slot tables). */
const directories: string[] = [];
const cleanups: Array<() => void> = [];
beforeEach(() => resetTaskTransitionRefusals());
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-s4-'));
  directories.push(directory);
  return join(directory, 'shannon.sqlite');
}

function clock(start = '2026-10-13T00:00:00.000Z') {
  let time = Date.parse(start);
  return { now: () => new Date(time).toISOString(), advance: (milliseconds: number) => { time += milliseconds; } };
}

function fcaRuntime(now: () => string) {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => true, now });
  return { db, authority, runtime };
}

const row = (db: DatabaseSync, id: string) => db.prepare('SELECT status, pause_reason, exec_state, exec_starting, unknown_since FROM agent_tasks WHERE task_id = ?').get(id);

describe('the state machine writes every task state (S4)', () => {
  it('writes the state with its old columns, and refuses an illegal move without writing anything', () => {
    const c = clock();
    const { db, authority, runtime } = fcaRuntime(c.now);
    const root = runtime.ensureRoot('owner');
    expect(row(db, root.id)).toMatchObject({ status: 'running', exec_state: 'waiting' });
    expect(db.prepare('SELECT wait_reason FROM agent_tasks WHERE task_id = ?').get(root.id)?.wait_reason).toBe('message');
    const done = runtime.createChild('owner', root.id, { title: 'done', goal: 'done' }, 'r1');
    authority.event('owner', done.id, 'test_failed', c.now(), { status: 'failed' });
    expect(row(db, done.id)).toMatchObject({ status: 'failed', exec_state: 'failed' });
    const revision = authority.get('owner', done.id)!.revision;
    expect(() => authority.transaction(() => authority.event('owner', done.id, 'test_requeued', c.now(), { status: 'queued' }))).toThrow('TASK_TRANSITION_REFUSED');
    expect(row(db, done.id)).toMatchObject({ status: 'failed', exec_state: 'failed' });
    expect(authority.get('owner', done.id)!.revision).toBe(revision);

    const lost = runtime.createChild('owner', root.id, { title: 'lost', goal: 'lost' }, 'r2');
    authority.event('owner', lost.id, 'fca_recovery_unknown', c.now(), { status: 'paused', pauseReason: 'fca_unknown' });
    expect(row(db, lost.id)).toMatchObject({ exec_state: 'unknown', unknown_since: c.now() });
    db.prepare("UPDATE fca_task_checkpoints SET step_id = 'step-again' WHERE task_id = ?").run(lost.id);
    expect(() => authority.event('owner', lost.id, 'test_restart', c.now(), { status: 'running', pauseReason: null })).toThrow('TASK_TRANSITION_REFUSED');
    expect(taskTransitionRefusals().byReason).toEqual({ 'illegal:work:failed>ready': 1, 'illegal:work:unknown>active': 1 });
  });

  it('lets a task marked unknown run again once its lease proves nothing was sent', () => {
    const c = clock();
    const db = new DatabaseSync(':memory:');
    cleanups.push(() => db.close());
    migrateAgentTasks(db);
    const actions = new SQLiteActionStore(db);
    const authority = new SQLiteFcaTaskAuthority(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => true, now: c.now });
    const reader = new ActionLeaseReader(db);
    const classify = (lease: ActionLease) => leaseOutcome(classifyLease(reader.inScope(lease.id, 'owner'), lease, c.now()));
    const task = runtime.createChild('owner', runtime.ensureRoot('owner').id, { title: 'r', goal: 'r' }, 'r');
    const queued = actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: `fca:${task.id}:${task.revision}` }, c.now());
    const lease = leaseOf(actions.claim(queued.id, 'runner', c.now())!);
    expect(runtime.beginStep('owner', task.id, lease, task.revision)).not.toBeNull();
    // The API reads the expired lease before the scheduler swept it: not yet provably unsent, so unknown.
    c.advance(ACTION_LIMITS.leaseMs + 1);
    runtime.recover('owner', classify);
    expect(runtime.get('owner', task.id)?.phase).toBe('unknown');
    actions.transaction(() => actions.sweep(c.now()));
    expect(runtime.recover('owner', classify).map(view => view.phase)).toEqual(['ready']);
    expect(row(db, task.id)).toMatchObject({ status: 'queued', exec_state: 'ready', unknown_since: null });
    expect(taskTransitionRefusals().byReason).toEqual({});
  });

  it('records the Host starting flag and finds a status another writer changed under it (L3)', () => {
    const path = temporaryPath();
    const store = new SQLiteAgentTaskStore(path);
    cleanups.push(() => store.close());
    const reader = openDatabase(path, 'readOnly');
    cleanups.push(() => reader.close());
    const { task } = store.create('owner', { idempotencyKey: 'start', conversationThreadID: 'thread', title: '調査', goal: '原因', summary: '調べる。' },
      '2026-10-13T00:00:00.000Z');
    store.claim('mac', '2026-10-13T00:00:01.000Z');
    expect(row(reader, task.id)).toMatchObject({ status: 'starting', exec_state: 'active', exec_starting: 1 });
    expect(countTaskProjection(reader)).toEqual({ mismatches: 0, nulls: 0, stateMismatches: 0 });
    const writer = openDatabase(path, 'agentTasks');
    cleanups.push(() => writer.close());
    writer.prepare("UPDATE agent_tasks SET status = 'running' WHERE task_id = ?").run(task.id);
    expect(countTaskProjection(reader).mismatches).toBe(1);
  });

  it('counts a stored state its checkpoint no longer says (L2)', () => {
    const c = clock();
    const { db, runtime } = fcaRuntime(c.now);
    const root = runtime.ensureRoot('owner');
    expect(countTaskProjection(db).stateMismatches).toBe(0);
    db.prepare("UPDATE fca_task_checkpoints SET step_id = 'outside' WHERE task_id = ?").run(root.id);
    expect(countTaskProjection(db)).toEqual({ mismatches: 0, nulls: 0, stateMismatches: 1 });
  });

  it('re-derives at the start what an older build wrote after the machine, also with a clock behind it', async () => {
    const path = temporaryPath();
    const store = new SQLiteAgentTaskStore(path);
    cleanups.push(() => store.close());
    const first = store.create('owner', { idempotencyKey: 'a', conversationThreadID: 't', title: 'a', goal: 'a', summary: 'a' }, '2026-10-13T00:00:00.000Z');
    const second = store.create('owner', { idempotencyKey: 'b', conversationThreadID: 't', title: 'b', goal: 'b', summary: 'b' }, '2026-10-13T00:00:00.000Z');
    const db = openDatabase(path, 'taskRuntime');
    cleanups.push(() => db.close());
    // An older build moves the first task later than the machine wrote it, the second with a Host clock behind.
    db.prepare("UPDATE agent_tasks SET status = 'running', updated_at = '2026-10-13T00:05:00.000Z' WHERE task_id = ?").run(first.task.id);
    db.prepare("UPDATE agent_tasks SET status = 'completed', updated_at = '2026-10-12T23:00:00.000Z' WHERE task_id = ?").run(second.task.id);
    expect(countTaskProjection(db).mismatches).toBe(2);
    expect(await backfillExecutionColumns(db)).toMatchObject({ tasks: 2 });
    expect(row(db, first.task.id)).toMatchObject({ exec_state: 'active', exec_starting: 0 });
    expect(row(db, second.task.id)).toMatchObject({ exec_state: 'completed' });
    expect(countTaskProjection(db)).toEqual({ mismatches: 0, nulls: 0, stateMismatches: 0 });
    expect(await backfillExecutionColumns(db)).toMatchObject({ tasks: 0 });
  });
});

describe('one unknown exit (S5)', () => {
  it('retires the step of a model-only task and closes an Agent Host task, keeping its Host lock until a proof', () => {
    const c = clock();
    const path = temporaryPath();
    const tasks = new SQLiteAgentTaskStore(path);
    cleanups.push(() => tasks.close());
    const { task } = tasks.create('owner', { idempotencyKey: 'codex', conversationThreadID: 't', title: '修正', goal: '直す', summary: '直す。' }, c.now());
    tasks.claim('mac', c.now());
    tasks.recordHostEvents('mac', [{ eventId: 'e1', taskId: task.id, type: 'started', title: 'started', occurredAt: c.now(), payload: {} }], c.now());
    tasks.enqueue('owner', task.id, { idempotencyKey: 'steer', type: 'steer', payload: { instruction: 'もう少し' } }, c.now());
    const db = openDatabase(path, 'mindWorker');
    cleanups.push(() => db.close());
    const authority = new SQLiteFcaTaskAuthority(db);
    const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => true, now: c.now });
    const research = runtime.createChild('owner', runtime.ensureRoot('owner').id, { title: 'r', goal: 'r' }, 'r');
    const hostLock = actionResource('mac', 'agent-host');
    const actions = new SQLiteActionStore(db, () => false, key => key === hostLock, view => agentTaskSettled(db, view.sourceId));
    const strand = (sourceId: string, resources: string[]) => {
      const queued = actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId, resources }, c.now());
      const lease = leaseOf(actions.claim(queued.id, 'runner', c.now())!);
      expect(actions.dispatch(lease, c.now())).toBe(true);
      return lease;
    };
    const codexLease = strand(task.id, [hostLock]);
    const stepLease = strand(`fca:${research.id}:1`, []);
    c.advance(ACTION_LIMITS.leaseMs + 1);
    actions.transaction(() => actions.sweep(c.now()));
    // The model-only step leaves at its shorter exit (2026-10-13), the Agent Host task at the full one.
    c.advance(UNKNOWN_EXIT_MODEL_ONLY_MS - 1);
    expect(actions.transaction(() => actions.sweep(c.now()))).toBe(0);
    c.advance(1);
    expect(actions.transaction(() => actions.sweep(c.now()))).toBe(1);
    expect(actions.get(stepLease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'unknown_retired' });
    c.advance(UNKNOWN_EXIT_MS - UNKNOWN_EXIT_MODEL_ONLY_MS - 1);
    expect(actions.transaction(() => actions.sweep(c.now()))).toBe(0);
    c.advance(1);
    expect(actions.transaction(() => actions.sweep(c.now()))).toBe(1);
    expect(actions.get(codexLease.id)).toMatchObject({ state: 'unknown', sent: false, result: 'outcome_unknown_closed', resources: [hostLock] });

    const closedUnknown = (database: DatabaseSync) => new ActionLeaseReader(database).closedUnknownHostTasks();
    expect(tasks.closeUnknownOutcomes(c.now(), closedUnknown)).toBe(1);
    expect(tasks.closeUnknownOutcomes(c.now(), closedUnknown)).toBe(0);
    expect(tasks.get('owner', task.id)).toMatchObject({ status: 'failed', summary: UNKNOWN_CLOSED_SUMMARY });
    expect(row(db, task.id)).toMatchObject({ exec_state: 'failed', unknown_since: actions.get(codexLease.id)!.updatedAt });
    expect(db.prepare("SELECT status, last_error FROM agent_task_commands WHERE task_id = ? AND command_type = 'steer'").get(task.id))
      .toEqual({ status: 'completed', last_error: 'WITHDRAWN' });
    // The closure is not the Host's proof: the lock stays retained, and nothing is sent again.
    expect(agentTaskSettled(db, task.id)).toBe(false);
    actions.transaction(() => actions.sweep(c.now()));
    const other = actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'next-task', resources: [hostLock] }, c.now());
    expect(actions.claim(other.id, 'runner', c.now())).toBeNull();
    expect(actions.claimRefusals()).toMatchObject({ resource_held: 1 });

    // A late Host report is not lost: its evidence is kept and the truth wins (coordinator decision of 2026-10-13).
    const host = (type: 'completed' | 'paused' | 'failed', payload: Record<string, unknown>, id: string) =>
      tasks.recordHostEvents('mac', [{ eventId: id, taskId: task.id, type, title: type, occurredAt: c.now(), payload }], c.now());
    host('failed', { tests: [{ name: 'late', status: 'failed' }] }, 'late-failed');
    expect(tasks.get('owner', task.id)).toMatchObject({ status: 'failed', tests: [{ name: 'late', status: 'failed' }] });
    host('paused', { currentAction: '確認してください' }, 'late-paused');
    expect(tasks.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'needs_owner' });
    expect(row(db, task.id)).toMatchObject({ exec_state: 'waiting', unknown_since: null });
    expect(tasks.closeUnknownOutcomes(c.now(), closedUnknown)).toBe(0);
    expect(tasks.get('owner', task.id)?.timeline.map(item => item.title)).toEqual(expect.arrayContaining(['failed', 'paused']));
    expect(taskTransitionRefusals().byReason).toEqual({});
  });

  it('completes a task closed with an unknown outcome when the Host reports its completion late', () => {
    const c = clock();
    const tasks = new SQLiteAgentTaskStore(temporaryPath());
    cleanups.push(() => tasks.close());
    const { task } = tasks.create('owner', { idempotencyKey: 'codex', conversationThreadID: 't', title: '修正', goal: '直す', summary: '直す。' }, c.now());
    tasks.claim('mac', c.now());
    const closedUnknown = () => [{ taskId: task.id, closedAt: c.now() }];
    expect(tasks.closeUnknownOutcomes(c.now(), closedUnknown)).toBe(1);
    expect(tasks.get('owner', task.id)).toMatchObject({ status: 'failed', summary: UNKNOWN_CLOSED_SUMMARY });
    tasks.recordHostEvents('mac', [{ eventId: 'late', taskId: task.id, type: 'completed', title: 'done', detail: '直した。', occurredAt: c.now(),
      payload: { changes: [{ path: 'a.ts', summary: 'fix' }], tests: [] } }], c.now());
    expect(tasks.get('owner', task.id)).toMatchObject({ status: 'completed', summary: '直した。', changes: [{ path: 'a.ts', summary: 'fix' }] });
  });

  it('keeps a batch of Host events when the state machine refuses one row, and counts the refusal', () => {
    const c = clock();
    const path = temporaryPath();
    const tasks = new SQLiteAgentTaskStore(path);
    cleanups.push(() => tasks.close());
    const make = (key: string) => tasks.create('owner', { idempotencyKey: key, conversationThreadID: 't', title: key, goal: key, summary: key }, c.now()).task;
    const [first, second] = [make('a'), make('b')];
    const db = openDatabase(path, 'agentTasks');
    cleanups.push(() => db.close());
    for (const task of [first, second]) db.prepare("UPDATE agent_tasks SET assigned_host_id = 'mac' WHERE task_id = ?").run(task.id);
    // A row whose stored state says it finished, written by the machine (a state no Host event may leave).
    db.prepare("UPDATE agent_tasks SET exec_state = 'completed', exec_state_at = '2099-01-01T00:00:00.000Z' WHERE task_id = ?").run(first.id);
    const event = (id: string, taskId: string) => ({ eventId: id, taskId, type: 'started' as const, title: 'started', occurredAt: c.now(), payload: {} });
    tasks.recordHostEvents('mac', [event('e1', first.id), event('e2', second.id)], c.now());
    expect(tasks.get('owner', first.id)?.status).toBe('queued');
    expect(tasks.get('owner', first.id)?.timeline.map(item => item.title)).toContain('started');
    expect(tasks.get('owner', second.id)?.status).toBe('running');
    expect(taskTransitionRefusals().byReason).toEqual({ 'illegal:codex:completed>active': 1 });
  });
});

describe('slot classes from the slot tables (S6)', () => {
  it('admits by the owner limits and refuses by closed reason, reading the limits as data', () => {
    const c = clock();
    const h = actionHarness(c.now);
    cleanups.push(() => h.close());
    const claim = (kind: 'ownTime' | 'minecraft' | 'agentTask' | 'respond', sourceId: string) => {
      const origin = kind === 'ownTime' ? 'own_time' : 'owner_request';
      const queued = h.store.enqueue({ scopeKey: 'owner', kind, origin, sourceId }, c.now());
      return h.store.claim(queued.id, 'runner', c.now());
    };
    expect(claim('ownTime', 'cycle-1')).not.toBeNull();
    expect(claim('ownTime', 'cycle-2')).toBeNull();
    expect(claim('minecraft', 'play-1')).not.toBeNull();
    expect(claim('agentTask', 'ops-1')).not.toBeNull();
    expect(claim('agentTask', `touch:${'a'.repeat(64)}`)).not.toBeNull();
    expect(claim('agentTask', `touch:${'b'.repeat(64)}`)).toBeNull();
    expect(claim('respond', 'turn-1')).not.toBeNull();
    expect(claim('respond', 'turn-2')).toBeNull();
    h.db.prepare("UPDATE mind_action_slot_pools SET max_live = 4 WHERE pool = 'background'").run();
    h.db.prepare("UPDATE mind_action_slot_classes SET max_live = 2 WHERE slot_class = 'creative'").run();
    expect(claim('ownTime', 'cycle-2')).not.toBeNull();
    expect(h.store.claimRefusals()).toEqual({ class_creative: 1, pool_touch: 1, pool_foreground: 1 });
  });

  it('starts FCA tasks only while their class has room (no fixed cap of two)', async () => {
    const at = '2026-10-13T00:00:00.000Z';
    const h = actionHarness(() => at);
    cleanups.push(() => h.close());
    const started: string[] = [];
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
      model: { decide(input, signal) {
        started.push(input.task.title);
        return new Promise<FcaModelOutput>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('model_abort')), { once: true }));
      }, toolResults: results => results } });
    cleanups.push(() => { void driver.close(); });
    const root = driver.runtime.ensureRoot('owner');
    for (const title of ['one', 'two', 'three']) driver.runtime.createChild('owner', root.id, { title, goal: title }, title);
    h.db.prepare("UPDATE mind_action_slot_classes SET max_live = 1 WHERE slot_class = 'research'").run();
    await driver.tick();
    for (let i = 0; i < 50 && started.length < 1; i += 1) await new Promise(resolve => setImmediate(resolve));
    await driver.tick();
    expect(started).toHaveLength(1);
    h.db.prepare("UPDATE mind_action_slot_classes SET max_live = 3 WHERE slot_class = 'research'").run();
    await driver.tick();
    for (let i = 0; i < 50 && started.length < 3; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect([...started].sort()).toEqual(['one', 'three', 'two']);
    expect(h.store.claimRefusals()).toEqual({});
    await driver.close();
  });
});
