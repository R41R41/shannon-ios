import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource, TaskStep, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore, type FcaEvidenceOptions } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { fcaProvenanceForCheck } from '../src/mind/action/fca/fcaConversationSources.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { memoryWorld } from './support/memoryWorld.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * Minecraft run 7 (2026-10-14, read-only investigation): `evidence.prepare` blocked the API's one thread 1.8–5.8 s per FCA step
 * (observer span emotion/shared_context), growing with the run. It parsed and walked every one of the newest 24 outcome rows, each
 * holding the task's whole provenance (~313 KB, at most ~407 KB; 94 to 158 memory rows, 2,449 to 5,207 recalled ids over 73 to 99
 * distinct), and the guard's verdict cache missed for each (its key holds the sources): 9–10 full walks a step late in the run.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[], read: readonly string[] = []): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled, ...(read.length ? { readSourceIds: read } : {}) });
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
let inserted = 0;
function insertOutcome(db: DatabaseSync, taskId: string, stepId: string, callId: string, sources: readonly TaskSource[], at: string) {
  inserted += 1;
  db.prepare(`INSERT INTO fca_action_evidence(scope_key,event_id,task_id,step_id,call_id,name,observation,result_json,sources_json,registered_at,observed_at,goal,action_json)
    VALUES('owner',?,?,?,?,'mc.observe','observed',?,?,?,?,'goal',?)`).run(`${stepId}:${callId}`, taskId, stepId, callId,
    JSON.stringify({ ok: true, text: `result ${inserted}` }), JSON.stringify(sources), at, at, JSON.stringify({ id: callId, name: 'mc.observe', input: {} }));
  return `${stepId}:${callId}`;
}
const stepOf = (task: TaskView, sources: TaskSource[]): TaskStep => ({ id: 'step-current', scopeKey: 'owner', taskId: task.id, lease: {} as TaskStep['lease'],
  revision: 1, messageIds: [], snapshot: { task, messages: [], sources, history: [], checkpoint: null, revision: 1 } });
const quiet = () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => info.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA evidence prepare'));
};

/** The real source guard and evidence store over a remembered world, wired as `fcaSharedWiring.ts` wires them. */
function wired(f: Run6RecallShape) {
  const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => driver.close());
  const visible = createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
    ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => Date.parse(f.world.now()) });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '持ち物で確かめる' }, 'mc-run7');
  const runtime = driver.runtime;
  const options: FcaEvidenceOptions = { db: h.db, state: f.world.store, now: f.world.now, validStep: () => true,
    sourcesVisible: (scope, id, sources) => { const view = runtime.get(scope, id); return Boolean(view && visible.sources(scope, view, sources)); },
    sourcesCovered: (scope, id, verified, candidate) => { const view = runtime.get(scope, id); return Boolean(view && visible.covers!(scope, view, verified, candidate)); },
    sourcesResidual: (scope, id, verified, candidate) => { const view = runtime.get(scope, id); return view ? visible.residual!(scope, view, verified, candidate) : null; },
    walkCounts: visible.walks, taskVisible: (scope, id) => visible(scope, id), observeContext: () => true };
  return { h, runtime, visible, root, task, options, evidence: new SQLiteFcaEvidenceStore(options) };
}

