import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource, TaskStep, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore, type FcaEvidenceOptions } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import { FcaUnseenBackoff, runSliced } from '../src/mind/action/fca/store/fcaEvidenceDrain.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * Minecraft run 13 (2026-10-17), right after a step was retired: the API's event loop was blocked nine times, 7.9 to 17.6 s each.
 * The evidence store's flush (every 1 s wake tick, every prepare, every commit) judged every undelivered outcome and every ended
 * task's held segment by walks of the recall graph in one synchronous pass, and a prepare that had yielded asked all its walked
 * sets again at its end, after the guard's 5 s verdicts had aged out during the stall. These tests keep each of those in slices.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const memoryRow = (stepId: string, observedAt: string, recalled: readonly string[]): TaskSource => ({
  kind: 'memory', stepId, experienceId: null, threadId: null, observedAt, recalledMemoryIds: recalled });
const quiet = () => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function spin(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) { /* a walk's synchronous cost */ }
}
const stepOf = (task: TaskView, sources: TaskSource[]): TaskStep => ({ id: 'step-current', scopeKey: 'owner', taskId: task.id, lease: {} as TaskStep['lease'],
  revision: 1, messageIds: [], snapshot: { task, messages: [], sources, history: [], checkpoint: null, revision: 1 } });
function insertRow(db: DatabaseSync, taskId: string, eventId: string, sources: readonly TaskSource[], at: string, delivered = 0, name = 'mc.observe') {
  db.prepare(`INSERT INTO fca_action_evidence(scope_key,event_id,task_id,step_id,call_id,name,observation,result_json,sources_json,registered_at,observed_at,goal,action_json,outcome_delivered)
    VALUES('owner',?,?,?,?,?,'observed',?,?,?,?,'goal',?,?)`).run(eventId, taskId, eventId.split(':')[0]!, 'call', name, JSON.stringify({ ok: true, text: '{"done":true}' }),
    JSON.stringify(sources), at, at, JSON.stringify({ id: 'call', name, input: {} }), delivered);
  return eventId;
}
/** The longest gap between two turns of the event loop while `work` runs: what everything else on the one thread waited. */
async function longestWait(work: () => Promise<unknown>): Promise<number> {
  let longest = 0, last = performance.now(), running = true;
  const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (running) setImmediate(tick); };
  setImmediate(tick);
  try { await work(); } finally { running = false; }
  await nextTurn();
  return longest;
}

describe('the source guard\'s peek (a verdict it would reuse, never a walk)', () => {
  it('is undefined before a walk, the verdict after it, undefined again once the window or the state version has passed', () => {
    const f = run6RecallShape({ turns: 120, recallingTurns: 4, tasks: 2, recalledPerTask: 4, taskRecallsOfTasks: 1, readsPerTask: 1, skills: 1 });
    cleanups.push(() => f.close());
    const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
      model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    const guard = createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
      ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => Date.parse(f.world.now()) });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '持ち物で確かめる' }, 'mc-peek');
    const victim = f.turns.at(-3)!;
    const sources = [memoryRow('memory:peek', f.world.now(), [f.turns[20]!, victim])];
    const before = guard.walks!();
    expect(guard.peek!('owner', task, sources)).toBeUndefined();
    expect(guard.walks!()).toEqual(before); // asking walks, remembers and counts nothing
    expect(guard.sources('owner', task, sources)).toBe(true);
    expect(guard.peek!('owner', task, sources)).toBe(true);
    f.world.advance(6_000); // past FCA_SOURCE_VERDICT_MS
    expect(guard.peek!('owner', task, sources)).toBeUndefined();
    expect(guard.sources('owner', task, sources)).toBe(true);
    expect(guard.peek!('owner', task, sources)).toBe(true);
    f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' }); // a new state version: judged afresh
    expect(guard.peek!('owner', task, sources)).toBeUndefined();
    expect(guard.sources('owner', task, sources)).toBe(false);
    expect(guard.peek!('owner', task, sources)).toBe(false);
  });
});

