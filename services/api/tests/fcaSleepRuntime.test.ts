import { afterEach, describe, expect, it } from 'vitest';
import { validActionDraft } from '@shannon/mind';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { runFcaStep } from '../src/mind/action/fca/fcaRunner.js';
import type { FcaModel, FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import type { TaskSleepTicket, TaskSpec } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createSleepFcaStep } from '../src/mind/sleep/sleepFcaPhases.js';
import { createTaskRuntimeWiring, type TaskRuntimeWiringOptions } from '../src/wiring/taskRuntimeWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Promise.resolve(); }
  expect(condition()).toBe(true);
}
const complete = (): FcaModelOutput => ({ decision: { kind: 'complete', summary: 'Verified result' }, history: ['known decision'] });
const ticket = (id: string): TaskSleepTicket => ({ jobId: id, dayKey: '2026-10-08', startAt: '2026-10-07T15:00:00.000Z', endAt: '2026-10-08T15:00:00.000Z' });
function fixture(options: {
  sleep?: FcaModel['decide']; normal?: FcaModel['decide']; stepPorts?: TaskRuntimeWiringOptions['stepPorts'];
  omitModel?: boolean; omitPolicy?: boolean;
} = {}) {
  let time = '2026-10-09T00:00:00.000Z', alone = true, allowed = true;
  const h = actionHarness(() => time), tickets = new Map<string, TaskSleepTicket>([['night', ticket('night')]]);
  const normalInputs: FcaModelInput[] = [], sleepInputs: FcaModelInput[] = [];
  const normal: FcaModel = { async decide(input, signal) { normalInputs.push(input); return options.normal?.(input, signal) ?? complete(); }, toolResults: results => ({ results }) };
  const maintenance: FcaModel = { async decide(input, signal) { sleepInputs.push(input); return options.sleep?.(input, signal) ?? complete(); }, toolResults: results => ({ results }) };
  const create = () => createTaskRuntimeWiring({ db: h.db, actions: h.actions, model: normal, scopeKey: 'owner', now: () => time,
    ownerAlone: () => alone, sleepTicket: (scope, id) => scope === 'owner' ? tickets.get(id) ?? null : null,
    ...(options.omitPolicy ? {} : { maintenanceAllowed: () => allowed }),
    stepPorts: (runtime, step) => step.snapshot.task.origin === 'maintenance'
      ? { ...(options.omitModel ? {} : { model: maintenance }), ...options.stepPorts?.(runtime, step) }
      : {},
  });
  const drivers = [create()], driver = drivers[0]!;
  cleanups.push(async () => { for (const d of drivers) await d.close(); h.close(); });
  const root = driver.runtime.ensureRoot('owner');
  return { ...h, driver, root, tickets, normalInputs, sleepInputs,
    admit: (id = 'night') => driver.runtime.admitSleep('owner', id)!,
    child: (id: string) => driver.runtime.createChild('owner', root.id, { title: id, goal: id }, id),
    restart() { const d = create(); drivers.push(d); return d; },
    alone(value: boolean) { alone = value; }, allowed(value: boolean) { allowed = value; },
    expire() { time = '2026-10-09T00:01:00.000Z'; h.store.transaction(() => h.store.sweep(time)); },
  };
}