describe('the evidence store\'s choice of rows (P1)', () => {
  function stubbed(rows: number, judge: { visible?: (sources: readonly TaskSource[], taskId: string) => boolean; covered?: boolean } = {}) {
    const world = memoryWorld(); cleanups.push(world.close);
    const h = actionHarness(world.now, world.path); cleanups.push(h.close); migrateAgentTasks(h.db);
    const calls = { visible: 0, covered: 0, coveredTasks: new Set<string>() };
    const task = { id: 'task-own', childIds: ['task-child'] } as unknown as TaskView;
    const options: FcaEvidenceOptions = { db: h.db, state: world.store, now: world.now, validStep: () => true, taskVisible: () => true, observeContext: () => true,
      sourcesVisible: (_scope, taskId, sources) => { calls.visible += 1; return judge.visible?.(sources, taskId) ?? true; },
      ...(judge.covered === undefined ? {} : { sourcesCovered: (_scope: string, taskId: string) => { calls.covered += 1; calls.coveredTasks.add(taskId); return judge.covered!; } }) };
    const evidence = new SQLiteFcaEvidenceStore(options), ids: string[] = [];
    for (let index = 0; index < rows; index++) {
      ids.push(insertOutcome(h.db, 'task-own', `step-${index}`, 'call', [memoryRow(`memory:${index}`, world.now(), [`id-${index}`])], world.now()));
    }
    return { world, h, calls, task, options, ids, evidence };
  }

  it('stops at the eighth visible row and parses nothing past it', async () => {
    const lines = quiet();
    const f = stubbed(24);
    const context = await f.evidence.prepare(stepOf(f.task, []));
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual(f.ids.slice(-8).reverse());
    // The step before and after, eight rows walked (before this change all 24 were parsed and walked), and, as it yielded, the
    // step's verified sources and the eight admitted sets again at its end.
    expect(f.calls.visible).toBe(2 + 8 + 1 + 8);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/outcome=ok total=\d+ms flush=\d+ms select=\d+ms affect=\d+ms rows=8 rowChecks=16 covered=0 reduced=0 deduped=0 walks=0 reused=0 parsedBytes=\d+ yields=8$/u);
  });

  it('judges an identical stored set once, and goes on past hidden rows', async () => {
    quiet();
    const f = stubbed(0, { visible: sources => !sources.some(source => source.recalledMemoryIds.includes('hidden')) });
    const shared = [memoryRow('memory:shared', f.world.now(), ['a', 'b'])], hidden = [memoryRow('memory:hidden', f.world.now(), ['hidden'])];
    const older = Array.from({ length: 5 }, (_, index) => insertOutcome(f.h.db, 'task-own', `old-${index}`, 'call', shared, f.world.now()));
    for (let index = 0; index < 6; index++) insertOutcome(f.h.db, 'task-own', `hidden-${index}`, 'call', hidden, f.world.now());
    const context = await f.evidence.prepare(stepOf(f.task, []));
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([...older].reverse());
    // The step twice, the hidden set once, the shared set once; at the end the verified sources and the shared set again.
    expect(f.calls.visible).toBe(2 + 2 + 2);
  });

  it('asks coverage only for the step\'s own task: a row of another task is walked, and stays hidden', async () => {
    quiet();
    const f = stubbed(0, { covered: true, visible: (_sources, taskId) => taskId !== 'task-child' });
    const own = insertOutcome(f.h.db, 'task-own', 'own', 'call', [memoryRow('memory:own', f.world.now(), ['a'])], f.world.now());
    insertOutcome(f.h.db, 'task-child', 'child', 'call', [memoryRow('memory:own', f.world.now(), ['a'])], f.world.now());
    const context = await f.evidence.prepare(stepOf(f.task, []));
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([own]);
    expect([...f.calls.coveredTasks]).toEqual(['task-own']);
    expect(f.calls.visible).toBe(2 + 1 + 1); // the step twice, the child's row, the verified sources again at the end
  });

  it('asks again, at its end, what it admitted before a yield: a source withheld meanwhile leaves its rows out', async () => {
    quiet();
    let withheld = false;
    const f = stubbed(0, { visible: sources => {
      if (!sources.some(source => source.recalledMemoryIds.includes('late'))) return true;
      // Admitted now; the owner forgets it while the store lets the event loop through before its next walk.
      if (!withheld) setImmediate(() => { withheld = true; });
      return !withheld;
    } });
    const other = insertOutcome(f.h.db, 'task-child', 'other', 'call', [memoryRow('memory:other', f.world.now(), ['other'])], f.world.now());
    insertOutcome(f.h.db, 'task-child', 'late', 'call', [memoryRow('memory:late', f.world.now(), ['late'])], f.world.now());
    const context = await f.evidence.prepare(stepOf(f.task, []));
    expect(withheld).toBe(true);
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([other]);
  });

  it('holds the step when its lease lapsed during a yield, before any lineage is written', async () => {
    const lines = quiet();
    let valid = true, observed = 0;
    const f = stubbed(0);
    insertOutcome(f.h.db, 'task-child', 'child', 'call', [memoryRow('memory:c', f.world.now(), ['c'])], f.world.now());
    const evidence = new SQLiteFcaEvidenceStore({ ...f.options, validStep: () => valid, observeContext: () => { observed += 1; return true; } });
    setImmediate(() => { valid = false; });
    await expect(evidence.prepare(stepOf(f.task, []))).rejects.toThrow('FCA_EVIDENCE_HELD');
    expect(observed).toBe(0);
    expect(lines().at(-1)).toContain('outcome=FCA_EVIDENCE_HELD');
  });
});