/** The real guard and evidence store over a remembered world; `peek` wires the evidence store's warming (`fcaSharedWiring.ts`). */
function wired(f: Run6RecallShape, peek: boolean) {
  const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => driver.close());
  const guard = createFcaSourceGuard({ runtime: driver.runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
    ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => Date.parse(f.world.now()) });
  const root = driver.runtime.ensureRoot('owner');
  const task = driver.runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '持ち物で確かめる' }, 'mc-stall');
  const turns = { current: 0 }, walksByTurn = new Map<number, number>();
  const walked = () => guard.walks!().walked + (guard.walks!().partial ?? 0);
  const options: FcaEvidenceOptions = { db: h.db, state: f.world.store, now: f.world.now, validStep: () => true,
    sourcesVisible: (scope, id, sources) => {
      const view = driver.runtime.get(scope, id), at = walked();
      try { return Boolean(view && guard.sources(scope, view, sources)); } finally { walksByTurn.set(turns.current, (walksByTurn.get(turns.current) ?? 0) + walked() - at); }
    },
    ...(peek ? { sourcesPeek: (scope: string, id: string, sources: readonly TaskSource[]) => { const view = driver.runtime.get(scope, id); return view ? guard.peek!(scope, view, sources) : false; } } : {}),
    walkCounts: guard.walks, taskVisible: (scope, id) => guard(scope, id), observeContext: () => true };
  /** Turns of the loop counted from now; `at` runs in the turn it names. */
  const clock = (hooks: Record<number, () => void>) => {
    let running = true;
    const tick = () => { turns.current += 1; hooks[turns.current]?.(); if (running) setImmediate(tick); };
    setImmediate(tick);
    return () => { running = false; };
  };
  return { h, task, guard, options, turns, walksByTurn, clock, evidence: new SQLiteFcaEvidenceStore(options) };
}

