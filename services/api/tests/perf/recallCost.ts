/* Exploratory: what one step's deterministic recall costs on the production-dense world (not a test). */
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { fcaDenseWorld } from '../support/fcaDenseWorld.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';
import { createTaskMemory } from '../../src/mind/memory/taskMemoryPorts.js';
import { createTaskRecall } from '../../src/mind/recall/taskRecallPorts.js';

const world = fcaDenseWorld();
const threadCalls = new Map<string, number>();
{ const original = world.world.store.threadSummaryLineage.bind(world.world.store); (world.world.store as unknown as { threadSummaryLineage: unknown }).threadSummaryLineage = (scope: string, thread: string) => { threadCalls.set(thread, (threadCalls.get(thread) ?? 0) + 1); return original(scope, thread); }; }
const store = world.world.store, db = store.fcaDatabase();
db.exec('CREATE TABLE IF NOT EXISTS bench_touch(x INTEGER)');
const now = () => new Date().toISOString();
const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true, now, readSourceVisible: world.readSourceVisible });
const recall = createTaskRecall({ state: store, conversations: store, memory, enrich: null, now });
const times: number[] = [], ids: number[] = [], sources: number[] = [];
async function once(round: number) {
  db.prepare('INSERT INTO bench_touch(x) VALUES (?)').run(round);
  const input = { scopeKey: 'owner', taskId: 'bench-task', contextVersion: `v${round}`, cue: `質問について調べて、最新の様子をまとめる ${round}\n質問${round}について`, present: OWNER_AUDIENCE, semantic: false };
  const started = performance.now();
  const packet = await recall.packet(input);
  times.push(performance.now() - started); ids.push(packet.items.length); sources.push(packet.sourceIds.length);
}
for (let i = 0; i < 4; i++) await once(i);
const stop = process.env.PROFILE ? await startCpuProfile() : null;
times.length = 0;
for (let i = 4; i < 24; i++) await once(i);
times.sort((a, b) => a - b);
console.log(`recall packet: median ${times[10]!.toFixed(1)} ms min ${times[0]!.toFixed(1)} max ${times.at(-1)!.toFixed(1)}; items ${ids.at(-1)}, sourceIds ${sources.at(-1)}`);
console.log(`threadSummaryLineage: ${[...threadCalls.values()].reduce((a, b) => a + b, 0)} calls over ${threadCalls.size} threads in 24 recalls; max per thread ${Math.max(...threadCalls.values())}`);
if (stop) printProfile('recall', await stop(), 40);
await world.close();
