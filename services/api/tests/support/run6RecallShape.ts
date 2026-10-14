import { DatabaseSync } from 'node:sqlite';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './memoryWorld.js';
import { createFcaReadSources } from '../../src/wiring/fcaReadSources.js';
import { SkillMemory } from '../../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { ShannonMemoryService } from '../../src/mind/memory/memoryService.js';
import { createTaskMemory, taskExperienceId } from '../../src/mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../../src/mind/recall/taskRecallPorts.js';

/**
 * The owner scope of production on 2026-10-14 14:00 (read-only queries on the VM, counts only): 1,067 remembered turns, of which
 * 59 are task experiences (`task:`), each recalling ~52 memories (14 of them other task experiences) and carrying ~16 skill read
 * receipts over 16 skills (944 receipts); 91 further turns recall ~9 memories each; one forgotten experience and one active
 * control. On that shape the `visible` step of the deterministic context took 3.6–4.0 s per turn and per FCA step.
 */
export const RUN6_SHAPE = Object.freeze({ turns: 1008, recallingTurns: 91, recalledPerTurn: 9, tasks: 59, recalledPerTask: 52,
  taskRecallsOfTasks: 14, readsPerTask: 16, skills: 16 });
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };

export function run6RecallShape(shape: Partial<Record<keyof typeof RUN6_SHAPE, number>> = {}) {
  const size = { ...RUN6_SHAPE, ...shape };
  const world = memoryWorld();
  const turns: string[] = [];
  for (let index = 0; index < size.turns; index++) {
    world.advance(30_000);
    const recalling = index >= size.turns - size.recallingTurns * 3 && index % 3 === 0 && turns.length > 20;
    const recalled = recalling ? Array.from({ length: size.recalledPerTurn }, (_, k) => turns[(index * 7 + k * 13) % turns.length]!) : [];
    turns.push(world.store.appendTurn('owner', `thread-${index % 5}`, `質問${index}について${String.fromCharCode(0x4e00 + index)}${'あ'.repeat(80)}`,
      `返答${index}${String.fromCharCode(0x5000 + index)}${'い'.repeat(120)}`, world.now(),
      { capturedStateVersion: 0, messageEmotion: emotion, ...(recalled.length ? { recalledMemoryIds: recalled } : {}) }).id);
  }
  const memoryService = new ShannonMemoryService(world.store, world.store, world.now);
  memoryService.mutate('owner', { memoryId: turns.at(-1)!, action: 'forget' });
  const skillDb = new DatabaseSync(':memory:');
  const skillMemory = new SkillMemory({ database: skillDb, createsSchema: true, defer: work => work() });
  for (let index = 0; index < size.skills; index++) {
    const added = skillMemory.create('owner', { draft: { name: `skill-${index}`, description: `手順${index}`, steps: `手順${index}の本文${'う'.repeat(600)}`,
      aids: '- 確認', references: '- 元資料' }, evidence: [] }, { carries: () => false }, world.now());
    if ('rejected' in added) throw new Error(added.rejected);
  }
  const skills = skillTurnPorts(skillMemory, scope => world.store.snapshot(scope), world.store);
  const skillSources = skills.indexSources!('owner');
  let alone = true;
  const ownerAlone = () => alone;
  const readSourceVisible = createFcaReadSources({ ownerScope: 'owner', ownerAlone, state: world.store, conversations: world.store,
    skill: (scope, id, revision) => skills.readSource!(scope, id, revision) });
  world.store.readSourceVisible = readSourceVisible;
  const writer = world.store.taskExperiences();
  const tasks: string[] = [];
  for (let index = 0; index < size.tasks; index++) {
    world.advance(60_000);
    const ofTasks = tasks.length ? Array.from({ length: Math.min(size.taskRecallsOfTasks, tasks.length) }, (_, k) => tasks[(index * 5 + k * 3) % tasks.length]!) : [];
    const ofTurns = Array.from({ length: size.recalledPerTask - ofTasks.length }, (_, k) => turns[(index * 31 + k * 17 + 40) % turns.length]!);
    const reads = Array.from({ length: size.readsPerTask }, (_, k) => skillSources[(index + k) % skillSources.length]!);
    const record = { scopeKey: 'owner', taskId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, outcomeId: `outcome-${index}`,
      observedAt: world.now(), status: 'success' as const, goal: `調べもの${index}`, context: '公開情報', action: 'skill.read',
      prediction: '見つかる', observedResult: `結果${index}`, interpretation: '進んだ', sourceIds: [...new Set([...ofTasks, ...ofTurns])], readSourceIds: reads };
    if (!writer.write('owner', record)) throw new Error('task experience not written');
    tasks.push(taskExperienceId('owner', record.taskId, record.outcomeId));
  }
  const memory = createTaskMemory({ state: world.store, conversations: world.store, ownerScope: 'owner', ownerAlone, now: world.now, readSourceVisible });
  const recall = createTaskRecall({ state: world.store, conversations: world.store, memory, enrich: null, now: world.now });
  return {
    world, turns, tasks, skills, skillSources, skillMemory, memoryService, readSourceVisible, memory, recall, size, present: OWNER_AUDIENCE, ownerAlone,
    setAlone(value: boolean) { alone = value; },
    close() { skillDb.close(); world.close(); },
  };
}

export type Run6RecallShape = ReturnType<typeof run6RecallShape>;