describe('a row of the step\'s own task covered by its verified sources (P1 b): the real guard', () => {
  function world() {
    const f = run6RecallShape({ turns: 400, recallingTurns: 10, tasks: 6, recalledPerTask: 10, taskRecallsOfTasks: 2, readsPerTask: 4, skills: 4 });
    cleanups.push(() => f.close());
    return f;
  }
  /** Turns early in the world recall nothing and are not forgotten: each visible on its own. */
  const clean = (f: Run6RecallShape) => f.turns.slice(10, 360);

  it('shows a covered row without a walk, and keeps hidden a row with a forgotten memory, a withheld reply or an unreceived receipt', async () => {
    quiet();
    const f = world(), w = wired(f), pool = clean(f);
    const corrected = f.turns.at(-2)!; // a recent turn, as the owner corrects one from his memory list
    f.world.advance(60_000);
    const before = Date.parse(f.world.now());
    f.world.advance(5 * 60_000);
    f.memoryService.mutate('owner', { memoryId: corrected, action: 'correct', text: '訂正された内容' });
    f.world.advance(5 * 60_000);
    const after = Date.parse(f.world.now());
    const early = memoryRow('memory:early', iso(before), pool.slice(0, 20), f.skillSources);
    const late = memoryRow('memory:late', iso(after), [corrected, ...pool.slice(10, 30)]);
    const verified = [early, late];
    const cases: Array<[string, TaskSource[], boolean]> = [
      ['an earlier step\'s sources', [early], true],
      ['a forgotten memory', [early, memoryRow('memory:forgotten', iso(after + 1_000), [f.turns.at(-1)!])], false],
      ['a reply withheld by a correction: the corrected id before it', [early, memoryRow('memory:before', iso(before + 1_000), [corrected])], false],
      ['an unreceived read receipt', [early, memoryRow('memory:receipt', iso(after), [], ['fca-unresolved://web.read'])], false],
    ];
    // Oldest first, so the covered row is judged last, after the walks of the three others.
    const ids = cases.map(([, sources], index) => insertOutcome(w.h.db, w.task.id, `step-${index}`, 'call', sources, iso(after)));
    const walks = w.visible.walks!();
    const context = await w.evidence.prepare(stepOf(w.task, verified));
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([ids[0]]);
    // The step's verified sources and the three hidden rows were walked; the covered one was not.
    expect(w.visible.walks!().walked - walks.walked).toBe(1 + 3);
    // Each verdict as the guard gives it on its own, and coverage only where the row is visible.
    expect(w.visible.sources('owner', w.task, verified)).toBe(true);
    for (const [label, sources, shown] of cases) {
      expect(w.visible.sources('owner', w.task, sources), label).toBe(shown);
      expect(w.visible.covers!('owner', w.task, verified, sources), label).toBe(shown);
    }
  });

  it('walks a prefix whose fold judges an id earlier than the step\'s fold did, and keeps it hidden (naive inclusion would show it)', async () => {
    quiet();
    const f = world(), w = wired(f), pool = clean(f);
    // Past 64 times the guard folds consecutive times into their earliest; the buckets of 100 rows and of 130 differ.
    const full = 130, prefix = 100, room = 64;
    const startOf = (index: number, count: number) => {
      for (let bucket = 0; bucket < room; bucket++) if (Math.floor((bucket + 1) * count / room) > index) return Math.floor(bucket * count / room);
      return index;
    };
    const j = Array.from({ length: prefix }, (_, index) => index).find(index => startOf(index, prefix) < startOf(index, full))!;
    expect(j).toBeDefined();
    const corrected = f.turns.at(-2)!;
    pool[j] = corrected;
    f.world.advance(60_000);
    f.memoryService.mutate('owner', { memoryId: corrected, action: 'correct', text: '訂正された内容' });
    const control = f.world.store.snapshot('owner').memoryControls.find(item => item.memoryId === corrected)!;
    const boundary = Date.parse(control.contextInvalidatedAt ?? control.updatedAt);
    // The step's bucket of the corrected id starts after the correction; the prefix's starts before it.
    const at = (index: number) => iso(boundary + (index - startOf(j, full)) * 1_000 + 500);
    const rows = Array.from({ length: full }, (_, index) => memoryRow(`memory:${String(index).padStart(3, '0')}`, at(index), [pool[index]!]));
    const verified = rows, earlier = rows.slice(0, prefix);
    const foldedAt = (sources: TaskSource[]) => fcaProvenanceForCheck(sources).find(source => source.recalledMemoryIds.includes(corrected))!.observedAt;
    expect(foldedAt(verified) > iso(boundary)).toBe(true);
    expect(foldedAt(earlier) < iso(boundary)).toBe(true);
    expect(w.visible.sources('owner', w.task, verified)).toBe(true);
    expect(w.visible.sources('owner', w.task, earlier)).toBe(false);
    expect(w.visible.covers!('owner', w.task, verified, earlier)).toBe(false);
    // What a walk still checks after the verified one (Minecraft run 9): the corrected id among a few, and hidden as the whole is.
    const rest = w.visible.residual!('owner', w.task, verified, earlier)!;
    expect(rest.flatMap(source => source.recalledMemoryIds)).toContain(corrected);
    expect(rest.flatMap(source => source.recalledMemoryIds).length).toBeLessThan(prefix);
    expect(w.visible.sources('owner', w.task, rest)).toBe(false);
    const id = insertOutcome(w.h.db, w.task.id, 'step-prefix', 'call', earlier, at(prefix));
    const context = await w.evidence.prepare(stepOf(w.task, verified));
    expect(context.recentOutcomes.map(item => item.eventId)).not.toContain(id);
  });

  it('walks only the rest of a visible prefix the buckets moved, and shows it (Minecraft run 9)', async () => {
    const lines = quiet();
    const f = world(), w = wired(f), pool = clean(f);
    const full = 130, prefix = 100, start = Date.parse(f.world.now());
    const rows = Array.from({ length: full }, (_, index) => memoryRow(`memory:${String(index).padStart(3, '0')}`, iso(start + index * 1_000), [pool[index]!]));
    const earlier = rows.slice(0, prefix);
    expect(w.visible.covers!('owner', w.task, rows, earlier)).toBe(false);
    const rest = w.visible.residual!('owner', w.task, rows, earlier)!;
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.flatMap(source => source.recalledMemoryIds).length).toBeLessThan(prefix / 2);
    const id = insertOutcome(w.h.db, w.task.id, 'step-prefix', 'call', earlier, iso(start + prefix * 1_000));
    const context = await w.evidence.prepare(stepOf(w.task, rows));
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([id]);
    expect(w.visible.sources('owner', w.task, earlier)).toBe(true);
    expect(lines().at(-1)).toContain('reduced=1');
  });
});

