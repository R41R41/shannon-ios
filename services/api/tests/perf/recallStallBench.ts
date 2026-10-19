/* The task-recall stall bench (not a test): `node --import tsx tests/perf/recallStallBench.ts` from services/api. */
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from '../support/fcaDenseWorld.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';
import { SQLiteTaskExperiences } from '../../src/mind/memory/store/taskExperiences.js';
import { taskExperienceId } from '../../src/mind/memory/taskExperience.js';
import { createTaskMemory } from '../../src/mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../../src/mind/recall/taskRecallPorts.js';

/**
 * Production run 15 (2026-10-19, 08:02-08:32Z): every decision's first stretch held the thread 2.5 s at its start and 8.8 s by its
 * end, and its recall packet another 3-6 s. The remembered turns then held 226 body-task episodes; the 23 the task wrote during the
 * run each recalled 187-212 ids, 150-175 of them earlier body-task episodes (one closed pool of ~210 ids, 16,000-21,000 edges), and
 * read 27-30 skill revisions. Here: the same shape, from counts alone, and the recall of one decision timed as the pool grows.
 */
const GOAL = 'Minecraft でエンダードラゴンを討伐する。木を集めて道具を作り、夜に備え、鉄とダイヤを集める。';
const sizes = (process.env.SIZES ?? '25,50,100,175,225').split(',').map(Number);
const dense = fcaDenseWorld({ episodes: Number(process.env.OTHER_EPISODES ?? 50) });
const store = dense.world.store, writer = new SQLiteTaskExperiences(store.fcaDatabase());
const others = dense.ordinary.slice(100, 137);
const episodes: string[] = [];
const write = () => {
  const index = episodes.length;
  dense.world.advance(60_000);
  const record = { scopeKey: 'owner', taskId: `body-task-${Math.floor(index / 8)}`, outcomeId: `segment-${index}`, observedAt: dense.world.now(), status: 'success' as const,
    goal: GOAL, context: `文脈${index}`, action: `行動${index}`, prediction: `予想${index}`, observedResult: `観測${index}`, interpretation: `解釈${index}`,
    sourceIds: [...others, ...episodes.slice(-175)], readSourceIds: dense.skillSources.slice(0, 25 + (index % 6)) };
  writer.write('owner', record);
  episodes.push(taskExperienceId('owner', record.taskId, record.outcomeId));
};
const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => dense.world.now(),
  readSourceVisible: dense.readSourceVisible });
const recall = createTaskRecall({ state: store, conversations: store, memory, enrich: null, now: () => dense.world.now() });
let version = 0;
const once = async () => {
  const input = { scopeKey: 'owner', taskId: 'task-1', contextVersion: `v${++version}`, cue: `${GOAL}\n木を集めた。`, present: OWNER_AUDIENCE, semantic: false };
  // A decision changes the database before its recall (its commit), so the read snapshot is never the last one's.
  dense.world.advance(1_000); store.appendTurn('owner', 'thread-x', `話${version}`, `返事${version}`, dense.world.now());
  let at = performance.now();
  recall.start(input);
  const start = performance.now() - at;
  at = performance.now();
  const packet = await recall.packet(input, { waitMilliseconds: 0 });
  return { start, packet: performance.now() - at, items: packet.items.length, sources: packet.sourceIds.length };
};
const profiling = process.env.PROFILE ? await startCpuProfile() : null;
for (const size of sizes) {
  while (episodes.length < size) write();
  const runs = [await once(), await once(), await once()];
  const median = (key: 'start' | 'packet') => runs.map(run => run[key]).sort((a, b) => a - b)[1]!.toFixed(0);
  console.log(`episodes=${size} start=${median('start')}ms packet=${median('packet')}ms items=${runs[0]!.items} sources=${runs[0]!.sources}`);
}
if (profiling) printProfile('recall', await profiling(), 40);
await dense.close();
process.exit(0);
