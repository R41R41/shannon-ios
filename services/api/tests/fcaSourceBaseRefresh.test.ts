import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { createFcaSourceGuard, FCA_SOURCE_BASE_MS, FCA_SOURCE_BASE_REFRESH_MS } from '../src/mind/action/fca/fcaConversationSources.js';
import type { TaskRuntime, TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SkillMemory } from '../src/mind/memory/memoryPorts.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';

/**
 * mb-llmc r8 (production run 32, 2026-10-22: `source walk` mode=full, ids about 320, 300–860 ms on the API's one thread, 780 and 925 ms blocks,
 * the base of an earlier walk having run out): a check that finds its base `FCA_SOURCE_BASE_REFRESH_MS` old makes a new one in turns of the
 * loop, so that no check walks the whole provenance on the thread after the first.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
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
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  w.store.readSourceVisible = readSourceVisible;
  return { w, ids, readSourceVisible, at: w.now() };
}
const task = { id: 'body-1', scopeKey: 'owner', kind: 'generic', origin: 'owner_request', title: 'エンドラ', goal: 'エンドラを倒す', completionCriteria: '', summary: '' } as TaskView;
const rows = (ids: readonly string[], step: string, observedAt: string): TaskSource[] => [{ kind: 'memory', stepId: step, experienceId: null, threadId: null, observedAt, recalledMemoryIds: [...ids] }];

describe('the base of the source guard is made anew before it runs out (run 32)', () => {
  it('the check that finds it old renews it in turns; the checks that follow walk only what it did not check, never the whole', async () => {
    const f = world();
    let now = Date.parse(f.at);
    const lines: string[] = [];
    const guard = createFcaSourceGuard({ runtime: {} as TaskRuntime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: f.readSourceVisible, clock: () => now, log: line => lines.push(line), walkLogMilliseconds: 0 });
    const first = [...rows(f.ids.slice(0, 40), 'step-1', f.at)];
    const second = [...first, ...rows(f.ids.slice(40, 50), 'step-2', f.at)];
    const third = [...second, ...rows(f.ids.slice(50, 60), 'step-3', f.at)];
    expect(FCA_SOURCE_BASE_REFRESH_MS).toBeLessThan(FCA_SOURCE_BASE_MS);

    expect(guard.sources('owner', task, first, undefined, 'step')).toBe(true);
    expect(lines.at(-1)).toMatch(/mode=full via=step/u);
    // 16 s on: the base is usable (30 s window), so the walk is partial; it is old enough to be made anew, which goes on beside, in turns.
    now += FCA_SOURCE_BASE_REFRESH_MS + 1_000;
    expect(guard.sources('owner', task, second, undefined, 'step')).toBe(true);
    expect(lines.at(-1)).toMatch(/mode=partial via=step/u);
    await sleep(100);
    const renewed = lines.filter(line => line.includes('via=refresh'));
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatch(/mode=full via=refresh held=\d+ turns=\d+$/u);
    // 15 s on again, 31 s from the first walk: without the renewal the base would have run out (30 s) and this check walked all 60 memories at once.
    now += FCA_SOURCE_BASE_REFRESH_MS;
    expect(guard.sources('owner', task, third, undefined, 'step')).toBe(true);
    expect(lines.filter(line => line.includes('via=step')).at(-1)).toMatch(/mode=partial via=step/u);
    expect(lines.filter(line => /mode=full via=step/u.test(line))).toHaveLength(1);
  });

  it('a forget before the renewal walks: it is a new state version, nothing of the renewal is kept, and the check that follows sees the forget', async () => {
    const f = world();
    let now = Date.parse(f.at);
    const lines: string[] = [];
    const guard = createFcaSourceGuard({ runtime: {} as TaskRuntime, state: f.w.store, conversations: f.w.store, ownerScope: 'owner', ownerAlone: () => true,
      readSourceVisible: f.readSourceVisible, clock: () => now, log: line => lines.push(line), walkLogMilliseconds: 0 });
    const first = rows(f.ids.slice(0, 40), 'step-1', f.at);
    expect(guard.sources('owner', task, first, undefined, 'step')).toBe(true);
    now += FCA_SOURCE_BASE_REFRESH_MS + 1_000;
    const second = [...first, ...rows(f.ids.slice(40, 50), 'step-2', f.at)];
    expect(guard.sources('owner', task, second, undefined, 'step')).toBe(true);
    // A forget lands before the renewal (it goes on after this check) walks.
    f.w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.ids[3]!, kind: 'experience', status: 'forgotten', pinned: false,
      updatedAt: f.w.now(), changeReason: 'owner' } });
    await sleep(100);
    expect(guard.sources('owner', task, second, undefined, 'step')).toBe(false);
  });
});