describe('a child task withheld during the yield (review of 5d492ae8, F3)', () => {
  it('leaves out a child\'s outcome when a memory the child holds is forgotten while the store lets the event loop through', async () => {
    quiet();
    const f = run6RecallShape({ turns: 200, recallingTurns: 10, tasks: 4, recalledPerTask: 8, taskRecallsOfTasks: 2, readsPerTask: 2, skills: 2 });
    cleanups.push(() => f.close());
    const w = wired(f);
    const child = w.runtime.createChild('owner', w.task.id, { title: '材料集め', goal: '木を集める', completionCriteria: '持ち物で確かめる' }, 'mc-child');
    const victim = f.turns.at(-3)!;
    const action = await w.h.actions.claim((await w.h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${child.id}:${child.revision}`, resources: [actionResource('owner', `fca:${child.id}`)] })).id);
    const childStep = w.runtime.beginStep('owner', child.id, leaseOf(action!))!;
    expect(w.runtime.observeSources(childStep, { observationId: 'child-recall', recalledMemoryIds: [victim] })).toBe(true);
    expect(w.visible('owner', child.id)).toBe(true);
    // The child's stored outcome does not name the memory; the child itself holds it now.
    const id = insertOutcome(w.h.db, child.id, 'child-step', 'call', [], f.world.now());
    const parent = w.runtime.get('owner', w.task.id)!;
    expect(parent.childIds).toContain(child.id);
    setImmediate(() => { f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' }); });
    const context = await w.evidence.prepare(stepOf(parent, []));
    expect(w.visible('owner', child.id)).toBe(false);
    expect(context.recentOutcomes.map(item => item.eventId)).not.toContain(id);
  });
});

describe('Minecraft run 7 shape: 39 rows of 158 memory sources and 5,207 recalled ids over 99 (P1, P3)', () => {
  it('prepares with at most two full walks, well within a CI bound', async () => {
    const lines = quiet();
    const f = run6RecallShape(); cleanups.push(() => f.close());
    const w = wired(f);
    // 99 distinct ids the owner can see today: task experiences (each recalling ~52 memories and 16 skill reads) and turns.
    const single = (id: string) => w.visible.sources('owner', w.task, [memoryRow(`memory:probe:${id}`, f.world.now(), [id])]);
    const pool = [...f.tasks, ...f.turns.slice(20, 400)].filter(single).slice(0, 99);
    expect(pool).toHaveLength(99);
    const base = Date.parse(f.world.now());
    // 158 rows over 79 steps (a recall and a skill index each); 5,207 recalled ids in all. New ids keep arriving as the run goes on
    // (33 known at the first row, 99 at the last; each row recalls the 33 newest, the first seven rows one fewer), so each earlier step's provenance folds differently and the guard's verdict
    // cache, keyed by the folded sources, missed for each stored set (as in run 7).
    const known = (index: number) => 33 + Math.floor(index * 66 / 157);
    const rows = Array.from({ length: 158 }, (_, index) => memoryRow(`memory:step-${String(index >> 1).padStart(3, '0')}:${index % 2 ? 'skills' : 'recall'}`,
      iso(base + (index >> 1) * 15_000 + (index % 2) * 1_000), Array.from({ length: index < 7 ? 32 : 33 }, (_, k) => pool[known(index) - 33 + k]!),
      index % 2 ? f.skillSources : []));
    expect(rows.reduce((total, row) => total + row.recalledMemoryIds.length, 0)).toBe(5_207);
    expect(new Set(rows.flatMap(row => row.recalledMemoryIds)).size).toBe(99);
    // Thirteen earlier steps of three outcomes each, their sources the task's at that step (86 to 158 rows), newest last.
    for (let step = 0; step < 13; step++) {
      const sources = rows.slice(0, 158 - 6 * (12 - step));
      for (const call of ['a', 'b', 'c']) insertOutcome(w.h.db, w.task.id, `step-${String(step).padStart(2, '0')}`, call, sources, iso(base + 1_200_000 + step * 30_000));
    }
    const bytes = (w.h.db.prepare('SELECT MAX(length(sources_json)) AS most FROM fca_action_evidence').get() as { most: number }).most;
    expect(bytes).toBeGreaterThan(200_000);
    const step = stepOf(w.task, rows);
    const timings: number[] = [], walks: number[] = [];
    for (let round = 0; round < 3; round++) {
      // Each round a fresh moment: the guard's verdicts from the round before have expired.
      f.world.advance(10_000);
      const before = w.visible.walks!(), started = performance.now();
      const context = await w.evidence.prepare(step);
      timings.push(Math.round(performance.now() - started));
      walks.push(w.visible.walks!().walked - before.walked);
      expect(context.recentOutcomes).toHaveLength(8);
    }
    console.log(`run7 prepare ms=${JSON.stringify(timings)} walks=${JSON.stringify(walks)} line=${lines().at(-1)}`);
    expect(Math.max(...walks)).toBeLessThanOrEqual(2);
    expect(Math.max(...timings)).toBeLessThan(5_000);
  }, 300_000);
});