describe('a prepare that yielded, with its verdicts aged out by the stall (run 13)', () => {
  const world = () => { const f = run6RecallShape({ turns: 160, recallingTurns: 4, tasks: 2, recalledPerTask: 4, taskRecallsOfTasks: 1, readsPerTask: 1, skills: 1 }); cleanups.push(() => f.close()); return f; };
  function rows(f: Run6RecallShape, h: DatabaseSync, taskId: string, count: number, hot?: string) {
    const now = Date.parse(f.world.now());
    return Array.from({ length: count }, (_, index) => insertRow(h, taskId, `old-${index}:call`,
      [memoryRow(`memory:row-${index}`, iso(now + index), [hot !== undefined && index === count - 1 ? hot : f.turns[40 + index]!, f.turns[60 + index]!])], iso(now + index)));
  }

  it('walks each aged verdict in a turn of its own, so the final check is a reuse; the control walks them all in one slice', async () => {
    quiet();
    const shown: Record<string, string[]> = {}, worst: Record<string, number> = {};
    for (const peek of [false, true]) {
      const f = world(), w = wired(f, peek);
      const ids = rows(f, w.h.db, w.task.id, 6);
      const verified = [memoryRow('memory:verified', f.world.now(), [f.turns[100]!])];
      // The stall: 6 s pass while the walks wait for the loop, so every verdict made before ages out of the guard's window.
      const stop = w.clock({ 3: () => f.world.advance(6_000) });
      const context = await w.evidence.prepare(stepOf(w.task, verified));
      stop();
      const key = peek ? 'peek' : 'control';
      shown[key] = context.recentOutcomes.map(item => item.eventId);
      worst[key] = Math.max(...w.walksByTurn.values());
      expect(shown[key], key).toEqual([...ids].reverse());
    }
    expect(shown.peek).toEqual(shown.control);
    expect(worst.control!).toBeGreaterThanOrEqual(2); // the aged verdicts, all walked again in the one synchronous final check
    expect(worst.peek!).toBe(1); // no turn of the loop holds more than one walk
  });

  it('still leaves out a source forgotten while it yielded: the new state version is judged afresh, not reused', async () => {
    quiet();
    const f = world(), w = wired(f, true);
    const victim = f.turns.at(-3)!, ids = rows(f, w.h.db, w.task.id, 5, victim); // the newest row, walked first, names it
    const stop = w.clock({ 3: () => { f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' }); } });
    const context = await w.evidence.prepare(stepOf(w.task, [memoryRow('memory:verified', f.world.now(), [f.turns[100]!])]));
    stop();
    expect(context.recentOutcomes.map(item => item.eventId)).toEqual([...ids].reverse().filter(id => id !== ids[4]));
  });

  it('holds the step, with nothing shown, when the step\'s own verified source is forgotten while it yielded', async () => {
    quiet();
    const f = world(), w = wired(f, true);
    rows(f, w.h.db, w.task.id, 4);
    const victim = f.turns[100]!;
    const stop = w.clock({ 3: () => { f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' }); } });
    await expect(w.evidence.prepare(stepOf(w.task, [memoryRow('memory:verified', f.world.now(), [victim])]))).rejects.toThrow('FCA_EVIDENCE_HELD');
    stop();
  });
});

/** An evidence store over stub verdicts, with ended tasks that hold segments of body actions. */
function segments(parts: { tasks: number; rows: number; walkMilliseconds?: number; covered?: boolean; hiddenId?: string }) {
  const world = memoryWorld(); cleanups.push(world.close);
  const h = actionHarness(world.now, world.path); cleanups.push(h.close); migrateAgentTasks(h.db);
  const runtime = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: world.now, canRunTask: () => false,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => runtime.close());
  const root = runtime.runtime.ensureRoot('owner');
  const deliveries: FcaDurableOutcome[] = [], calls = { visible: 0, covered: 0 };
  const state: { visible: boolean; hidden: string | undefined } = { visible: true, hidden: parts.hiddenId };
  const hides = (sources: readonly TaskSource[]) => state.hidden !== undefined && sources.some(source => source.recalledMemoryIds.includes(state.hidden!));
  const options: FcaEvidenceOptions = { db: h.db, state: world.store, now: world.now, validStep: () => true, taskVisible: () => true, observeContext: () => true,
    sourcesVisible: (_scope, _id, sources) => { calls.visible += 1; spin(parts.walkMilliseconds ?? 0); return state.visible && !hides(sources); },
    // A task's provenance only grows: an earlier step's sources are covered by a later step's that name each of its steps.
    ...(parts.covered ? { sourcesCovered: (_scope: string, _id: string, verified: readonly TaskSource[], candidate: readonly TaskSource[]) => {
      calls.covered += 1; return candidate.every(source => verified.some(other => other.stepId === source.stepId)) && !hides(candidate);
    } } : {}),
    onOutcome: outcome => { deliveries.push(outcome); } };
  const evidence = new SQLiteFcaEvidenceStore(options);
  const tasks = Array.from({ length: parts.tasks }, (_, index) => {
    const task = runtime.runtime.createChild('owner', root.id, { title: `採掘${index}`, goal: '掘る' }, `mc-held-${index}`);
    const at = world.now();
    for (let row = 0; row < parts.rows; row++) {
      // Each step's sources are the task's so far: step 0, then steps 0 and 1, ...
      const sources = Array.from({ length: row + 1 }, (_, step) => memoryRow(`memory:${task.id}:${step}`, at, [`id-${step}`]));
      insertRow(h.db, task.id, `${task.id}-s${row}:call`, sources, at, 2, 'mc.move-to');
    }
    runtime.runtime.stop('owner', task.id, 'owner_stop');
    return task;
  });
  const held = () => Number((h.db.prepare('SELECT COUNT(*) AS n FROM fca_action_evidence WHERE outcome_delivered=2').get() as { n: number }).n);
  /** An observed, not yet delivered outcome of the first task, with the history row that lets it be delivered. */
  const undelivered = (stepId: string, ids: readonly string[], text = '{"done":true}') => {
    const at = world.now();
    const eventId = `${stepId}:call`;
    insertRow(h.db, tasks[0]!.id, eventId, [memoryRow(`memory:${stepId}`, at, ids)], at, 0, 'web.search');
    h.db.prepare('UPDATE fca_action_evidence SET result_json=? WHERE event_id=?').run(JSON.stringify({ ok: true, text }), eventId);
    h.db.prepare("INSERT INTO fca_task_history(task_id,step_id,entries_json,committed_at) VALUES(?,?,'[]',?)").run(tasks[0]!.id, stepId, at);
    return eventId;
  };
  return { world, h, evidence, deliveries, calls, state, tasks, held, undelivered };
}

/** A delivered segment without the task's id (each fixture makes its own), to compare two runs. */
const bare = (id: string) => id.replace(/^[0-9a-f-]{36}-s/u, 's');
const episode = (item: FcaDurableOutcome) => [bare(item.outcomeId), item.segment!.eventIds.map(bare)];

describe('closing the held segments of ended tasks', () => {
  it('judges the older rows by what they add to the newest row\'s sources: one walk for a segment, not one per step', () => {
    quiet();
    const f = segments({ tasks: 1, rows: 12, covered: true });
    f.evidence.flush();
    expect(f.held()).toBe(0);
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.segment!.actions).toHaveLength(12);
    expect(f.calls.visible).toBeLessThanOrEqual(2);
    // Without coverage every distinct set is judged, as before.
    const g = segments({ tasks: 1, rows: 12 });
    g.evidence.flush();
    expect(g.calls.visible).toBeGreaterThanOrEqual(12);
    expect(g.deliveries.map(episode)).toEqual(f.deliveries.map(episode));
  });

  it('never closes a segment with a row whose source is hidden, however the rows are judged: it stays held and is remembered unseen by no one', () => {
    quiet();
    for (const covered of [true, false]) {
      // An older step recalled a memory the owner has since forgotten: the newest step's sources do not name it.
      const f = segments({ tasks: 1, rows: 4, covered, hiddenId: 'id-1' });
      f.evidence.flush();
      expect(f.deliveries, `covered ${covered}`).toEqual([]);
      expect(f.held(), `covered ${covered}`).toBe(4);
    }
  });

  it('closes the same segment with the same event ids and outcome id, by a flush or by a sliced drain, and once however often it is asked', async () => {
    quiet();
    const a = segments({ tasks: 3, rows: 4, covered: true }), b = segments({ tasks: 3, rows: 4, covered: true });
    a.evidence.flush();
    await b.evidence.drain({ segments: true });
    const shape = (items: FcaDurableOutcome[]) => items.map(item => [item.action.name, ...episode(item), item.segment!.closedBy]);
    expect(shape(b.deliveries)).toEqual(shape(a.deliveries));
    expect(a.deliveries).toHaveLength(3);
    for (const f of [a, b]) {
      expect(f.held()).toBe(0);
      f.evidence.flush();
      await f.evidence.drain({ segments: true });
      expect(f.deliveries).toHaveLength(3);
    }
    // A flush in the middle of a sliced pass, and two passes asked together, deliver each segment once.
    const c = segments({ tasks: 6, rows: 3, covered: true, walkMilliseconds: 12 });
    const first = c.evidence.drain({ segments: true });
    setImmediate(() => c.evidence.flush());
    await Promise.all([first, c.evidence.drain({ segments: true })]);
    expect(new Set(c.deliveries.map(item => item.outcomeId)).size).toBe(c.deliveries.length);
    expect(c.deliveries).toHaveLength(6);
    expect(c.held()).toBe(0);
  });

  it('does not walk the ended tasks\' segments in a step\'s commit; the maintenance pass closes them', async () => {
    quiet();
    const f = segments({ tasks: 2, rows: 3, covered: true });
    f.evidence.committed({} as TaskStep);
    expect(f.calls.visible).toBe(0);
    expect(f.deliveries).toEqual([]);
    await nextTurn();
    await f.evidence.drain({ segments: true });
    expect(f.deliveries).toHaveLength(2);
    expect(f.held()).toBe(0);
  });

  it('does not ask a segment that could not be shown again at every tick; a flush still does, and closes it once it can be', async () => {
    quiet();
    const f = segments({ tasks: 1, rows: 3 });
    f.state.visible = false;
    await f.evidence.drain({ segments: true });
    const asked = f.calls.visible;
    expect(asked).toBeGreaterThan(0);
    await f.evidence.drain({ segments: true });
    await f.evidence.drain({ segments: true });
    expect(f.calls.visible).toBe(asked);
    f.evidence.flush();
    expect(f.calls.visible).toBeGreaterThan(asked);
    expect(f.deliveries).toEqual([]);
    f.state.visible = true;
    f.evidence.flush();
    expect(f.deliveries).toHaveLength(1);
    expect(f.held()).toBe(0);
  });

  it('keeps no single synchronous slice near the cost of the whole pass: many ended tasks, each walk costing 10 ms', async () => {
    quiet();
    const f = segments({ tasks: 40, rows: 2, walkMilliseconds: 10 });
    const g = segments({ tasks: 40, rows: 2, walkMilliseconds: 10 });
    const started = performance.now();
    const synchronous = await longestWait(async () => { g.evidence.flush(); });
    const whole = performance.now() - started;
    const sliced = await longestWait(() => f.evidence.drain({ segments: true }));
    expect(f.deliveries).toHaveLength(40);
    expect(g.deliveries).toHaveLength(40);
    expect(synchronous).toBeGreaterThan(whole / 2); // the plain flush held the thread for the whole pass
    expect(sliced).toBeLessThan(250); // one segment (3 walks, ~30 ms) a slice, with room for a slow machine
    expect(sliced).toBeLessThan(synchronous / 3);
  }, 60_000);
});

describe('a commit and the rows it did not write', () => {
  it('delivers its own outcome without a walk for the other unseen rows, which the drain delivers once they can be shown', async () => {
    quiet();
    const f = segments({ tasks: 1, rows: 0, hiddenId: 'hide' });
    const unseen = Array.from({ length: 8 }, (_, index) => f.undelivered(`unseen-${index}`, ['hide']));
    const own = f.undelivered('own-step', ['shown']);
    f.evidence.committed({ id: 'own-step' } as TaskStep);
    expect(f.calls.visible).toBe(1); // its own row only: no walk for the eight unseen ones
    expect(f.deliveries.map(item => item.outcomeId)).toEqual([own]);
    f.state.hidden = undefined;
    await nextTurn(); // the commit's drain, on a later turn: it delivers the others
    await f.evidence.drain({ segments: false });
    expect(f.deliveries.map(item => item.outcomeId).sort()).toEqual([own, ...unseen].sort());
    expect(f.deliveries).toHaveLength(9);
  });

  it('does not ask an unseen row again at every tick, and a flush still does', async () => {
    quiet();
    const f = segments({ tasks: 1, rows: 0, hiddenId: 'hide' });
    f.undelivered('unseen-a', ['hide']);
    await f.evidence.drain({ segments: false });
    const asked = f.calls.visible;
    await f.evidence.drain({ segments: false });
    expect(f.calls.visible).toBe(asked);
    f.evidence.flush();
    expect(f.calls.visible).toBeGreaterThan(asked);
  });

  it('delivers a row changed between the pass\'s selection and its delivery with its latest content', async () => {
    quiet();
    const f = segments({ tasks: 1, rows: 0, walkMilliseconds: 25 });
    f.undelivered('first', ['a']);
    const second = f.undelivered('second', ['b'], '{"before":true}');
    // The first row's walk outlasts a slice, so the loop turns before the second is reached: a settle changes it meanwhile.
    setImmediate(() => { f.h.db.prepare('UPDATE fca_action_evidence SET result_json=? WHERE event_id=?').run(JSON.stringify({ ok: true, text: '{"after":true}' }), second); });
    await f.evidence.drain({ segments: false });
    expect(f.deliveries).toHaveLength(2);
    expect(f.deliveries.find(item => item.outcomeId === second)!.result).toEqual({ ok: true, text: '{"after":true}' });
  });
});

describe('the sliced pass\'s parts', () => {
  it('runSliced lets the loop through only after a slice has lasted, and never cuts a unit', async () => {
    let ran = 0;
    function* units(): Generator<void> { for (let index = 0; index < 8; index++) { spin(6); ran += 1; yield; } }
    const measure = await runSliced(units(), 20);
    expect(ran).toBe(8);
    expect(measure.yields).toBeGreaterThanOrEqual(1);
    expect(measure.yields).toBeLessThanOrEqual(3);
    expect((await runSliced(units(), 10_000)).yields).toBe(0);
  });

  it('the unseen backoff skips a key until its time has passed, and forgets one that was shown', () => {
    let now = 0;
    const backoff = new FcaUnseenBackoff(() => now, 1_000);
    expect(backoff.skips('a')).toBe(false);
    backoff.unseen('a');
    now = 999;
    expect(backoff.skips('a')).toBe(true);
    now = 1_000;
    expect(backoff.skips('a')).toBe(false);
    backoff.unseen('b');
    backoff.shown('b');
    expect(backoff.skips('b')).toBe(false);
  });
});
