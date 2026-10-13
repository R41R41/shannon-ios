import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionLease } from '@shannon/mind';
import type { ActionThreads } from '../src/contracts/actionThreadContract.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { TaskOwnTimeStore } from '../src/mind/action/taskRuntime/store/taskOwnTimeStore.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { SQLiteActionStore } from '../src/mind/action/threads/store/actionStore.js';
import { MINECRAFT_TASK_CAP, OWNER_TASK_CAP, OWN_TIME_STEP_ESTIMATE_YEN, fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const now = () => '2026-10-13T01:00:00.000Z';

function world() {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority, leaseValid: () => true, now });
  const own = new TaskOwnTimeStore(db, { authority, now, ensureRoot: scope => runtime.ensureRoot(scope), get: (scope, id) => runtime.get(scope, id) });
  const actions = new SQLiteActionStore(db);
  return { db, runtime, own, actions };
}

describe('own-time FCA tasks (ADR-0009 stage 2, E4)', () => {
  it('admits one under the root, of origin own_time, with its capability, idempotently, at most two open', () => {
    const { db, own, runtime } = world();
    const task = own.create('owner', { title: '調べる: 雨', goal: '雨の音', kind: 'research', capability: 'research.read' }, 'd1');
    expect(task).toMatchObject({ origin: 'own_time', kind: 'research', status: 'queued', parentId: runtime.ensureRoot('owner').id });
    expect(own.create('owner', { title: '調べる: 雨', goal: '雨の音', kind: 'research', capability: 'research.read' }, 'd1').id).toBe(task.id);
    expect(db.prepare('SELECT capability, fca_origin FROM agent_tasks WHERE task_id = ?').get(task.id)).toMatchObject({ capability: 'research.read', fca_origin: 'own_time' });
    expect(runtime.taskSources('owner', task.id)).toEqual([]);
    own.create('owner', { title: 'b', goal: 'b', kind: 'research', capability: 'research.read' }, 'd2');
    expect(() => own.create('owner', { title: 'c', goal: 'c', kind: 'research', capability: 'research.read' }, 'd3')).toThrow('FCA_OWN_TIME_LIMIT');
    expect(runtime.readyTasks('owner').map(item => item.id)).toContain(task.id);
  });

  it('sends nothing to the root when it ends: the Executive reads its end', () => {
    const { db, own, runtime, actions } = world();
    const root = runtime.ensureRoot('owner');
    const task = own.create('owner', { title: '調べる', goal: 'g', kind: 'research', capability: 'research.read' }, 'd1');
    const queued = actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'own_time', sourceId: `fca:${task.id}:${task.revision}` }, now());
    const lease = leaseOf(actions.claim(queued.id, 'runner', now())!);
    const step = runtime.beginStep('owner', task.id, lease, task.revision)!;
    runtime.commitStep(step, { disposition: 'complete', summary: 'わかったこと', history: [] });
    expect(runtime.get('owner', task.id)?.status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM fca_task_messages WHERE target_task_id = ?').get(root.id)).toMatchObject({ n: 0 });
  });
});

