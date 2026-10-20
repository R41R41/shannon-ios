import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRuntime, TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { peekedVisible, scheduleGate } from '../src/wiring/fcaPeekGates.js';
import { createFcaTaskObservationMonitor } from '../src/wiring/fcaTaskObservationWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { run6RecallShape } from './support/run6RecallShape.js';

/**
 * Production run 14 (2026-10-17): the observation monitor (twice a second) and the scheduler (each second) asked for the whole check
 * of a growing provenance while a task ran. They now only learn of a verdict already made (`peek`) and walk nothing; the whole check
 * stays where a step shows or does something (`guard.sources`), and a forgotten source is still excluded there.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[]): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled });

function world() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = run6RecallShape({ turns: 400, recallingTurns: 10, tasks: 6, recalledPerTask: 10, taskRecallsOfTasks: 2, readsPerTask: 4, skills: 4 });
  cleanups.push(() => f.close());
  let clock = Date.parse(f.world.now());
  const base = clock - 3_600_000, recent = f.turns.at(-3)!, pool = f.turns.slice(10, 300);
  const rows: TaskSource[] = Array.from({ length: 60 }, (_, index) => memoryRow(`m:${index}`, new Date(base + index * 10_000).toISOString(),
    [...pool.slice(index, index + 20), ...index === 20 ? [recent] : []]));
  const task = { id: 'task-1', scopeKey: 'owner', kind: 'generic', origin: 'owner', phase: 'executing', childIds: [], title: '鉄', goal: '鉄のツルハシ',
    completionCriteria: '持ち物', summary: '', parentId: null } as unknown as TaskView;
  const runtime = { get: () => task, taskSources: () => rows } as unknown as TaskRuntime;
  const guard = createFcaSourceGuard({ runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner', ownerAlone: f.ownerAlone,
    readSourceVisible: f.readSourceVisible, clock: () => clock });
  const walks = () => { const value = guard.walks!(); return value.walked + (value.partial ?? 0); };
  return { f, task, rows, runtime, guard, walks, recent, advance: (ms: number) => { clock += ms; } };
}

describe('the scheduler gate (the wake tick)', () => {
  it('walks nothing in two minutes of ticks, whether or not a verdict is kept, and lets a task not yet judged go on to execute', () => {
    const w = world();
    const gate = scheduleGate({ ownerScope: 'owner', guard: () => w.guard, whole: (runtime, id) => w.guard('owner', id, undefined, 'task') });
    for (let second = 0; second < 120; second++) { expect(gate(w.runtime, 'task-1')).toBe(true); w.advance(1_000); }
    expect(w.walks()).toBe(0);
    // `execute`'s whole check judges it once; the gate then reuses the verdict, still walking nothing.
    expect(w.guard('owner', 'task-1', undefined, 'task')).toBe(true);
    const judged = w.walks(); expect(judged).toBe(1);
    for (let second = 0; second < 3; second++) { expect(gate(w.runtime, 'task-1')).toBe(true); w.advance(1_000); }
    expect(w.walks()).toBe(judged);
  });

  it('skips a task whose withheld verdict is kept, and leaves the verdict to the whole check after a forget', () => {
    const w = world();
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    const gate = scheduleGate({ ownerScope: 'owner', guard: () => w.guard, whole: (runtime, id) => w.guard('owner', id, undefined, 'task') });
    expect(w.guard('owner', 'task-1', undefined, 'task')).toBe(false);
    const judged = w.walks();
    expect(gate(w.runtime, 'task-1')).toBe(false);
    expect(w.walks()).toBe(judged);
  });

  it('keeps the whole gate for own-time and sleep tasks, and without a guard', () => {
    const w = world(), whole = vi.fn(() => true);
    const gate = scheduleGate({ ownerScope: 'owner', guard: () => undefined, whole });
    expect(gate(w.runtime, 'task-1')).toBe(true);
    expect(whole).toHaveBeenCalledTimes(1);
    const own = { ...w.runtime, get: () => ({ ...w.task, origin: 'own_time' }) } as unknown as TaskRuntime;
    expect(scheduleGate({ ownerScope: 'owner', guard: () => w.guard, whole })(own, 'task-1')).toBe(true);
    expect(whole).toHaveBeenCalledTimes(2);
  });
});

describe('the gates\' question (`withheld`)', () => {
  /** `withheld` and `peek` asked at the same instant: withheld exactly where peek is false. */
  const same = (w: ReturnType<typeof world>) => {
    const peeked = w.guard.peek!('owner', w.task, w.rows), withheld = w.guard.withheld!('owner', w.task, w.rows);
    expect(withheld).toBe(peeked === false);
    return { peeked, withheld };
  };

  it('is peek\'s false in every state a verdict can be in, and asks no receipt where none is withheld', () => {
    const w = world();
    // No verdict.
    expect(same(w)).toEqual({ peeked: undefined, withheld: false });
    // A visible verdict: no receipt is asked again for the gate.
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(true);
    const asks = vi.fn(w.f.readSourceVisible);
    const asking = createFcaSourceGuard({ runtime: w.runtime, state: w.f.world.store, conversations: w.f.world.store, ownerScope: 'owner',
      ownerAlone: w.f.ownerAlone, readSourceVisible: asks, clock: () => Date.parse(w.f.world.now()) });
    expect(asking.sources('owner', w.task, w.rows, undefined, 'step')).toBe(true);
    asks.mockClear();
    expect(asking.withheld!('owner', w.task, w.rows)).toBe(false);
    expect(asks).not.toHaveBeenCalled();
    expect(same(w)).toEqual({ peeked: true, withheld: false });
    // Past the verdict's window: nothing kept.
    w.advance(6_000);
    expect(same(w)).toEqual({ peeked: undefined, withheld: false });
    // A forget: the whole check withholds it, and that verdict is the gates' false.
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(false);
    expect(same(w)).toEqual({ peeked: false, withheld: true });
    // ...until its window ends (then the whole check, where tools run, judges it again).
    w.advance(6_000);
    expect(same(w)).toEqual({ peeked: undefined, withheld: false });
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(false);
    // The owner no longer alone: withheld at once, with or without a verdict.
    w.f.setAlone(false);
    expect(same(w)).toEqual({ peeked: false, withheld: true });
  });

  it('is what the scheduler and the monitor act on', () => {
    const w = world();
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(true);
    const peekOnly = { sources: w.guard.sources, peek: w.guard.peek } as typeof w.guard;
    expect(peekedVisible(w.guard, 'owner', w.task, w.rows, () => { throw new Error('no whole check'); })).toBe(true);
    expect(peekedVisible(peekOnly, 'owner', w.task, w.rows, () => { throw new Error('no whole check'); })).toBe(true);
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(false);
    expect(peekedVisible(w.guard, 'owner', w.task, w.rows, () => true)).toBe(false);
    expect(peekedVisible(peekOnly, 'owner', w.task, w.rows, () => true)).toBe(false);
  });
});

