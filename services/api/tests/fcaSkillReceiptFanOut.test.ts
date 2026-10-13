import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryWorld } from './support/memoryWorld.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import type { TaskRuntime, TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SkillMemory } from '../src/mind/memory/memoryPorts.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';

/**
 * Production on 2026-10-13, after 2d3820fe: a report's visibility walk took 160–1,300 ms. A research task recalled 50–80 of her task
 * experiences, each carrying the read receipts of the 16 skill revisions it read; the walk asked the skill reader once per memory and
 * receipt (1,280 times, 0.7 s) and read the companion state about three times for each. The shape here is that fan-out.
 */
const FAN_OUT = Object.freeze({ memories: 80, skills: 16 });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });

function fanOut() {
  const world = memoryWorld();
  cleanups.push(() => world.close());
  const turns: string[] = [];
  for (let index = 0; index < 40; index++) {
    world.advance(60_000);
    turns.push(world.store.appendTurn('owner', 'thread', `質問${index}${'あ'.repeat(80)}`, `返答${index}${'い'.repeat(80)}`, world.now()).id);
  }
  // One forgotten turn, so that the withholding rules are active (as in production).
  new ShannonMemoryService(world.store, world.store, world.now).mutate('owner', { memoryId: turns.at(-1)!, action: 'forget' });
  const skillDb = new DatabaseSync(':memory:');
  cleanups.unshift(() => skillDb.close());
  const memory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < FAN_OUT.skills; index++) {
    const added = memory.create('owner', { draft: { name: `skill-${index}`, description: `手順${index}`, steps: `手順${index}の本文${'う'.repeat(200)}`,
      aids: '- 確認', references: '- 元資料' }, evidence: [] }, { carries: () => false }, world.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(memory, scope => world.store.snapshot(scope), world.store);
  const receipts = skills.indexSources!('owner');
  expect(receipts).toHaveLength(FAN_OUT.skills);
  const experiences = world.store.taskExperiences();
  for (let index = 0; index < FAN_OUT.memories; index++) {
    world.advance(60_000);
    experiences.write('owner', { scopeKey: 'owner', taskId: `task-${index}`, outcomeId: 'done', observedAt: world.now(), status: 'success',
      goal: `調べもの${index}`, context: '', action: '', prediction: '', observedResult: '', interpretation: '', sourceIds: [turns[index % 30]!],
      readSourceIds: receipts });
  }
  const ids = (world.store.experienceCandidates('owner') as ReadonlyArray<{ id: string }>).map(item => item.id).filter(id => id.startsWith('task:'));
  expect(ids).toHaveLength(FAN_OUT.memories);
  const counts = { skillReads: 0 };
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state: world.store, conversations: world.store,
    skill: (scope, id, revision) => { counts.skillReads += 1; return skills.readSource!(scope, id, revision); } });
  world.store.readSourceVisible = readSourceVisible;
  const guard = createFcaSourceGuard({ runtime: {} as TaskRuntime, state: world.store, conversations: world.store, ownerScope: 'owner',
    ownerAlone: () => true, readSourceVisible });
  const task = { id: 'research-1', scopeKey: 'owner', kind: 'research', origin: 'owner_request', title: '調べもの', goal: '公開情報を調べる',
    completionCriteria: '', summary: '' } as TaskView;
  const sources: TaskSource[] = [{ kind: 'memory', stepId: 'step-1', experienceId: null, threadId: null, observedAt: world.now(), recalledMemoryIds: ids }];
  return { world, memory, skills, receipts, ids, counts, guard, task, sources };
}

describe('the visibility walk of a report whose memories read many skills (2026-10-13)', () => {
  it('asks the skill reader once per skill revision for all the memories that read it, and reads the state a few times', () => {
    const f = fanOut();
    const snapshots = vi.spyOn(f.world.store, 'snapshot');
    const started = performance.now();
    expect(f.guard.sources('owner', f.task, f.sources)).toBe(true);
    const spent = performance.now() - started;
    console.info(`fan-out walk: ${spent.toFixed(1)} ms, skill reads ${f.counts.skillReads}, state reads ${snapshots.mock.calls.length}`);
    // Before: 1,280 skill reads (80 memories x 16 receipts) and about three state reads for each.
    expect(f.counts.skillReads).toBe(FAN_OUT.skills);
    expect(snapshots.mock.calls.length).toBeLessThanOrEqual(2 * FAN_OUT.skills + 8);
  });

  it('still sees a skill retired or forgotten since: the next walk asks again, and one such receipt hides the work', () => {
    const retired = fanOut();
    expect(retired.guard.sources('owner', retired.task, retired.sources)).toBe(true);
    const skillId = decodeURIComponent(/^shannon-skill:\/\/([^/]+)\//u.exec(retired.receipts[5]!)![1]!);
    expect(retired.memory.retire('owner', skillId, 'owner_request', retired.world.now())).toBe(true);
    expect(retired.guard.sources('owner', retired.task, retired.sources)).toBe(false); // In the same job, within the verdict's window.
    const f = fanOut();
    expect(f.guard.sources('owner', f.task, f.sources)).toBe(true);
    // A forget is a new state version: the verdict and every skill answer are made afresh.
    f.world.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: f.receipts[3]!, kind: 'experience', status: 'forgotten',
      pinned: false, updatedAt: f.world.now(), changeReason: 'owner' } });
    f.counts.skillReads = 0;
    expect(f.guard.sources('owner', f.task, f.sources)).toBe(false);
    expect(f.counts.skillReads).toBeLessThanOrEqual(FAN_OUT.skills);
  });
});
