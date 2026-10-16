import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { FCA_SOURCE_BASE_MS, FCA_SOURCE_WALK_LOG_MS } from '../src/mind/action/fca/fcaConversationSources.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * The source guard's incremental check (Minecraft runs 7, 9, 10): a check whose task already had its provenance found visible, under
 * the same rules as a stored verdict, walks only what that walk did not check. Every change that hides today between two walks still
 * hides: a forget, a correction, a lost read receipt, the owner no longer alone, another scope, a base past its time, a new row.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[], read: readonly string[] = []): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled, ...(read.length ? { readSourceIds: read } : {}) });

function world() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = run6RecallShape({ turns: 400, recallingTurns: 10, tasks: 6, recalledPerTask: 10, taskRecallsOfTasks: 2, readsPerTask: 4, skills: 4 });
  cleanups.push(() => f.close());
  const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => driver.close());
  let clock = Date.parse(f.world.now()), lost = new Set<string>();
  const readSourceVisible: typeof f.readSourceVisible = (scope, id, at, shared) => !lost.has(id) && f.readSourceVisible(scope, id, at, shared);
  const guard = () => createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
    ownerAlone: f.ownerAlone, readSourceVisible, clock: () => clock });
  const visible = guard();
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '鉄', goal: '鉄のツルハシ', completionCriteria: '持ち物' }, 'incremental');
  const pool = f.turns.slice(10, 300);
  // A recent turn (the owner's memory list shows recent ones) that the base checks, to forget or correct between two walks.
  const recent = f.turns.at(-3)!;
  const base = Date.parse(f.world.now()) - 3_600_000;
  // A long task's provenance: 120 rows, a skill read on every other one.
  const rows = Array.from({ length: 120 }, (_, index) => memoryRow(`m:${String(index).padStart(3, '0')}`, new Date(base + index * 10_000).toISOString(),
    [...pool.slice(index, index + 20), ...index === 40 ? [recent] : []], index % 2 ? f.skillSources.slice(0, 2) : []));
  const next = (index: number, ids: readonly string[], read: readonly string[] = []) => [...rows, memoryRow(`m:next:${index}`,
    new Date(base + (200 + index) * 10_000).toISOString(), ids, read)];
  return { f, visible, fresh: guard, task, rows, next, pool, recent, advance: (ms: number) => { clock += ms; }, lose: (id: string) => { lost = new Set([...lost, id]); } };
}
type World = ReturnType<typeof world>;
const verdictOf = (w: World, sources: TaskSource[], task: TaskView = w.task) => ({ incremental: w.visible.sources('owner', task, sources), fresh: w.fresh().sources('owner', task, sources) });

