import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TaskSource, TaskStep, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore, type FcaEvidenceOptions } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { isProvenanceReference, readStoredSources, storedSourcesJson } from '../src/infra/sqlite/fcaProvenanceSets.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { run6RecallShape, type Run6RecallShape } from './support/run6RecallShape.js';

/**
 * Owner decision 2026-10-15 (「推奨の形で進める」, `SHANNON_FCA_PROVENANCE_REFS`): a Minecraft task inherits only the asking
 * conversation, and a step record stores its sources by reference (`fcaProvenanceSets.ts`), not a copy. Reading through the
 * reference applies the same checks at read time: what was forgotten or corrected after the record was written, and who can see
 * or hear now (another person present, a stream: `ownerAlone` false), hide it exactly as they hide a copy.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) close(); });
const quiet = () => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };

function world(): Run6RecallShape {
  const f = run6RecallShape({ turns: 240, recallingTurns: 6, tasks: 4, recalledPerTask: 8, taskRecallsOfTasks: 2, readsPerTask: 2, skills: 2 });
  cleanups.push(() => f.close());
  return f;
}

/** The real source guard, runtime and evidence store, wired as `fcaSharedWiring.ts` wires them, with the switch as given. */
function wired(f: Run6RecallShape, provenanceRefs: boolean, path = ':memory:') {
  const h = actionHarness(f.world.now, path); migrateAgentTasks(h.db); cleanups.push(() => h.close());
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now,
    canRunTask: () => false, provenanceRefs,
    model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ role: 'user', results }) } });
  cleanups.push(() => driver.close());
  const runtime = driver.runtime;
  const visible = createFcaSourceGuard({ runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
    ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => Date.parse(f.world.now()) });
  const sourcesVisible = (scope: string, id: string, sources: readonly TaskSource[]) => {
    const view = runtime.get(scope, id);
    return Boolean(view && visible.sources(scope, view, sources));
  };
  // Every task is visible here and the parent's step has no sources: what a row shows is decided by its own stored sources alone.
  const options: FcaEvidenceOptions = { db: h.db, state: f.world.store, now: f.world.now, validStep: () => true, sourcesVisible,
    taskVisible: () => true, observeContext: () => true, provenanceRefs };
  return { h, runtime, visible, options, evidence: new SQLiteFcaEvidenceStore(options), root: runtime.ensureRoot('owner') };
}
type Wired = ReturnType<typeof wired>;