describe('the task runtime tick', () => {
  it('asks the scheduler gate for a ready task, and the whole gate only where the task is admitted', async () => {
    const h = actionHarness(() => '2026-10-17T00:00:00.000Z'); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const canRunTask = vi.fn(() => false), canScheduleTask = vi.fn(() => true);
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => '2026-10-17T00:00:00.000Z',
      canRunTask, canScheduleTask, model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '鉄', goal: '鉄のツルハシ', completionCriteria: '持ち物' }, 'tick');
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('ready');
    await driver.tick();
    expect(canScheduleTask).toHaveBeenCalledWith(expect.anything(), task.id);
    // Admission (`execute`) is where the whole gate is asked, and it refused here.
    await vi.waitFor(() => expect(canRunTask).toHaveBeenCalled());
    canRunTask.mockClear(); canScheduleTask.mockReturnValue(false);
    await driver.tick();
    expect(canRunTask).not.toHaveBeenCalled();
  });
});

describe('the observation monitor', () => {
  it('polls for a minute without walking, and a forget is still excluded by the whole check where tools run', async () => {
    vi.useFakeTimers();
    const w = world();
    const step = { scopeKey: 'owner', taskId: 'task-1', messageIds: [] } as never;
    const monitor = createFcaTaskObservationMonitor({ runtime: w.runtime, step, allowed: () => true, intervalMilliseconds: 250,
      sourcesVisible: () => peekedVisible(w.guard, 'owner', w.task, w.rows, () => w.guard.sources('owner', w.task, w.rows)),
      taskVisible: () => true, observeTasks: () => true });
    const controller = new AbortController();
    monitor.start(controller.signal);
    for (let tick = 0; tick < 240; tick++) { await vi.advanceTimersByTimeAsync(250); w.advance(250); }
    await expect(monitor.guard(monitor.revision())).resolves.toBe(true);
    expect(w.walks()).toBe(0);
    // A forget is a new state version: the monitor has no verdict to read and walks nothing, still not failing...
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    for (let tick = 0; tick < 8; tick++) { await vi.advanceTimersByTimeAsync(250); w.advance(250); }
    expect(w.walks()).toBe(0);
    // ...and every gate that shows or does something asks the whole check, which hides it.
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'tool')).toBe(false);
    expect(w.guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(false);
    // Once that verdict is kept the monitor learns of it without a walk, and fences the step.
    const judged = w.walks();
    await vi.advanceTimersByTimeAsync(500);
    await expect(monitor.guard(monitor.revision())).rejects.toThrow('FCA_SOURCE_WITHHELD');
    expect(w.walks()).toBe(judged);
    controller.abort();
    await monitor.close();
  });
});
