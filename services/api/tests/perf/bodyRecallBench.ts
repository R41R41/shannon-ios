/* The body-task recall bench (not a test): `node --import tsx tests/perf/bodyRecallBench.ts` from services/api. */
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from '../support/fcaDenseWorld.js';
import { SQLiteTaskExperiences } from '../../src/mind/memory/store/taskExperiences.js';
import { taskExperienceId } from '../../src/mind/memory/taskExperience.js';
import { createTaskMemory } from '../../src/mind/memory/taskMemoryPorts.js';
import { createBodyTaskRecall, createTaskRecall } from '../../src/mind/recall/taskRecallPorts.js';

/**
 * A decision's recall before and after the body recall of 2026-10-19, on the shape of `recallStallBench.ts` (production run 15: 226
 * body-task episodes of one goal, each recalling 150-175 of the others): the task recall's start and packet (what every decision ran),
 * then the body recall's first decision (the pool: three searches) and a later one (the situation's order and the read of what it shows).
 */
const GOAL = 'Minecraft でエンダードラゴンを討伐する。木を集めて道具を作り、夜に備え、鉄とダイヤを集める。';
const size = Number(process.env.EPISODES ?? 225);
const dense = fcaDenseWorld({ episodes: Number(process.env.OTHER_EPISODES ?? 50) });
const store = dense.world.store, writer = new SQLiteTaskExperiences(store.fcaDatabase());
const others = dense.ordinary.slice(100, 137);
const episodes: string[] = [];
while (episodes.length < size) {
  const index = episodes.length;
  dense.world.advance(60_000);
  const record = { scopeKey: 'owner', taskId: `body-task-${Math.floor(index / 8)}`, outcomeId: `segment-${index}`, observedAt: dense.world.now(),
    status: index % 3 ? 'success' as const : 'failure' as const, goal: GOAL, context: `文脈${index}`,
    action: index % 4 ? `{"name":"mc.mine-block","input":{"blockName":"iron_ore"}}` : `{"name":"mc.dig-shelter","input":{}}`, prediction: `予想${index}`,
    observedResult: index % 4 ? `鉄鉱石を${index % 5}個掘った` : `夜に縦穴に入った${index}`, interpretation: `解釈${index}`,
    sourceIds: [...others, ...episodes.slice(-175)], readSourceIds: dense.skillSources.slice(0, 25 + (index % 6)) };
  writer.write('owner', record);
  episodes.push(taskExperienceId('owner', record.taskId, record.outcomeId));
}
const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now: () => dense.world.now(),
  readSourceVisible: dense.readSourceVisible });
const recall = createTaskRecall({ state: store, conversations: store, memory, enrich: null, now: () => dense.world.now() });
const body = createBodyTaskRecall({ memory, state: store });
const cues = { words: ['鉄', 'iron', 'かまど'], tags: ['stage3'], urgent: ['夜', '縦穴'] };
let version = 0;
const decision = () => { dense.world.advance(1_000); store.appendTurn('owner', 'thread-x', `話${++version}`, `返事${version}`, dense.world.now()); };
const before = async () => {
  decision();
  const input = { scopeKey: 'owner', taskId: 'task-1', contextVersion: `v${version}`, cue: `${GOAL}\n木を集めた。`, present: OWNER_AUDIENCE, semantic: false };
  const at = performance.now();
  recall.start(input);
  const packet = await recall.packet(input, { waitMilliseconds: 0 });
  return { ms: performance.now() - at, items: packet.items.length, chars: JSON.stringify(packet.items).length, sources: packet.sourceIds.length };
};
const after = async () => {
  decision();
  const at = performance.now();
  const { packet, measure } = await body.packet({ scopeKey: 'owner', taskId: 'task-2', goal: GOAL, cues, present: OWNER_AUDIENCE });
  return { ms: performance.now() - at, items: packet.items.length, chars: measure.chars, sources: packet.sourceIds.length, pool: measure.poolMs !== null };
};
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const old = [await before(), await before(), await before()];
const first = await after();
const later = [await after(), await after(), await after(), await after(), await after()];
console.log(`episodes=${size} before: ${median(old.map(run => run.ms)).toFixed(0)}ms items=${old[0]!.items} itemChars=${old[0]!.chars} sources=${old[0]!.sources}`);
console.log(`after, first (pool): ${first.ms.toFixed(0)}ms items=${first.items} chars=${first.chars} sources=${first.sources}`);
console.log(`after, later: ${median(later.map(run => run.ms)).toFixed(1)}ms items=${later[0]!.items} chars=${later[0]!.chars} sources=${later[0]!.sources}`);
await dense.close();
process.exit(0);