async function stepOf(w: Wired, task: TaskView): Promise<TaskStep> {
  const action = await w.h.actions.claim((await w.h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
    sourceId: `fca:${task.id}:${task.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
  const step = w.runtime.beginStep('owner', task.id, leaseOf(action!));
  if (!step) throw new Error('step not begun');
  return step;
}
/** One step of `task` that recalls `ids` and records one observed body action; the row's event id. */
async function recordAction(w: Wired, task: TaskView, ids: readonly string[], call = 'c1'): Promise<{ eventId: string; step: TaskStep }> {
  const step = await stepOf(w, task);
  expect(w.runtime.observeSources(step, { observationId: `recall-${call}`, recalledMemoryIds: ids })).toBe(true);
  step.snapshot.sources = w.runtime.taskSources('owner', task.id, step.messageIds);
  const tool = { id: call, name: 'mc.observe', input: {} };
  const output = { decision: { kind: 'tools', calls: [tool] }, history: [] } as unknown as FcaModelOutput;
  expect(w.evidence.beforeActions(step, output)).toBe(true);
  w.evidence.observed(step, tool, { ok: true, text: `observed ${call}`, retryable: false });
  // Free the background slot for the next task's step (the row is recorded; the store's step check is stubbed here).
  await w.h.actions.finish(step.lease, 'completed', 'test_recorded');
  return { eventId: `${step.id}:${call}`, step };
}
const row = (w: Wired, eventId: string) => w.h.db.prepare('SELECT sources_json FROM fca_action_evidence WHERE event_id=?').get(eventId) as { sources_json: string };
/** What the parent's next decision is shown of its children's outcomes. */
async function shown(w: Wired, parent: TaskView): Promise<string[]> {
  const fresh = w.runtime.get('owner', parent.id)!;
  const step = { id: 'parent-step', scopeKey: 'owner', taskId: parent.id, lease: {} as TaskStep['lease'], revision: 1, messageIds: [],
    snapshot: { task: fresh, messages: [], sources: [], history: [], checkpoint: null, revision: 1 } } satisfies TaskStep;
  return (await w.evidence.prepare(step)).recentOutcomes.map(item => item.eventId);
}

describe('a Minecraft task inherits only the asking conversation', () => {
  it('takes nothing of the root\'s accumulated sources, only its own in-game turn; off restores the whole set', () => {
    const f = world();
    for (const on of [true, false]) {
      const w = wired(f, on), pool = f.turns.slice(10, 200);
      // An earlier task reported to the root, which keeps every source a report brought (Minecraft runs 7–11: ~600 entries).
      const earlier = w.runtime.createChild('owner', w.root.id, { title: '前の作業', goal: '前の作業', completionCriteria: '確かめる' }, `earlier-${on}`);
      w.h.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,state,source_kind) VALUES(?,?,'',?,?,'bound','memory')")
        .run(`memory:earlier-${on}`, 'owner', f.world.now(), JSON.stringify(pool.slice(0, 40)));
      w.h.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(earlier.id, `memory:earlier-${on}`);
      w.runtime.send('owner', earlier.id, w.root.id, '前の作業: completed', `report-${on}`);
      expect(w.runtime.taskSources('owner', w.root.id).map(source => source.stepId)).toContain(`memory:earlier-${on}`);

      const body = w.runtime.createChild('owner', w.root.id, { title: '木', goal: '木を切る', completionCriteria: '確かめる', context: '道具で実行する' },
        `mc-${on}`, { sources: 'asking' });
      const asking = pool[100]!;
      w.runtime.observeExternal('owner', body.id, { eventId: `mc-${on}`, experienceIds: [asking], observedAt: f.world.now(), text: 'ゲーム内の本人の依頼: 木を切る' });
      const sources = w.runtime.taskSources('owner', body.id);
      if (on) expect(sources.map(source => source.recalledMemoryIds)).toEqual([[asking]]);
      else expect(sources.map(source => source.stepId)).toContain(`memory:earlier-${on}`);
      // A task asked for without the option still inherits the parent's whole set.
      const plain = w.runtime.createChild('owner', w.root.id, { title: '別', goal: '別の作業', completionCriteria: '確かめる' }, `plain-${on}`);
      expect(w.runtime.taskSources('owner', plain.id).map(source => source.stepId)).toContain(`memory:earlier-${on}`);
    }
  });

  it('keeps every source the task reads afterwards, and a conversation parent\'s own sources', async () => {
    const f = world(), w = wired(f, true), pool = f.turns.slice(10, 200);
    const body = w.runtime.createChild('owner', w.root.id, { title: '木', goal: '木を切る', completionCriteria: '確かめる' }, 'mc-read', { sources: 'asking' });
    expect(w.runtime.taskSources('owner', body.id)).toEqual([]);
    const { step } = await recordAction(w, body, pool.slice(0, 3));
    expect(w.runtime.taskSources('owner', body.id, step.messageIds).flatMap(source => source.recalledMemoryIds)).toEqual([...pool.slice(0, 3)].sort());
  });
});

describe('a step record keeps its sources by reference', () => {
  it('stores a set id instead of the copy, reads back the very list, and keeps an old copy readable', async () => {
    quiet();
    const f = world(), w = wired(f, true), pool = f.turns.slice(10, 200);
    const parent = w.runtime.createChild('owner', w.root.id, { title: '親', goal: '親の作業', completionCriteria: '確かめる' }, 'parent');
    const child = w.runtime.createChild('owner', parent.id, { title: '木', goal: '木を切る', completionCriteria: '確かめる' }, 'child');
    const { eventId, step } = await recordAction(w, child, pool.slice(0, 30));
    const stored = row(w, eventId).sources_json;
    expect(isProvenanceReference(stored)).toBe(true);
    expect(readStoredSources(w.h.db, 'owner', stored)).toEqual(step.snapshot.sources);
    expect(stored.length).toBeLessThan(JSON.stringify(step.snapshot.sources).length);
    // Another scope cannot read it; an unknown set is not visible and throws nowhere.
    expect(readStoredSources(w.h.db, 'other', stored)).toBeNull();
    w.h.db.prepare('UPDATE fca_action_evidence SET sources_json=? WHERE event_id=?').run(JSON.stringify({ set: `sha256:${'0'.repeat(64)}` }), eventId);
    // The prepare's outcome line counts it (`unresolved=`: the post-deploy watch item; absent when 0).
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await shown(w, parent)).toEqual([]);
    expect(info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('Shannon FCA evidence prepare ')).at(-1)).toMatch(/ unresolved=1$/u);
    // A row written before the change (its copy) is read as before.
    w.h.db.prepare('UPDATE fca_action_evidence SET sources_json=? WHERE event_id=?').run(JSON.stringify(step.snapshot.sources), eventId);
    expect(await shown(w, parent)).toEqual([eventId]);
  });

  it('writes the copy when a source is a turn still in progress, and when the switch is off', () => {
    const f = world(), w = wired(f, true);
    const pending: TaskSource = { stepId: 'turn-pending', threadId: 'thread-0', experienceId: null, observedAt: f.world.now(), recalledMemoryIds: [] };
    w.h.db.prepare('INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at) VALUES(?,?,?,?)').run('turn-pending', 'owner', 'thread-0', f.world.now());
    expect(storedSourcesJson(w.h.db, 'owner', [pending], true)).toBe(JSON.stringify([pending]));
    w.h.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,state,source_kind) VALUES(?,?,'',?,?,'bound','memory')")
      .run('memory:fixed', 'owner', f.world.now(), JSON.stringify(['a']));
    const memory: TaskSource = { kind: 'memory', threadId: null, experienceId: null, stepId: 'memory:fixed', observedAt: f.world.now(), recalledMemoryIds: ['a'] };
    expect(isProvenanceReference(storedSourcesJson(w.h.db, 'owner', [memory], true))).toBe(true);
    expect(storedSourcesJson(w.h.db, 'owner', [memory], false)).toBe(JSON.stringify([memory]));
    // A list that differs from its rows (a stale snapshot) is copied, never referenced.
    expect(storedSourcesJson(w.h.db, 'owner', [{ ...memory, recalledMemoryIds: ['b'] }], true)).toBe(JSON.stringify([{ ...memory, recalledMemoryIds: ['b'] }]));
  });

  it('stores a committed history round by reference and reads it back in the window', async () => {
    const f = world(), w = wired(f, true), pool = f.turns.slice(10, 200);
    const task = w.runtime.createChild('owner', w.root.id, { title: '木', goal: '木を切る', completionCriteria: '確かめる' }, 'history');
    const step = await stepOf(w, task);
    expect(w.runtime.observeSources(step, { observationId: 'recall', recalledMemoryIds: pool.slice(0, 5) })).toBe(true);
    step.snapshot.sources = w.runtime.taskSources('owner', task.id, step.messageIds);
    expect(w.runtime.commitStep(step, { history: [{ role: 'assistant', content: 'x' }], disposition: 'continue' })).not.toBeNull();
    const stored = w.h.db.prepare('SELECT sources_json FROM fca_task_history WHERE step_id=?').get(step.id) as { sources_json: string };
    expect(isProvenanceReference(stored.sources_json)).toBe(true);
    expect(w.runtime.history('owner', task.id)!.rounds[0]!.sources).toEqual(step.snapshot.sources);
  });
});

describe('reading through the reference applies the checks of today (forgetting, correction, who is present)', () => {
  async function recorded(on: boolean) {
    quiet();
    const f = world(), w = wired(f, on), pool = f.turns.slice(10, 200);
    const parent = w.runtime.createChild('owner', w.root.id, { title: '親', goal: '親の作業', completionCriteria: '確かめる' }, `parent-${on}`);
    const forgotten = w.runtime.createChild('owner', parent.id, { title: '一', goal: '一つ目', completionCriteria: '確かめる' }, `a-${on}`);
    const corrected = w.runtime.createChild('owner', parent.id, { title: '二', goal: '二つ目', completionCriteria: '確かめる' }, `b-${on}`);
    const kept = w.runtime.createChild('owner', parent.id, { title: '三', goal: '三つ目', completionCriteria: '確かめる' }, `c-${on}`);
    const victim = f.turns.at(-3)!, fixed = f.turns.at(-2)!; // recent turns, as the owner picks them from his memory list
    const a = await recordAction(w, forgotten, [victim, ...pool.slice(0, 5)], 'a');
    const b = await recordAction(w, corrected, [fixed, ...pool.slice(5, 10)], 'b');
    const c = await recordAction(w, kept, pool.slice(10, 15), 'c');
    /** Each row's verdict as the guard gives it now over its stored sources (a reference read now, or its copy). */
    const verdicts = () => [a.eventId, b.eventId, c.eventId].map(eventId => {
      const stored = w.h.db.prepare('SELECT task_id,sources_json FROM fca_action_evidence WHERE event_id=?').get(eventId) as { task_id: string; sources_json: string };
      const resolved = readStoredSources(w.h.db, 'owner', stored.sources_json)!;
      return [w.options.sourcesVisible('owner', stored.task_id, resolved),
        w.options.sourcesVisible('owner', stored.task_id, JSON.parse(JSON.stringify(resolved)) as TaskSource[])];
    });
    return { f, w, parent, victim, fixed, verdicts, ids: { a: a.eventId, b: b.eventId, c: c.eventId } };
  }

  it.each([[true], [false]])('by reference %s: a source forgotten after the record was written hides it; others present hide all; correction hides its row', async on => {
    const { f, w, parent, victim, fixed, ids, verdicts } = await recorded(on);
    expect(isProvenanceReference(row(w, ids.a).sources_json)).toBe(on);
    expect((await shown(w, parent)).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    // The owner forgets a memory the first row's step recalled, after the row was stored.
    f.world.advance(60_000);
    f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' });
    expect((await shown(w, parent)).sort()).toEqual([ids.b, ids.c].sort());
    // He corrects a memory the second row's step recalled: what was observed before the correction is withheld.
    f.world.advance(60_000);
    f.memoryService.mutate('owner', { memoryId: fixed, action: 'correct', text: '訂正された内容' });
    expect(await shown(w, parent)).toEqual([ids.c]);
    // Someone else is present (a person in the room, or a stream): no row's stored sources are visible and the decision is held;
    // when he is alone again the remaining row comes back.
    f.setAlone(false);
    expect(verdicts()).toEqual([[false, false], [false, false], [false, false]]);
    await expect(shown(w, parent)).rejects.toThrow('FCA_EVIDENCE_HELD');
    f.setAlone(true);
    expect(await shown(w, parent)).toEqual([ids.c]);
  });

  it('gives a stored reference the same verdict as its copy under every control', async () => {
    const { f, victim, fixed, verdicts } = await recorded(true);
    expect(verdicts()).toEqual([[true, true], [true, true], [true, true]]);
    f.world.advance(60_000);
    f.memoryService.mutate('owner', { memoryId: victim, action: 'forget' });
    expect(verdicts()).toEqual([[false, false], [true, true], [true, true]]);
    f.world.advance(60_000);
    f.memoryService.mutate('owner', { memoryId: fixed, action: 'correct', text: '訂正された内容' });
    expect(verdicts()).toEqual([[false, false], [false, false], [true, true]]);
    f.setAlone(false);
    expect(verdicts()).toEqual([[false, false], [false, false], [false, false]]);
  });
});

describe('scripts/fca-provenance-expand.ts: the rollback aid turns every reference back into its copy', () => {
  const script = resolve(import.meta.dirname, '../../../scripts/fca-provenance-expand.ts');
  const run = (path: string, ...flag: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, path, ...flag], { encoding: 'utf8' });
  type Stored = { table: string; rowid: number; sources_json: string };
  /** Evidence rows of two tasks and a committed history round, all by reference, in a database file; each row's list as read now. */
  async function database() {
    quiet();
    const directory = mkdtempSync(join(tmpdir(), 'fca-expand-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'tasks.sqlite'), f = world(), w = wired(f, true, path), pool = f.turns.slice(10, 200);
    const parent = w.runtime.createChild('owner', w.root.id, { title: '親', goal: '親の作業', completionCriteria: '確かめる' }, 'parent');
    const a = w.runtime.createChild('owner', parent.id, { title: '一', goal: '一つ目', completionCriteria: '確かめる' }, 'a');
    const b = w.runtime.createChild('owner', parent.id, { title: '二', goal: '二つ目', completionCriteria: '確かめる' }, 'b');
    const c = w.runtime.createChild('owner', parent.id, { title: '三', goal: '三つ目', completionCriteria: '確かめる' }, 'c');
    await recordAction(w, a, pool.slice(0, 6), 'a');
    await recordAction(w, b, pool.slice(6, 12), 'b');
    const step = await stepOf(w, c);
    expect(w.runtime.observeSources(step, { observationId: 'recall-h', recalledMemoryIds: pool.slice(12, 16) })).toBe(true);
    step.snapshot.sources = w.runtime.taskSources('owner', c.id, step.messageIds);
    expect(w.runtime.commitStep(step, { history: [{ role: 'assistant', content: 'x' }], disposition: 'continue' })).not.toBeNull();
    w.h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const rows = (): Stored[] => [
      ...w.h.db.prepare('SELECT rowid AS rowid, sources_json FROM fca_action_evidence ORDER BY rowid').all().map(row => ({ table: 'fca_action_evidence', rowid: Number(row.rowid), sources_json: String(row.sources_json) })),
      ...w.h.db.prepare('SELECT rowid AS rowid, sources_json FROM fca_task_history ORDER BY rowid').all().map(row => ({ table: 'fca_task_history', rowid: Number(row.rowid), sources_json: String(row.sources_json) })),
    ];
    const before = rows();
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(before.every(row => isProvenanceReference(row.sources_json))).toBe(true);
    // What each row's list is now, as the build reads it (a reference resolved): the copy the script must write.
    const lists = before.map(row => JSON.stringify(readStoredSources(w.h.db, 'owner', row.sources_json)));
    return { w, path, rows, before, lists, step };
  }

  it('dry run writes nothing; --apply writes exactly the lists the references read as; a second --apply changes nothing', async () => {
    const { w, path, rows, before, lists, step } = await database();
    const dry = run(path);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`fca_action_evidence: references=${before.filter(row => row.table === 'fca_action_evidence').length}`);
    expect(dry.stdout).toContain('unresolved=0');
    expect(dry.stdout).toContain('malformed=0');
    expect(rows()).toEqual(before);
    const applied = run(path, '--apply');
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain(`expanded=${before.length}`);
    expect(applied.stdout).toContain('integrity=ok');
    const after = rows();
    expect(after.map(row => row.sources_json)).toEqual(lists);
    expect(after.some(row => isProvenanceReference(row.sources_json))).toBe(false);
    // The history round holds the very list its step committed with.
    expect(JSON.parse(after.find(row => row.table === 'fca_task_history')!.sources_json)).toEqual(step.snapshot.sources);
    // An older build parses them as lists of sources; this build still reads a copy as written.
    for (const row of after) expect(readStoredSources(w.h.db, 'owner', row.sources_json)).toEqual(JSON.parse(row.sources_json));
    const again = run(path, '--apply');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('expanded=0');
    expect(rows()).toEqual(after);
  });

  it.each([
    ['an unresolved reference', JSON.stringify({ set: `sha256:${'0'.repeat(64)}` }), 'unresolved=1', 'malformed=0'],
    ['a reference this build cannot read', '{"set":"not-a-set-id"}', 'unresolved=0', 'malformed=1'],
  ])('refuses --apply and writes nothing for %s (and the dry run reports it)', async (_label, bad, unresolved, malformed) => {
    const { path, rows, before } = await database();
    const target = before[0]!;
    const w = new (await import('node:sqlite')).DatabaseSync(path);
    w.prepare(`UPDATE ${target.table} SET sources_json=? WHERE rowid=?`).run(bad, target.rowid);
    w.close();
    const expected = rows().map(row => row.sources_json);
    expect(expected[0]).toBe(bad);
    const dry = run(path);
    expect(dry.stdout).toContain(unresolved);
    expect(dry.stdout).toContain(malformed);
    const refused = run(path, '--apply');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('FCA_PROVENANCE_EXPAND_REFUSED');
    expect(rows().map(row => row.sources_json)).toEqual(expected);
  });
});
