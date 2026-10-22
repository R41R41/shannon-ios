import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationSources.js';
import type { TaskRuntime, TaskSource, TaskView, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SkillMemory } from '../src/mind/memory/memoryPorts.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { isProvenanceReference, readStoredSources, storedSourcesJson } from '../src/infra/sqlite/fcaProvenanceSets.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { run6RecallShape } from './support/run6RecallShape.js';

/**
 * mb-llmc r9 (run 33: the source guard's `reads` part held the API's thread 120–507 ms at 145 checks of a 29-minute run; the commit read, parsed
 * and stringified the task's 41 memory rows (558,000 characters of ids) several times): a list of receipts found unchanged under a fingerprint of the
 * inputs every answer is made from is not asked again while the fingerprint is the same; the rows of a task are handed as read while they read the same.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.restoreAllMocks(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function world() {
  const w = memoryWorld();
  cleanups.push(() => w.close());
  const turns: string[] = [];
  for (let index = 0; index < 30; index++) {
    w.advance(60_000);
    turns.push(w.store.appendTurn('owner', 'thread', `質問${index}${'あ'.repeat(60)}`, `返答${index}${'い'.repeat(60)}`, w.now()).id);
  }
  const skillDb = new DatabaseSync(':memory:');
  cleanups.unshift(() => skillDb.close());
  const memory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < 6; index++) {
    const added = memory.create('owner', { draft: { name: `skill-${index}`, description: `手順${index}`, steps: `手順${index}の本文${'う'.repeat(200)}`, aids: '- 確認', references: '- 元資料' },
      evidence: [] }, { carries: () => false }, w.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(memory, scope => w.store.snapshot(scope), w.store);
  const receipts = skills.indexSources!('owner');
  const experiences = w.store.taskExperiences();
  for (let index = 0; index < 60; index++) {
    w.advance(60_000);
    experiences.write('owner', { scopeKey: 'owner', taskId: `task-${index}`, outcomeId: 'done', observedAt: w.now(), status: 'success', goal: `調べもの${index}`,
      context: '', action: '', prediction: '', observedResult: '', interpretation: '', sourceIds: [turns[index % 30]!], readSourceIds: receipts });
  }
  const ids = (w.store.experienceCandidates('owner') as ReadonlyArray<{ id: string }>).map(item => item.id).filter(id => id.startsWith('task:'));
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: w.store, conversations: w.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision),
    ...skills.readSourceChecks ? { skillChecks: (scope: string, renew: boolean) => skills.readSourceChecks!(scope, renew) } : {} });
  w.store.readSourceVisible = readSourceVisible;
  return { w, ids, readSourceVisible, receipts, at: w.now(), skills, memory };
}
const task = { id: 'body-1', scopeKey: 'owner', kind: 'generic', origin: 'owner_request', title: 'エンドラ', goal: 'エンドラを倒す', completionCriteria: '', summary: '' } as TaskView;
const rows = (ids: readonly string[], step: string, observedAt: string): TaskSource[] => [{ kind: 'memory', stepId: step, experienceId: null, threadId: null, observedAt, recalledMemoryIds: [...ids] }];

describe('a list of receipts found unchanged is not asked again under the same fingerprint (run 33: source_walk_reads)', () => {
  function counted(fingerprint: { value: string | null }, lost: Set<string> = new Set()) {
    const f = world();
    let now = Date.parse(f.at);
    const asked: string[] = [];
    let total = 0;
    const guard = createFcaSourceGuard({ runtime: {} as TaskRuntime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: (scope, id, at, shared) => { asked.push(id); total += 1; return !lost.has(id) && f.readSourceVisible(scope, id, at, shared); },
      ...fingerprint.value === undefined ? {} : { readFingerprint: () => fingerprint.value }, clock: () => now, log: () => {} });
    const first = rows(f.ids.slice(0, 40), 'step-1', f.at);
    return { f, guard, asked, total: () => total, first, advance: (ms: number) => { now += ms; },
      next: (index: number) => [...first, ...rows(f.ids.slice(40 + index, 41 + index), `step-${index + 2}`, f.at)] };
  }

  it('asks the base\'s receipts at the first check and not again at the checks that follow, even past a verdict\'s age; another fingerprint asks them again', () => {
    const fingerprint = { value: 'F1' as string | null };
    const c = counted(fingerprint);
    expect(c.guard.sources('owner', task, c.first, undefined, 'step')).toBe(true);
    const afterFirst = c.asked.length;
    expect(afterFirst).toBeGreaterThan(0);
    c.advance(6_000); // older than a verdict (5 s): the base asks every receipt at every time, as before
    c.asked.length = 0;
    expect(c.guard.sources('owner', task, c.next(0), undefined, 'step')).toBe(true);
    const walked = c.asked.length; // the new row's receipts only
    c.asked.length = 0;
    c.advance(1_000);
    expect(c.guard.sources('owner', task, c.next(0), undefined, 'step')).toBe(true);
    expect(c.asked).toEqual([]); // a verdict reused: its receipts are not asked
    c.advance(1_000);
    expect(c.guard.sources('owner', task, c.next(1), undefined, 'step')).toBe(true);
    expect(c.asked.length).toBeLessThanOrEqual(walked);
    const sameInputs = c.total();
    // The inputs moved (a mark, a version, a connection, her skills): every receipt is asked again.
    fingerprint.value = 'F2';
    c.advance(1_000);
    c.asked.length = 0;
    expect(c.guard.sources('owner', task, c.next(2), undefined, 'step')).toBe(true);
    expect(c.asked.length).toBeGreaterThan(walked);
    // Without a fingerprint (the option's own null: a transaction, an outside family) every check asks, as before.
    const none = counted({ value: null });
    none.guard.sources('owner', task, none.first, undefined, 'step');
    none.advance(6_000);
    none.asked.length = 0;
    none.guard.sources('owner', task, none.next(0), undefined, 'step');
    none.advance(1_000);
    none.guard.sources('owner', task, none.next(1), undefined, 'step');
    expect(none.total()).toBeGreaterThan(sameInputs);
  });

  it('a receipt lost while the fingerprint moved is seen, as a whole walk sees it; the same fingerprint is the contract that nothing changed', () => {
    const fingerprint = { value: 'F1' as string | null }, lost = new Set<string>();
    const c = counted(fingerprint, lost);
    expect(c.guard.sources('owner', task, c.first, undefined, 'step')).toBe(true);
    c.advance(6_000);
    lost.add(c.f.receipts[0]!);
    fingerprint.value = 'F2'; // her skills' mark moves with a skill retired
    expect(c.guard.sources('owner', task, c.next(0), undefined, 'step')).toBe(false);
  });

  it('a check walked in turns asks in steps and finds a lost receipt too', async () => {
    const fingerprint = { value: 'F1' as string | null }, lost = new Set<string>();
    const c = counted(fingerprint, lost);
    expect(c.guard.sources('owner', task, c.first, undefined, 'step')).toBe(true);
    c.advance(6_000);
    lost.add(c.f.receipts[1]!);
    fingerprint.value = 'F2';
    const second = c.next(0);
    await c.guard.warm!('owner', task, second, undefined, 'memory');
    expect(c.guard.sources('owner', task, second, undefined, 'step')).toBe(false);
    // Nothing lost, the fingerprint moved: the walk in turns finds them all unchanged and the check that follows reuses what it found.
    lost.clear();
    fingerprint.value = 'F3';
    c.advance(1_000);
    const third = c.next(1);
    await c.guard.warm!('owner', task, third, undefined, 'memory');
    c.asked.length = 0;
    expect(c.guard.sources('owner', task, third, undefined, 'step')).toBe(true);
    expect(c.asked).toEqual([]);
  });
});

describe('the fingerprint of the read receipts\' answers (fcaReadSourceAnswers.ts)', () => {
  it('a string for skill receipts under the same inputs, another after a forget or her skills\' mark moving; null for a receipt that rests on the clock, or no skill checks', async () => {
    const f = world();
    const state = f.w.store.snapshot('owner');
    const print = f.readSourceVisible.fingerprint!;
    const first = print('owner', state, f.receipts);
    expect(first).toEqual(expect.any(String));
    expect(print('owner', state, f.receipts)).toBe(first);
    expect(print('owner', state, ['shannon-study://piece-1'])).toBeNull();
    expect(print('owner', state, [...f.receipts, 'calendar-item://promise:1'])).toBeNull();
    expect(print('owner', state, [])).toEqual(expect.any(String));
    // Without the skill checks no answer about a skill is kept, so none is told.
    const noChecks = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: f.w.store, conversations: f.w.store,
      skill: (scope, id, revision) => f.skills.readSource!(scope, id, revision) });
    expect(noChecks.fingerprint!('owner', state, f.receipts)).toBeNull();
    // A forget is a new state version: the fingerprint moves.
    f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.ids[3]!, kind: 'experience', status: 'forgotten', pinned: false,
      updatedAt: f.w.now(), changeReason: 'owner' } });
    expect(print('owner', f.w.store.snapshot('owner'), f.receipts)).not.toBe(first);
    await sleep(0);
  });
});

describe('a memory row of a task is handed as it was read while it reads the same (run 33: the commit parsed 558,000 characters of ids several times)', () => {
  it('hands the same frozen source again, a new one when the row changed; the reference stored for the list is the one a copy check gives', async () => {
    const f = run6RecallShape({ turns: 240, recallingTurns: 6, tasks: 4, recalledPerTask: 8, taskRecallsOfTasks: 2, readsPerTask: 2, skills: 2 });
    cleanups.push(() => f.close());
    const h = actionHarness(f.world.now); migrateAgentTasks(h.db); cleanups.push(() => h.close());
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now, canRunTask: () => false,
      provenanceRefs: true, model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
    cleanups.push(() => driver.close());
    const runtime = driver.runtime, root = runtime.ensureRoot('owner');
    const child = runtime.createChild('owner', root.id, { title: '作業', goal: '作業', completionCriteria: '確かめる' }, 'r9-rows');
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${child.id}:${child.revision}`, resources: [actionResource('owner', `fca:${child.id}`)] })).id);
    const step: TaskStep = runtime.beginStep('owner', child.id, leaseOf(action!))!;
    const pool = f.turns.slice(10, 200);
    for (let index = 0; index < 4; index++) expect(runtime.observeSources(step, { observationId: `recall-${index}`, recalledMemoryIds: pool.slice(index * 5, index * 5 + 20) })).toBe(true);
    const one = runtime.taskSources('owner', child.id, step.messageIds), two = runtime.taskSources('owner', child.id, step.messageIds);
    expect(one.length).toBeGreaterThanOrEqual(4);
    one.forEach((source, index) => expect(two[index]).toBe(source));
    expect(Object.isFrozen(one[0])).toBe(true);
    expect(Object.isFrozen(one[0]!.recalledMemoryIds)).toBe(true);
    // The reference: written for the kept rows, and reading it gives the very list.
    const stored = storedSourcesJson(h.db, 'owner', one, true);
    expect(isProvenanceReference(stored)).toBe(true);
    expect(JSON.stringify(readStoredSources(h.db, 'owner', stored))).toBe(JSON.stringify(one));
    // A source that is not the kept object (a copy changed in memory) is read against the row: no reference for a list that differs from its rows.
    const forged = one.map((source, index) => index === 0 ? { ...source, recalledMemoryIds: [...source.recalledMemoryIds, 'forged'] } : source);
    expect(isProvenanceReference(storedSourcesJson(h.db, 'owner', forged, true))).toBe(false);
    // A row that changed under the same step id is read anew.
    h.db.prepare('UPDATE fca_task_sources SET recalled_ids_json=? WHERE step_id=?').run(JSON.stringify(['changed']), one[0]!.stepId);
    const three = runtime.taskSources('owner', child.id, step.messageIds);
    const changed = three.find(source => source.stepId === one[0]!.stepId)!;
    expect(changed).not.toBe(one[0]);
    expect(changed.recalledMemoryIds).toEqual(['changed']);
    expect(three.filter(source => source.stepId !== one[0]!.stepId).every(source => one.includes(source))).toBe(true);
  });
});