describe('the incremental source check', () => {
  it('walks only the new part of a grown provenance, and finds what a whole walk finds', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    const before = w.visible.walks!();
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[5]!, w.pool[150]!]))).toBe(true);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([0, 1]);
    // A new row naming the forgotten turn is found in the part walked.
    expect(verdictOf(w, w.next(2, [w.f.turns.at(-1)!]))).toEqual({ incremental: false, fresh: false });
  });

  it.each([
    ['a forget of a memory the base checked', (w: World) => { w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' }); }],
    ['a correction of a memory the base checked', (w: World) => { w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'correct', text: '訂正' }); }],
    ['the loss of a read receipt the base checked', (w: World) => { w.lose(w.f.skillSources[0]!); }],
  ])('hides after %s between two walks, as a whole walk does', (_label, change) => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    change(w);
    expect(verdictOf(w, w.next(1, [w.pool[200]!]))).toEqual({ incremental: false, fresh: false });
  });

  it.each([
    ['a forget', (w: World) => { w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' }); }],
    ['a correction', (w: World) => { w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'correct', text: '訂正' }); }],
  ])('walks the whole provenance again after %s between two walks (a new state version), and hides (review of d6fcd7d7)', (_label, change) => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    change(w);
    const before = w.visible.walks!();
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(false);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([1, 0]);
  });

  it('does not use a base whose read receipt was lost, and walks whole (review of d6fcd7d7)', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    w.lose(w.f.skillSources[0]!);
    const before = w.visible.walks!();
    // New rows without that receipt: the base it rests on consulted it, so the base is not used.
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(false);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([1, 0]);
  });

  it('hides when the owner is no longer alone, and for another scope, between two walks', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    w.f.setAlone(false);
    expect(verdictOf(w, w.next(1, [w.pool[200]!]))).toEqual({ incremental: false, fresh: false });
    w.f.setAlone(true);
    expect(w.visible.sources('guest', { ...w.task, scopeKey: 'guest' }, w.next(1, [w.pool[200]!]))).toBe(false);
    expect(w.visible.sources('owner', { ...w.task, scopeKey: 'guest' }, w.next(1, [w.pool[200]!]))).toBe(false);
  });

  it('walks whole again once the base is past its time, or for other words of the task', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    const before = w.visible.walks!();
    w.advance(FCA_SOURCE_BASE_MS);
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(true);
    expect(w.visible.sources('owner', { ...w.task, summary: '別の要約' }, w.next(2, [w.pool[201]!]))).toBe(true);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([2, 0]);
  });

  it('walks only the new rows on a base 20 s old while the state version and the reads are unchanged', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    const before = w.visible.walks!();
    w.advance(20_000); // Past the verdict's 5 s, within the base's window.
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(true);
    // The base keeps the time of its own walk: a second extension 15 s later is past the window and walks whole.
    w.advance(15_000);
    expect(w.visible.sources('owner', w.task, w.next(2, [w.pool[201]!]))).toBe(true);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([1, 1]);
  });

  it('hides at once on a 20 s old base after a forget (a new state version), and walks whole', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    w.advance(20_000);
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    const before = w.visible.walks!();
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(false);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([1, 0]);
    // The same provenance, asked again as the same unchanged rows: still hidden, as the whole walk answers.
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(false);
  });

  it('walks whole on a 20 s old base whose read receipt was lost (the reads changed)', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows)).toBe(true);
    w.advance(20_000);
    w.lose(w.f.skillSources[0]!);
    const before = w.visible.walks!();
    expect(w.visible.sources('owner', w.task, w.next(1, [w.pool[200]!]))).toBe(false);
    const after = w.visible.walks!();
    expect([after.walked - before.walked, after.partial! - before.partial!]).toEqual([1, 0]);
  });

  it('keeps a forgotten source out at decision time (a tool is not offered) whatever base it rested on', () => {
    const w = world();
    expect(w.visible.sources('owner', w.task, w.rows, undefined, 'tool')).toBe(true);
    w.advance(20_000);
    w.f.memoryService.mutate('owner', { memoryId: w.recent, action: 'forget' });
    expect(w.visible.sources('owner', w.task, w.rows, undefined, 'step')).toBe(false);
    expect(w.visible.sources('owner', w.task, w.next(1, [w.f.turns.at(-1)!]), undefined, 'tool')).toBe(false);
  });
});

describe('the slow-walk line', () => {
  function logged(thresholdMs: number) {
    const w = world();
    let tick = 0; const lines: string[] = [];
    const guard = createFcaSourceGuard({ runtime: { get: () => w.task, taskSources: () => w.rows } as never, state: w.f.world.store, conversations: w.f.world.store,
      ownerScope: 'owner', ownerAlone: w.f.ownerAlone, readSourceVisible: w.f.readSourceVisible, clock: () => 0,
      monotonic: () => { const value = tick; tick += thresholdMs; return value; }, log: line => lines.push(line) });
    return { w, guard, lines };
  }

  it('names a walk of 100 ms or more, once, with counts, the kind of walk and the caller only', () => {
    const { w, guard, lines } = logged(FCA_SOURCE_WALK_LOG_MS);
    expect(guard.sources('owner', w.task, w.rows, undefined, 'tool')).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Shannon FCA source walk ms=100 sources=\d+ ids=\d+ mode=full via=tool$/);
    // A reuse is no walk: nothing more is said.
    expect(guard.sources('owner', w.task, w.rows, undefined, 'tool')).toBe(true);
    expect(lines).toHaveLength(1);
  });

  it('says nothing for a quick walk, and nothing of what was read', () => {
    const { w, guard, lines } = logged(FCA_SOURCE_WALK_LOG_MS - 1);
    expect(guard.sources('owner', w.task, w.rows)).toBe(true);
    expect(lines).toEqual([]);
    const loud = logged(500);
    expect(loud.guard.sources('owner', loud.w.task, loud.w.rows)).toBe(true);
    const text = JSON.stringify(loud.w.rows.flatMap(row => [...row.recalledMemoryIds, ...row.readSourceIds ?? []]));
    expect(loud.lines).toHaveLength(1);
    for (const id of JSON.parse(text) as string[]) expect(loud.lines[0]).not.toContain(id);
    expect(loud.lines[0]).toMatch(/via=other$/);
  });

  it('calls a walk that rests on a base partial', () => {
    const { w, guard, lines } = logged(200);
    expect(guard.sources('owner', w.task, w.rows, undefined, 'step')).toBe(true);
    expect(guard.sources('owner', w.task, w.next(1, [w.pool[5]!, w.pool[150]!]), undefined, 'evidence')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Shannon FCA source walk ms=200 sources=\d+ ids=\d+ mode=partial via=evidence$/);
  });
});