describe('one budget for FCA steps (E3)', () => {
  const lease: ActionLease = { id: 'action-1', generation: 1, holder: 'runner' };
  const fakeActions = (reserve: boolean) => {
    const calls: string[] = [];
    return { calls, actions: {
      reserve: async (_lease: ActionLease, id: string, _day: string, yen: number) => { calls.push(`reserve:${id}:${yen}`); return reserve; },
      settle: async (_lease: ActionLease, id: string, actual: number | null) => { calls.push(`settle:${id}:${actual}`); return true; },
    } as unknown as ActionThreads };
  };
  const task = (origin: 'own_time' | 'owner_request', kind: 'research' | 'root' = 'research') =>
    ({ id: `t-${origin}-${kind}`, scopeKey: 'owner', origin, kind, title: '雨の調べもの' }) as never;

  it('stops an owner request at 300 yen or 40 steps, with a report, and never touches her budget', async () => {
    const { db } = world();
    const store = new TaskBudgetStore(db);
    const { actions, calls } = fakeActions(true);
    const budget = fcaBudget({ actions, store, now });
    for (let step = 0; step < OWNER_TASK_CAP.steps; step += 1) store.add('t-owner_request-research', 'owner', 'owner_request', 1, now());
    expect(await budget.before(task('owner_request'), lease)).toMatchObject({ ok: false, code: 'task_cap', report: expect.stringContaining('300円・40歩') });
    expect(store.spent('t-owner_request-research').cappedAt).toBe(now());
    store.add('t-yen', 'owner', 'owner_request', OWNER_TASK_CAP.yen, now());
    expect(await budget.before({ ...(task('owner_request') as object), id: 't-yen' } as never, lease)).toMatchObject({ ok: false, code: 'task_cap' });
    expect(await budget.before(task('owner_request', 'root'), lease)).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  it('gives an owner request bound to the Minecraft body a 2000 yen cap, and leaves every other owner request at 300 yen', async () => {
    const { db } = world();
    const store = new TaskBudgetStore(db);
    const { actions, calls } = fakeActions(true);
    const bound = new Set(['t-mc']);
    const budget = fcaBudget({ actions, store, now, minecraftTask: id => bound.has(id) });
    const mc = { ...(task('owner_request') as object), id: 't-mc', kind: 'generic' } as never;
    const other = { ...(task('owner_request') as object), id: 't-other', kind: 'generic' } as never;
    for (let step = 0; step < OWNER_TASK_CAP.steps; step += 1) { store.add('t-mc', 'owner', 'owner_request', 10, now()); store.add('t-other', 'owner', 'owner_request', 10, now()); }
    expect(await budget.before(mc, lease)).toEqual({ ok: true });
    expect(await budget.before(other, lease)).toMatchObject({ ok: false, code: 'task_cap', report: expect.stringContaining('300円・40歩') });
    store.add('t-mc', 'owner', 'owner_request', MINECRAFT_TASK_CAP.yen, now());
    expect(await budget.before(mc, lease)).toMatchObject({ ok: false, code: 'task_cap', report: expect.stringContaining('2000円・300歩') });
    expect(store.spent('t-mc').cappedAt).toBe(now());
    expect(calls).toEqual([]);
  });

  it('reserves an own-time step before it runs and settles its actual yen after; a refused reservation stops it', async () => {
    const { db } = world();
    const store = new TaskBudgetStore(db);
    const spends: number[] = [];
    const ownTime = {
      dayKey: () => '2026-10-13', budget: () => ({ capYen: 2000, spentYen: 100, exhausted: false }),
      recordSpend: (_scope: string, _at: string, spend: { yen: number }) => { spends.push(spend.yen); }, yen: (usd: number) => Math.ceil(usd * 160),
    };
    const refused = fakeActions(false);
    expect(await fcaBudget({ actions: refused.actions, store, now, ownTime }).before(task('own_time'), lease))
      .toMatchObject({ ok: false, code: 'own_time_budget' });
    const allowed = fakeActions(true);
    const budget = fcaBudget({ actions: allowed.actions, store, now, ownTime });
    const verdict = await budget.before(task('own_time'), lease);
    expect(verdict).toEqual({ ok: true, reservationId: 'fca:action-1:1' });
    await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => {} } as never, async () => { budget.recordUsage(0.05); budget.recordUsage(0.05); });
    await budget.after(task('own_time'), lease, 'fca:action-1:1');
    expect(allowed.calls).toEqual([`reserve:fca:action-1:1:${OWN_TIME_STEP_ESTIMATE_YEN}`, 'settle:fca:action-1:1:16']);
    expect(spends).toEqual([16]);
    expect(store.spent('t-own_time-research')).toMatchObject({ steps: 1, yen: 16 });
    // A step that called no model is not a paid step: nothing is counted, and its reservation is released with 0.
    await budget.before(task('own_time'), { ...lease, generation: 2 });
    await budget.after(task('own_time'), { ...lease, generation: 2 }, 'fca:action-1:2');
    expect(store.spent('t-own_time-research')).toMatchObject({ steps: 1, yen: 16 });
    expect(allowed.calls.at(-1)).toBe('settle:fca:action-1:2:0');
    // A record that fails still settles the reservation.
    const broken = fcaBudget({ actions: allowed.actions, store: { ...store, spent: () => ({ steps: 0, yen: 0, cappedAt: null }), add: () => { throw new Error('SQLITE_BUSY'); } } as never, now, ownTime });
    await broken.before(task('own_time'), { ...lease, generation: 3 });
    await inActionExecution({ lease: { ...lease, generation: 3 }, signal: new AbortController().signal, permit: async () => {} } as never, async () => { broken.recordUsage(0.01); });
    await expect(broken.after(task('own_time'), { ...lease, generation: 3 }, 'fca:action-1:3')).rejects.toThrow('SQLITE_BUSY');
    expect(allowed.calls.at(-1)).toBe('settle:fca:action-1:3:2');
    const exhausted = fcaBudget({ actions: allowed.actions, store, now, ownTime: { ...ownTime, budget: () => ({ capYen: 2000, spentYen: 2000, exhausted: true }) } });
    expect(await exhausted.before(task('own_time'), lease)).toMatchObject({ ok: false, code: 'own_time_budget' });
  });
});