describe('scheduled sleep under the existing FCA authority', () => {
  it('admits only canonical same-scope schedules with immutable maintenance identity and atomic binding', () => {
    const f = fixture();
    expect(f.driver.runtime.admitSleep('other', 'night')).toBeNull();
    expect(f.driver.runtime.admitSleep('owner', 'invented')).toBeNull();
    expect(f.driver.runtime.list('other')).toEqual([]);
    const task = f.admit();
    expect(task).toMatchObject({ kind: 'sleep', origin: 'maintenance', phase: 'ready', parentId: f.root.id });
    expect(f.admit().id).toBe(task.id);
    expect(f.driver.runtime.sleepTicketForTask('owner', task.id)).toEqual(ticket('night'));
    expect(f.driver.runtime.sleepTicketForTask('other', task.id)).toBeNull();
    expect(f.db.prepare('SELECT * FROM fca_task_maintenance').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
    f.tickets.set('night', { ...ticket('night'), dayKey: '2026-10-07' });
    expect(() => f.admit()).toThrow('FCA_SLEEP_TICKET_CONFLICT');
    expect(f.driver.runtime.sleepTicketForTask('owner', task.id)).toEqual(ticket('night'));
    f.tickets.set('rollback', ticket('rollback'));
    f.db.exec('BEGIN IMMEDIATE');
    const rolledBack = f.admit('rollback');
    f.db.exec('ROLLBACK');
    expect(f.driver.runtime.get('owner', rolledBack.id)).toBeNull();
    expect(f.db.prepare('SELECT * FROM fca_task_maintenance').all()).toHaveLength(1);
  });

  it('prevents generic creation, source ingress, and action-origin escalation', async () => {
    const f = fixture(), task = f.admit();
    for (const spec of [{ title: 'forged', goal: 'forged', kind: 'sleep' }, { title: 'forged', goal: 'forged', origin: 'maintenance' }]) {
      expect(() => f.driver.runtime.createChild('owner', f.root.id, spec as TaskSpec, 'forged')).toThrow();
    }
    expect(() => f.driver.runtime.createChild('owner', task.id, { title: 'child', goal: 'child' }, 'child')).toThrow('FCA_PARENT_ORIGIN');
    expect(() => f.driver.runtime.send('owner', f.root.id, task.id, 'new instructions', 'message')).toThrow('FCA_MAINTENANCE_INPUT');
    expect(() => f.driver.runtime.observeExternal('owner', task.id,
      { eventId: 'touch', experienceIds: ['canonical-touch'], observedAt: '2026-10-09T00:00:00.000Z', text: 'touch' })).toThrow('FCA_MAINTENANCE_INPUT');
    for (const kind of ['respond', 'ownTime', 'minecraft'] as const) expect(validActionDraft({ scopeKey: 'owner', sourceId: 'fake', origin: 'maintenance', kind })).toBe(false);
    const ownerTask = f.child('owner-task');
    const action = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', sourceId: `fca:${ownerTask.id}:${ownerTask.revision}`,
      kind: 'agentTask', origin: 'maintenance', resources: [actionResource('owner', `fca:${ownerTask.id}`)] })).id);
    expect(f.driver.runtime.beginStep('owner', ownerTask.id, leaseOf(action!), ownerTask.revision)).toBeNull();
    expect(f.driver.runtime.get('owner', ownerTask.id)?.phase).toBe('ready');
  });

  it('runs internal maintenance with others present while retaining the real owner gate and passive report', async () => {
    const f = fixture({ stepPorts: (runtime, step) => {
      expect(runtime.observeSources(step, { observationId: 'sleep-sources', recalledMemoryIds: ['original-experience'], readSourceIds: ['sleep-private:internal'] })).toBe(true);
      return {};
    } }), task = f.admit(), normal = f.child('held-owner-task');
    f.alone(false);
    await f.driver.tick(); await f.driver.drain();
    expect(f.sleepInputs).toHaveLength(1);
    expect(f.sleepInputs[0]?.tools).toEqual([]);
    expect(f.normalInputs).toEqual([]);
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(f.driver.runtime.get('owner', normal.id)?.phase).toBe('ready');
    expect(f.driver.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
    const report = f.driver.runtime.snapshot('owner', f.root.id)!.messages[0]!;
    expect(report.sourceTaskId).toBe(task.id);
    expect(JSON.parse(report.text)).toEqual({ kind: 'sleep', jobId: 'night', dayKey: '2026-10-08', status: 'completed' });
    expect(f.driver.runtime.taskSources('owner', f.root.id)).toEqual([]);
    expect(f.driver.runtime.taskSources('owner', task.id)).toMatchObject([{ recalledMemoryIds: ['original-experience'], readSourceIds: ['sleep-private:internal'] }]);
    expect(f.store.list('owner')).toMatchObject([{ kind: 'agentTask', origin: 'maintenance', state: 'completed' }]);
    f.alone(true); await f.driver.tick(); await f.driver.drain();
    expect(f.normalInputs.map(input => input.task.id)).toEqual([normal.id]);
  });

  it.each(['policy', 'model'] as const)('does not fall back to owner inference when maintenance %s is absent', async missing => {
    const f = fixture({ omitPolicy: missing === 'policy', omitModel: missing === 'model' }), task = f.admit();
    await f.driver.tick(); await f.driver.drain();
    expect(f.normalInputs).toEqual([]); expect(f.sleepInputs).toEqual([]);
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('ready');
    expect(f.store.list('owner').every(action => !action.sent && action.state === 'cancelled')).toBe(true);
  });

  it('cannot apply an internal execution override to an ordinary owner task', async () => {
    const f = fixture(), task = f.child('owner-policy'); let permits = 0, calls = 0;
    const action = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${task.id}:${task.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    const step = f.driver.runtime.beginStep('owner', task.id, leaseOf(action!), task.revision)!;
    await expect(runFcaStep(step, { runtime: f.driver.runtime, ownerAlone: () => false, executionAllowed: () => true,
      permit: async () => { permits++; return true; }, model: { async decide() { calls++; return complete(); }, toolResults: value => value } },
    new AbortController().signal)).rejects.toThrow('FCA_EXECUTION_HELD');
    expect(calls).toBe(0); expect(permits).toBe(0); expect(f.store.get(action!.id)?.sent).toBe(false);
  });

  it('refuses a changed ticket and revoked permission before dispatch, then runs after restoration', async () => {
    const f = fixture(), task = f.admit();
    f.tickets.set('night', { ...ticket('night'), startAt: '2026-10-07T16:00:00.000Z' });
    await f.driver.tick(); await f.driver.drain();
    expect(f.store.list('owner')).toEqual([]);
    f.tickets.set('night', ticket('night')); f.allowed(false);
    await f.driver.tick(); await f.driver.drain(); expect(f.sleepInputs).toEqual([]);
    f.allowed(true); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
  });

  it('uses the same two background slots while conversation admission remains available', async () => {
    const calls = new Map<string, ReturnType<typeof deferred<FcaModelOutput>>>();
    const decide: FcaModel['decide'] = (input, signal) => {
      const call = deferred<FcaModelOutput>(); calls.set(input.task.id, call);
      signal.addEventListener('abort', () => call.reject(new Error('cancelled')), { once: true }); return call.promise;
    };
    const f = fixture({ sleep: decide, normal: decide }), sleep = f.admit(), normal = f.child('normal');
    await f.driver.tick(); await until(() => calls.size === 2);
    const third = f.child('third'); await f.driver.tick();
    expect(calls.has(third.id)).toBe(false);
    expect(f.store.list('owner').filter(action => action.state === 'running')).toHaveLength(2);
    const respond = await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'conversation' });
    expect(respond?.state).toBe('running');
    calls.get(sleep.id)!.resolve(complete()); calls.get(normal.id)!.resolve({ decision: { kind: 'wait', summary: 'Waiting' }, history: ['known response'] }); await f.driver.drain();
    await f.driver.tick(); await until(() => calls.has(third.id)); calls.get(third.id)!.resolve(complete()); await f.driver.drain();
    expect(f.driver.runtime.get('owner', third.id)?.phase).toBe('completed');
  });

  it('persists only successful code-owned sleep phase checkpoints under each segment lease', async () => {
    const calls: string[] = [], applies: string[] = [];
    const f = fixture({ stepPorts: (_runtime, step) => createSleepFcaStep({ job: { id: 'night', scopeKey: 'owner', ...ticket('night') },
      checkpoint: (step.snapshot.checkpoint as { sleepFca?: unknown } | null)?.sleepFca, assertCurrent: () => true,
      handlers: { memory: {
        async decide() { calls.push(step.id); return { modelText: 'not a checkpoint', phase: 'export' }; },
        async apply(_answer, input) { applies.push(input.operationId); return { done: true, summary: 'Memory receipt accepted' }; },
      } } }) });
    const task = f.admit();
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('ready');
    expect(f.driver.runtime.snapshot('owner', task.id)?.checkpoint).toEqual({ sleepFca: { schemaVersion: 1, jobId: 'night', phase: 'done', state: null }, consecutiveToolFailures: 0 });
    expect(f.driver.runtime.snapshot('owner', task.id)?.history).toHaveLength(2);
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(calls).toHaveLength(1); expect(applies).toHaveLength(1);
    expect(f.store.list('owner').every(action => action.state === 'completed' && action.origin === 'maintenance')).toBe(true);
  });

  it('completes beyond the shared history window using deterministic compaction and original phase checkpoints', async () => {
    const cursors: number[] = [], applied: string[] = [];
    const f = fixture({ stepPorts: (_runtime, step) => createSleepFcaStep({ job: { id: 'night', scopeKey: 'owner', ...ticket('night') },
      checkpoint: (step.snapshot.checkpoint as { sleepFca?: unknown } | null)?.sleepFca, assertCurrent: () => true,
      handlers: { memory: {
        async decide({ state }) { const cursor = (state as { cursor?: number } | null)?.cursor ?? 0; cursors.push(cursor); return cursor; },
        async apply(answer, input) { applied.push(input.operationId); return { done: Number(answer) === 63, state: { cursor: Number(answer) + 1 }, summary: 'Closed writer receipt' }; },
      } } }) });
    const task = f.admit();
    for (let index = 0; index < 65; index++) { await f.driver.tick(); await f.driver.drain(); }
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(cursors).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(new Set(applied).size).toBe(64);
    const window = f.driver.runtime.history('owner', task.id)!;
    expect(window.summary!.revision).toBeGreaterThanOrEqual(2);
    expect(window.summary!.template['重要な文脈']).toContainEqual(expect.stringMatching(/^rounds=\d+$/u));
    expect(window.rounds.length).toBeLessThanOrEqual(24);
    expect(f.driver.runtime.snapshot('owner', task.id)?.history).toHaveLength(129);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fca_task_history WHERE task_id=?').get(task.id)).toEqual({ n: 65 });
    expect(f.driver.runtime.snapshot('owner', task.id)?.checkpoint).toMatchObject({ sleepFca: { phase: 'done' } });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.normalInputs).toEqual([]);
    expect(f.store.list('owner').every(action => action.state === 'completed')).toBe(true);
  });

  it('resumes only the original live sleep ticket and keeps its committed phase while ordinary owner resume stays available', async () => {
    let paidCalls = 0;
    const f = fixture({ stepPorts: (_runtime, step) => createSleepFcaStep({ job: { id: 'night', scopeKey: 'owner', ...ticket('night') },
      checkpoint: (step.snapshot.checkpoint as { sleepFca?: unknown } | null)?.sleepFca, assertCurrent: () => true,
      handlers: { memory: { async decide() { paidCalls++; return null; }, async apply() { return { done: true, summary: 'Confirmed receipt' }; } } } }) });
    const task = f.admit(); await f.driver.tick(); await f.driver.drain();
    const checkpoint = f.driver.runtime.snapshot('owner', task.id)?.checkpoint;
    await f.driver.stop(task.id, 'owner stopped maintenance');
    const stopped = f.driver.runtime.get('owner', task.id);
    f.tickets.delete('night'); expect(f.driver.runtime.resume('owner', task.id)).toBeNull();
    for (const changed of [{ jobId: 'other-night' }, { dayKey: '2026-10-07' },
      { startAt: '2026-10-07T16:00:00.000Z' }, { endAt: '2026-10-08T16:00:00.000Z' }]) {
      f.tickets.set('night', { ...ticket('night'), ...changed });
      expect(f.driver.runtime.resume('owner', task.id)).toBeNull();
      expect(f.driver.runtime.get('owner', task.id)).toEqual(stopped);
    }
    const ordinary = f.child('resume-owner-task'); await f.driver.stop(ordinary.id, 'owner stopped ordinary task');
    expect(f.driver.runtime.resume('owner', ordinary.id)?.phase).toBe('ready');
    f.tickets.set('night', ticket('night'));
    expect(f.driver.runtime.resume('owner', task.id)?.phase).toBe('ready');
    expect(f.driver.runtime.snapshot('owner', task.id)?.checkpoint).toEqual(checkpoint);
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(f.driver.runtime.get('owner', ordinary.id)?.phase).toBe('completed');
    expect(paidCalls).toBe(1);
  });

  it('rejects fabricated ordinary task tools from a maintenance model', async () => {
    const f = fixture({ sleep: async () => ({ decision: { kind: 'tools', calls: [{ id: 'forge', name: 'task.create', input: { title: 'forged', goal: 'forged' } }] }, history: ['decision'] }) });
    const task = f.admit(); await f.driver.tick(); await f.driver.drain();
    expect(f.sleepInputs[0]?.tools).toEqual([]);
    expect(f.driver.runtime.get('owner', task.id)?.childIds).toEqual([]);
    expect(f.driver.runtime.snapshot('owner', task.id)?.history[1]).toMatchObject({ results: [{ id: 'forge', ok: false }] });
  });

  it('exposes only code-owned sleep metadata and does not copy internal lineage into ordinary task history', async () => {
    const f = fixture({ sleep: async () => ({ decision: { kind: 'complete', summary: 'PRIVATE MODEL TEXT' }, history: ['private native result'] }),
      stepPorts: (runtime, step) => {
        expect(runtime.observeSources(step, { observationId: 'internal', recalledMemoryIds: ['internal:night-source'] })).toBe(true);
        return {};
      } });
    const sleep = f.admit(); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', sleep.id)?.summary).toBe('睡眠整理の状態を確認しました。');
    const owner = f.child('read-closed-sleep');
    const action = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${owner.id}:${owner.revision}`, resources: [actionResource('owner', `fca:${owner.id}`)] })).id);
    const step = f.driver.runtime.beginStep('owner', owner.id, leaseOf(action!), owner.revision)!;
    expect(f.driver.runtime.inheritTaskSources(step, [sleep.id])).toBe(true);
    expect(f.driver.runtime.taskSources('owner', owner.id)).toEqual([]);
    expect(JSON.stringify(f.driver.runtime.list('owner'))).not.toContain('PRIVATE MODEL TEXT');
    f.db.prepare('UPDATE agent_tasks SET title=? WHERE task_id=?').run('noncanonical private title', sleep.id);
    expect(f.driver.runtime.inheritTaskSources(step, [sleep.id])).toBe(false);
  });

  it('replays a lost completion acknowledgement without repeating the completed sleep phase', async () => {
    const f = fixture(), task = f.admit(), originalFinish = f.actions.finish;
    let disconnected = true;
    f.actions.finish = async (...args) => { if (disconnected) throw new Error('disconnected'); return originalFinish(...args); };
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(f.driver.runtime.pendingReceipts('owner')).toHaveLength(1);
    await f.driver.close(); f.expire(); disconnected = false;
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(f.sleepInputs).toHaveLength(1);
    expect(restored.runtime.pendingReceipts('owner')).toEqual([]);
    expect(f.store.list('owner')).toMatchObject([{ state: 'completed', result: 'fca_segment_committed', origin: 'maintenance' }]);
    expect(restored.runtime.snapshot('owner', f.root.id)?.messages).toHaveLength(1);
    expect(restored.runtime.get('owner', f.root.id)?.phase).toBe('waiting');
  });

  it('recovers an expired unsent maintenance claim without fabricating an owner action', async () => {
    const f = fixture(), task = f.admit();
    const action = await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'maintenance',
      sourceId: `fca:${task.id}:${task.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    expect(action?.sent).toBe(false);
    f.expire(); await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(f.sleepInputs).toHaveLength(1); expect(f.normalInputs).toEqual([]);
    expect(f.store.list('owner').map(row => row.state).sort()).toEqual(['cancelled', 'completed']);
    expect(f.store.list('owner').every(row => row.origin === 'maintenance')).toBe(true);
  });

  it('holds stop until the cancelled sleep model actually unwinds', async () => {
    const release = deferred<void>(); let aborted = false;
    const f = fixture({ sleep: async (_input, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await release.promise; throw new Error('cancelled_after_unwind');
    } });
    cleanups.push(() => release.resolve()); const task = f.admit();
    await f.driver.tick(); await until(() => f.sleepInputs.length === 1);
    await f.driver.stop(task.id, 'owner stopped maintenance');
    expect(aborted).toBe(true); expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('stopping');
    expect(f.store.list('owner')[0]?.state).toBe('stopping');
    release.resolve(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(f.store.list('owner')[0]).toMatchObject({ state: 'cancelled', result: 'fca_stop_acknowledged' });
    expect(f.driver.runtime.snapshot('owner', task.id)?.history).toEqual([]);
  });

  it('preserves an expired sent sleep segment as unknown across restart without replaying its phase', async () => {
    const f = fixture({ sleep: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })) });
    const task = f.admit(); await f.driver.tick(); await until(() => f.sleepInputs.length === 1);
    f.expire(); await f.driver.close();
    const restored = f.restart(); await restored.tick(); await restored.drain();
    expect(restored.runtime.get('owner', task.id)?.phase).toBe('unknown');
    expect(restored.runtime.sleepTicketForTask('owner', task.id)).toEqual(ticket('night'));
    expect(restored.runtime.admitSleep('owner', 'night')?.id).toBe(task.id);
    expect(restored.runtime.resume('owner', task.id)).toBeNull();
    expect(f.sleepInputs).toHaveLength(1);
    expect(f.store.list('owner')).toMatchObject([{ state: 'unknown', sent: true, origin: 'maintenance' }]);
  });
});