describe('a minute of a task whose provenance grows each step (run 14 shaped)', () => {
  /** Same minute twice: the old 5 s base window against the new one. Each step adds a row; the monitor and gates ask in between. */
  function minute(baseMilliseconds: number) {
    const w = world();
    const guard = createFcaSourceGuard({ runtime: { get: () => w.task, taskSources: () => w.rows } as never, state: w.f.world.store, conversations: w.f.world.store,
      ownerScope: 'owner', ownerAlone: w.f.ownerAlone, readSourceVisible: w.f.readSourceVisible, clock: () => clock, baseMilliseconds });
    let clock = 0, rows = [...w.rows];
    for (let second = 0; second < 60; second++) {
      if (second % 3 === 0) rows = [...rows, memoryRow(`m:step:${second}`, new Date(Date.parse(w.rows.at(-1)!.observedAt) + second * 1_000 + 1_000).toISOString(), [w.pool[second]!, w.pool[100 + second]!])];
      for (let ask = 0; ask < 3; ask++) expect(guard.sources('owner', w.task, rows, undefined, 'step')).toBe(true);
      clock += 1_000;
    }
    return guard.walks!();
  }

  it('walks the whole provenance far less often than with the 5 s base, and never hides what a whole walk shows', () => {
    const before = minute(5_000), after = minute(FCA_SOURCE_BASE_MS);
    console.log(`run14 minute walks before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect(before.walked).toBeGreaterThanOrEqual(10);
    expect(after.walked).toBeLessThanOrEqual(3);
    expect(after.walked).toBeLessThan(before.walked / 3);
  }, 120_000);
});

describe('a run 10 shaped task: 300 memory rows, a recall and a skill-index row added each step', () => {
  it('walks its whole provenance once, then only what each step adds', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = run6RecallShape({ turns: 1030, tasks: 163, recalledPerTask: 93, taskRecallsOfTasks: 40, readsPerTask: 18, skills: 25 });
    cleanups.push(() => f.close());
    const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
      model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    let clock = Date.parse(f.world.now());
    const visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
      ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => clock });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '鉄', goal: '鉄のツルハシ', completionCriteria: '持ち物' }, 'run10');
    const probe = (id: string) => visible.sources('owner', task, [memoryRow(`p:${id}`, f.world.now(), [id])]);
    const pool = [...f.tasks, ...f.turns.slice(20, 600)].filter(probe).slice(0, 130);
    const base = Date.parse(f.world.now()) - 7_200_000;
    const known = (index: number) => 60 + Math.floor(index * 70 / 320);
    const row = (index: number) => memoryRow(`m:${String(index).padStart(3, '0')}`, new Date(base + index * 5_000).toISOString(),
      pool.slice(Math.max(0, known(index) - 30), known(index)), index % 2 ? f.skillSources.slice(0, 22) : []);
    let rows = Array.from({ length: 300 }, (_, index) => row(index));
    const counts = () => visible.walks!();
    const start = counts(), times: number[] = [];
    // Ten steps of ~15 s: at its start, after its recall row, after its skill-index row, and before each of two tools.
    for (let step = 0; step < 10; step++) {
      clock += 15_000;
      for (const added of [0, 1, 1, 0, 0]) {
        if (added) rows = [...rows, row(rows.length)];
        const at = performance.now();
        expect(visible.sources('owner', task, rows)).toBe(true);
        times.push(performance.now() - at);
        clock += 1_000;
      }
    }
    const end = counts();
    const result = { full: end.walked - start.walked, partial: (end.partial ?? 0) - (start.partial ?? 0), reused: end.reused - start.reused,
      ms: Math.round(times.reduce((sum, ms) => sum + ms, 0)) };
    console.log(`run10 walks ${JSON.stringify(result)}`);
    expect(result.full).toBeLessThanOrEqual(10);
  }, 300_000);
});
